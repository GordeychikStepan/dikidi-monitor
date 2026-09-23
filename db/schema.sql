-- Запускайте в новом отдельном проекте Supabase после создания ОДНОГО пользователя Auth.
-- Повторный запуск безопасен; существующие настройки и история не удаляются.
create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  owner_id uuid not null references auth.users(id),
  enabled boolean not null default true,
  interval_minutes smallint not null default 10 check (interval_minutes in (5,10,15,30,60)),
  target_master_id bigint not null default 4145159 check (target_master_id in (4145159,4145151)),
  notification_mode text not null default 'new' check (notification_mode in ('new','all','empty')),
  notify_errors boolean not null default true,
  notify_disappeared boolean not null default false,
  updated_at timestamptz not null default now(),
  target_changed_at timestamptz not null default now(),
  last_started_at timestamptz,
  last_checked_at timestamptz,
  last_status text not null default 'waiting' check (last_status in ('waiting','available','empty','error')),
  last_error text,
  next_due_at timestamptz default now(),
  last_telegram_at timestamptz,
  last_telegram_error text,
  lease_token uuid,
  lease_until timestamptz
);

create table if not exists public.snapshots (
  owner_id uuid not null references auth.users(id),
  master_id bigint not null check (master_id in (4145159,4145151)),
  slots text[] not null default '{}',
  last_success_at timestamptz,
  last_new_at timestamptz,
  primary key (owner_id, master_id)
);

create table if not exists public.check_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id),
  master_id bigint not null,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('available','empty','error')),
  slots text[],
  added text[] not null default '{}',
  removed text[] not null default '{}',
  error text,
  duration_ms integer not null default 0 check (duration_ms >= 0)
);
create index if not exists check_history_recent on public.check_history(owner_id, id desc);

create table if not exists public.slot_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id),
  master_id bigint not null,
  event_at timestamptz not null default now(),
  kind text not null check (kind in ('added','removed')),
  slot text not null
);
create index if not exists slot_events_recent on public.slot_events(owner_id, id desc);

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id),
  check_id bigint not null,
  master_id bigint not null,
  kind text not null check (kind in ('new','all','empty','error','removed')),
  checked_at timestamptz not null,
  slots text[] not null default '{}',
  slot_count integer not null default 0,
  next_due_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  unique(check_id,kind)
);
create index if not exists outbox_pending on public.notification_outbox(sent_at, id);

alter table public.app_settings enable row level security;
alter table public.snapshots enable row level security;
alter table public.check_history enable row level security;
alter table public.slot_events enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on public.app_settings, public.snapshots, public.check_history,
  public.slot_events, public.notification_outbox from anon, authenticated;
grant select on public.app_settings, public.snapshots, public.check_history,
  public.slot_events, public.notification_outbox to authenticated;
grant all on public.app_settings, public.snapshots, public.check_history,
  public.slot_events, public.notification_outbox to service_role;
grant usage, select on all sequences in schema public to service_role;
grant update (enabled, interval_minutes, target_master_id, notification_mode,
  notify_errors, notify_disappeared) on public.app_settings to authenticated;

drop policy if exists settings_owner_read on public.app_settings;
create policy settings_owner_read on public.app_settings for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists settings_owner_update on public.app_settings;
create policy settings_owner_update on public.app_settings for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists snapshots_owner_read on public.snapshots;
create policy snapshots_owner_read on public.snapshots for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists history_owner_read on public.check_history;
create policy history_owner_read on public.check_history for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists events_owner_read on public.slot_events;
create policy events_owner_read on public.slot_events for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists outbox_owner_read on public.notification_outbox;
create policy outbox_owner_read on public.notification_outbox for select to authenticated
  using ((select auth.uid()) = owner_id);

create or replace function public.touch_settings()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  if new.target_master_id is distinct from old.target_master_id then
    new.target_changed_at := now();
  end if;
  if new.enabled is distinct from old.enabled or
     new.target_master_id is distinct from old.target_master_id or
     new.interval_minutes is distinct from old.interval_minutes then
    new.next_due_at := case when new.enabled then now() else null end;
  end if;
  return new;
end $$;
drop trigger if exists settings_touch on public.app_settings;
create trigger settings_touch before update on public.app_settings
  for each row execute function public.touch_settings();

create or replace function public.begin_check(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.app_settings%rowtype;
  token uuid;
begin
  select * into s from public.app_settings where id=1 for update;
  if not found then raise exception 'Настройки не созданы: выполните schema.sql'; end if;
  if not s.enabled and not p_force then return jsonb_build_object('run',false,'reason','disabled'); end if;
  if s.lease_until is not null and s.lease_until > now() then
    return jsonb_build_object('run',false,'reason','busy');
  end if;
  if not p_force and s.next_due_at is not null and s.next_due_at > now() then
    return jsonb_build_object('run',false,'reason','not_due','next_due_at',s.next_due_at);
  end if;
  token := gen_random_uuid();
  update public.app_settings set lease_token=token, lease_until=now()+interval '12 minutes',
    last_started_at=now() where id=1;
  return jsonb_build_object('run',true,'lease',token,'master_id',s.target_master_id);
end $$;

create or replace function public.complete_check(
  p_lease uuid, p_master_id bigint, p_slots text[], p_error text, p_duration_ms integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.app_settings%rowtype;
  old_slots text[] := '{}';
  new_slots text[] := '{}';
  removed_slots text[] := '{}';
  ordered_slots text[] := '{}';
  v_status text;
  v_time timestamptz := now();
  v_next timestamptz;
  v_check_id bigint;
  v_slot text;
begin
  select * into s from public.app_settings where id=1 for update;
  if not found or s.lease_token is distinct from p_lease then
    raise exception 'Проверка устарела или уже завершена';
  end if;
  if s.target_master_id <> p_master_id then
    update public.app_settings set lease_token=null, lease_until=null,
      next_due_at=case when enabled then now() else null end where id=1;
    return jsonb_build_object('discarded',true,'reason','Инструктор переключён во время проверки');
  end if;
  if p_error is null and p_slots is null then raise exception 'Нет результата проверки'; end if;
  if p_error is null then
    select coalesce(array_agg(distinct item order by item),'{}'::text[]) into ordered_slots
      from unnest(p_slots) item;
    select coalesce(slots,'{}'::text[]) into old_slots from public.snapshots
      where owner_id=s.owner_id and master_id=p_master_id for update;
    old_slots := coalesce(old_slots,'{}'::text[]);
    select coalesce(array_agg(item order by item),'{}'::text[]) into new_slots
      from unnest(ordered_slots) item where not (item = any(old_slots));
    select coalesce(array_agg(item order by item),'{}'::text[]) into removed_slots
      from unnest(old_slots) item where not (item = any(ordered_slots));
    v_status := case when cardinality(ordered_slots)>0 then 'available' else 'empty' end;
    insert into public.snapshots(owner_id,master_id,slots,last_success_at,last_new_at)
      values(s.owner_id,p_master_id,ordered_slots,v_time,
        case when cardinality(new_slots)>0 then v_time else null end)
      on conflict (owner_id,master_id) do update set slots=excluded.slots,
        last_success_at=excluded.last_success_at,
        last_new_at=coalesce(excluded.last_new_at,snapshots.last_new_at);
  else
    v_status := 'error';
  end if;

  v_next := case when s.enabled then v_time + make_interval(mins => s.interval_minutes) else null end;
  insert into public.check_history(owner_id,master_id,checked_at,status,slots,added,removed,error,duration_ms)
    values(s.owner_id,p_master_id,v_time,v_status,
      case when p_error is null then ordered_slots else null end,
      new_slots,removed_slots,left(p_error,500),greatest(0,p_duration_ms)) returning id into v_check_id;
  if p_error is null then
    foreach v_slot in array new_slots loop
      insert into public.slot_events(owner_id,master_id,event_at,kind,slot)
        values(s.owner_id,p_master_id,v_time,'added',v_slot);
    end loop;
    foreach v_slot in array removed_slots loop
      insert into public.slot_events(owner_id,master_id,event_at,kind,slot)
        values(s.owner_id,p_master_id,v_time,'removed',v_slot);
    end loop;
  end if;

  update public.app_settings set last_checked_at=v_time,last_status=v_status,
    last_error=left(p_error,500),next_due_at=v_next,lease_token=null,lease_until=null
    where id=1;

  if p_error is not null and s.notify_errors then
    insert into public.notification_outbox(owner_id,check_id,master_id,kind,checked_at,error,next_due_at)
      values(s.owner_id,v_check_id,p_master_id,'error',v_time,left(p_error,500),v_next);
  elsif p_error is null then
    if (s.notification_mode='new' and cardinality(new_slots)>0) then
      insert into public.notification_outbox(owner_id,check_id,master_id,kind,checked_at,slots,slot_count,next_due_at)
        values(s.owner_id,v_check_id,p_master_id,'new',v_time,new_slots,cardinality(ordered_slots),v_next);
    elsif s.notification_mode='all' then
      insert into public.notification_outbox(owner_id,check_id,master_id,kind,checked_at,slots,slot_count,next_due_at)
        values(s.owner_id,v_check_id,p_master_id,'all',v_time,ordered_slots,cardinality(ordered_slots),v_next);
    elsif s.notification_mode='empty' and cardinality(ordered_slots)=0 then
      insert into public.notification_outbox(owner_id,check_id,master_id,kind,checked_at,slot_count,next_due_at)
        values(s.owner_id,v_check_id,p_master_id,'empty',v_time,0,v_next);
    end if;
    if s.notify_disappeared and cardinality(removed_slots)>0 then
      insert into public.notification_outbox(owner_id,check_id,master_id,kind,checked_at,slots,slot_count,next_due_at)
        values(s.owner_id,v_check_id,p_master_id,'removed',v_time,removed_slots,cardinality(ordered_slots),v_next);
    end if;
  end if;

  delete from public.check_history where owner_id=s.owner_id and id not in
    (select id from public.check_history where owner_id=s.owner_id order by id desc limit 100);
  delete from public.slot_events where owner_id=s.owner_id and id not in
    (select id from public.slot_events where owner_id=s.owner_id order by id desc limit 500);
  delete from public.notification_outbox where sent_at < now()-interval '30 days';
  return jsonb_build_object('status',v_status,'slot_count',cardinality(ordered_slots),
    'new_count',cardinality(new_slots),'removed_count',cardinality(removed_slots),
    'checked_at',v_time,'next_due_at',v_next);
end $$;

create or replace function public.mark_delivery(p_id bigint,p_error text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.notification_outbox set attempt_count=attempt_count+1,
    sent_at=case when p_error is null then now() else sent_at end,
    last_error=left(p_error,300) where id=p_id and sent_at is null;
  if found then
    update public.app_settings set last_telegram_at=case when p_error is null then now() else last_telegram_at end,
      last_telegram_error=left(p_error,300) where id=1;
  end if;
end $$;

revoke all on function public.begin_check(boolean) from public,anon,authenticated;
revoke all on function public.complete_check(uuid,bigint,text[],text,integer) from public,anon,authenticated;
revoke all on function public.mark_delivery(bigint,text) from public,anon,authenticated;
grant execute on function public.begin_check(boolean) to service_role;
grant execute on function public.complete_check(uuid,bigint,text[],text,integer) to service_role;
grant execute on function public.mark_delivery(bigint,text) to service_role;

do $$ begin
  if (select count(*) from auth.users) <> 1 then
    raise exception 'Создайте ровно одного пользователя в Authentication > Users и используйте новый проект';
  end if;
end $$;
insert into public.app_settings(owner_id)
  select id from auth.users limit 1 on conflict (id) do nothing;

-- Проверка после выполнения: должна быть ровно одна строка.
select id,enabled,interval_minutes,target_master_id,notification_mode from public.app_settings;
