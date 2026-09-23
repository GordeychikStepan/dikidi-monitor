import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, GITHUB_REPO } from './config.js';

const $ = id => document.getElementById(id);
const serverUrl = SUPABASE_URL.replace(/\/+$/, '');
const sessionKey = 'dikidi-monitor-session';
const primary = 4145159;
const test = 4145151;
let session = null;
let refreshPromise = null;
let settings = null;

function configured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(serverUrl) &&
    SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_') &&
    !SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME');
}
function setSession(next) {
  session = next;
  if (next) localStorage.setItem(sessionKey, JSON.stringify(next));
  else localStorage.removeItem(sessionKey);
}
function showLogin(message = '') {
  $('dashboard').hidden = true;
  $('bottomNav').hidden = true;
  $('signOut').hidden = true;
  $('loginScreen').hidden = false;
  $('loginError').textContent = message;
  $('loginError').hidden = !message;
}
function showDashboard() {
  $('loginScreen').hidden = true;
  $('dashboard').hidden = false;
  $('bottomNav').hidden = false;
  $('signOut').hidden = false;
}
function showError(error) {
  $('globalError').textContent = error;
  $('globalError').hidden = !error;
}

async function authRequest(path, body) {
  const response = await fetch(`${serverUrl}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.msg || result.error_description || result.message || `Вход: HTTP ${response.status}`);
  return result;
}
async function accessToken() {
  if (!session) throw new Error('Сессия закончилась. Войдите снова.');
  if (session.expires_at && session.expires_at * 1000 > Date.now() + 60000) return session.access_token;
  if (!refreshPromise) {
    refreshPromise = authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(next => { setSession(next); return next.access_token; })
      .catch(error => { setSession(null); showLogin('Сессия истекла. Войдите ещё раз.'); throw error; })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
async function database(path, method = 'GET', data) {
  const token = await accessToken();
  const response = await fetch(`${serverUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`,
      Accept: 'application/json', 'Content-Type': 'application/json',
      ...(method === 'PATCH' ? { Prefer: 'return=minimal' } : {})
    },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000)
  });
  if (response.status === 401) { setSession(null); showLogin('Сессия истекла. Войдите ещё раз.'); }
  if (!response.ok) throw new Error(`Ошибка Supabase: HTTP ${response.status}. Проверьте подключение и политики RLS.`);
  return method === 'PATCH' ? null : response.json();
}

const fmt = (value, opts = {}) => value ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Yekaterinburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...opts
}).format(new Date(value)) : '—';
const who = id => Number(id) === test ? 'Тестовый · 4145151' : 'Основной · 4145159';
const make = (tag, cls, content = '') => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = content;
  return el;
};
function bookingUrl(master) {
  const link = new URL('https://dikidi.net/ru/record/1926065');
  for (const [key, value] of Object.entries({
    p: '4.pi-po-sm-ssm-sd', o: '1', m: String(master), s: '22479921', rl: '0_undefined',
    source: 'direct_link', backurl: 'https://dikidi.net/ru/profile/avtoshkola_azimut_1926065'
  })) link.searchParams.set(key, value);
  return link.toString();
}
function githubUrl() {
  return /^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO) && !GITHUB_REPO.includes('YOUR_USERNAME')
    ? `https://github.com/${GITHUB_REPO}/actions/workflows/check.yml` : '';
}

async function loadDashboard() {
  showError('');
  try {
    const rows = await database('app_settings?select=*&id=eq.1');
    if (rows.length !== 1) throw new Error('Настройки не найдены. Проверьте создание пользователя и запуск db/schema.sql.');
    settings = rows[0];
    const owner = encodeURIComponent(settings.owner_id);
    const [snapshotRows, checks, events, pending] = await Promise.all([
      database(`snapshots?select=*&owner_id=eq.${owner}&master_id=eq.${settings.target_master_id}`),
      database(`check_history?select=*&owner_id=eq.${owner}&order=id.desc&limit=100`),
      database(`slot_events?select=*&owner_id=eq.${owner}&order=id.desc&limit=100`),
      database(`notification_outbox?select=id&owner_id=eq.${owner}&sent_at=is.null&limit=100`)
    ]);
    render(settings, snapshotRows[0], checks, events, pending.length);
    showDashboard();
  } catch (error) {
    showError(error.message || 'Не удалось обновить панель.');
    if (!settings) showLogin(error.message || 'Проверьте конфигурацию.');
  }
}

function render(s, snapshot, checks, events, pendingCount) {
  const latest = checks.find(item => Number(item.master_id) === Number(s.target_master_id));
  const current = latest && new Date(latest.checked_at) >= new Date(s.target_changed_at) ? latest : null;
  const outdated = current && (Date.now() - new Date(current.checked_at).getTime()) > Math.max(s.interval_minutes * 3, 30) * 60000;
  let status = 'Работает';
  let detail = 'Последняя проверка прошла успешно. Свободное время обновляется по расписанию.';
  let dot = '';
  if (!s.enabled) { status = 'Выключен'; detail = 'Плановые проверки остановлены в настройках.'; dot = 'off'; }
  else if (!current) { status = 'Ожидает проверки'; detail = 'Запустите первую проверку через GitHub Actions.'; dot = 'off'; }
  else if (current.status === 'error') { status = 'Ошибка'; detail = current.error || 'DIKIDI не вернул расписание.'; dot = 'bad'; }
  else if (outdated) { status = 'Ошибка'; detail = 'Проверки задерживаются. Посмотрите последний запуск в GitHub Actions.'; dot = 'bad'; }
  else if (current.status === 'empty') detail = 'Проверка успешна. У выбранного инструктора пока нет свободного времени.';
  else detail = `Доступно ${current.slots.length} окон. Проверьте их в DIKIDI перед записью.`;
  $('statusText').textContent = status;
  $('statusDetail').textContent = detail;
  $('statusDot').className = `pulse-dot ${dot}`;
  $('lastChecked').textContent = current ? fmt(current.checked_at) : '—';
  $('nextCheck').textContent = s.enabled ? fmt(s.next_due_at) + ' *' : 'Выключена';
  $('slotCount').textContent = current && current.status !== 'error' ? current.slots.length : '—';
  $('slotCountNote').textContent = current?.status === 'error' ? 'Ошибка, количество неизвестно' : 'Последний результат';
  $('lastNew').textContent = snapshot?.last_new_at ? fmt(snapshot.last_new_at, { year: undefined }) : '—';
  $('targetName').textContent = who(s.target_master_id);
  $('targetPill').textContent = Number(s.target_master_id) === test ? 'ТЕСТОВЫЙ' : 'ОСНОВНОЙ';
  $('targetPill').className = `pill ${Number(s.target_master_id) === test ? 'test' : ''}`;
  $('bookingLink').href = bookingUrl(s.target_master_id);
  const action = githubUrl();
  $('checkNow').href = action || '#';
  $('actionsLink').href = action || '#';
  if (!action) showError('Укажите GITHUB_REPO в js/config.js, чтобы работала кнопка ручного запуска.');
  renderSlots(current, snapshot);
  const result = $('lastResult');
  result.className = `result-box ${current?.status === 'error' ? 'error' : ''}`;
  result.textContent = !current ? 'У выбранного инструктора ещё нет проверки после переключения.'
    : current.status === 'error' ? `Ошибка: ${current.error}. Предыдущее успешное расписание сохранено.`
    : current.status === 'empty' ? `Свободных окон нет. Запрос занял ${current.duration_ms} мс.`
    : `Найдено ${current.slots.length} окон. Новых: ${current.added.length}; исчезло: ${current.removed.length}. Запрос занял ${current.duration_ms} мс.`;
  const telegramStatus = s.last_telegram_error ? `Ошибка: ${s.last_telegram_error}` : s.last_telegram_at ? `Отправлено ${fmt(s.last_telegram_at)}` : 'Ещё не проверено';
  $('telegramState').textContent = telegramStatus;
  $('telegramState2').textContent = telegramStatus;
  $('pendingCount').textContent = pendingCount >= 100 ? '100+' : String(pendingCount);
  $('systemError').textContent = s.last_status === 'error' ? (s.last_error || 'Ошибка') : 'Нет';
  $('systemTarget').textContent = who(s.target_master_id);
  $('enabled').checked = s.enabled;
  $('interval').value = String(s.interval_minutes);
  $('master').value = String(s.target_master_id);
  $('notificationMode').value = s.notification_mode;
  $('notifyErrors').checked = s.notify_errors;
  $('notifyDisappeared').checked = s.notify_disappeared;
  renderHistory(checks, events);
}

function renderSlots(current, snapshot) {
  const root = $('slots'); root.replaceChildren();
  const slots = current?.status !== 'error' && current ? current.slots : snapshot?.slots || [];
  if (!slots.length) {
    root.append(make('p', 'empty-text', current?.status === 'error'
      ? 'Расписание неизвестно: последняя проверка завершилась ошибкой.'
      : current ? 'Свободных окон пока нет.' : 'Ожидаем первой проверки.'));
    return;
  }
  if (current?.status === 'error' || !current) root.append(make('p', 'empty-text', 'Последний сохранённый результат. Актуальность не подтверждена.'));
  const groups = new Map();
  for (const slot of slots) {
    const day = slot.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(slot.slice(11, 16));
  }
  for (const [day, times] of groups) {
    const row = make('div', 'day-row');
    row.append(make('strong', '', fmt(day + 'T12:00:00Z', { timeZone: 'UTC', hour: undefined, minute: undefined, weekday: 'long' })));
    const chips = make('div', 'day-times');
    for (const time of times) chips.append(make('span', 'time-chip', time));
    row.append(chips); root.append(row);
  }
}

function renderHistory(checks, events) {
  const list = $('checksList'); list.replaceChildren();
  if (!checks.length) list.append(make('p', 'empty-text', 'Проверок ещё не было.'));
  for (const item of checks) {
    const row = make('div', `timeline-item ${item.status === 'error' ? 'error' : ''}`);
    row.append(make('div', 'timeline-icon', item.status === 'error' ? '!' : item.status === 'available' ? '+' : '✓'));
    const body = make('div');
    body.append(make('strong', '', `${item.status === 'error' ? 'Ошибка проверки' : item.status === 'empty' ? 'Окон нет' : `Найдено ${item.slots.length} окон`} · ${who(item.master_id)}`));
    body.append(make('small', '', `${fmt(item.checked_at)} · ${item.duration_ms} мс`));
    const detail = item.status === 'error' ? item.error : (item.slots || []).map(s => s.slice(0, 10).split('-').reverse().join('.') + ' ' + s.slice(11, 16)).join(' · ');
    if (detail) body.append(make('p', '', detail));
    row.append(body); list.append(row);
  }
  const changes = $('eventsList'); changes.replaceChildren();
  if (!events.length) changes.append(make('p', 'empty-text', 'Изменений пока нет.'));
  for (const event of events) {
    const row = make('div', `timeline-item ${event.kind}`);
    row.append(make('div', 'timeline-icon', event.kind === 'added' ? '+' : '−'));
    const body = make('div');
    body.append(make('strong', '', event.kind === 'added' ? 'Запись появилась' : 'Запись исчезла'));
    body.append(make('small', '', `${fmt(event.event_at)} · ${who(event.master_id)}`));
    body.append(make('p', '', event.slot.slice(0, 10).split('-').reverse().join('.') + ' · ' + event.slot.slice(11, 16)));
    row.append(body); changes.append(row);
  }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').hidden = true;
  try {
    if (!configured()) throw new Error('Сначала замените SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY в js/config.js.');
    setSession(await authRequest('token?grant_type=password', { email: $('email').value.trim(), password: $('password').value }));
    $('password').value = '';
    await loadDashboard();
  } catch (error) {
    $('loginError').textContent = error.message || 'Ошибка входа'; $('loginError').hidden = false;
  }
});
$('signOut').addEventListener('click', () => { setSession(null); settings = null; showLogin(); });
$('refreshButton').addEventListener('click', loadDashboard);
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const target = Number($('master').value);
  if (target === test && Number(settings.target_master_id) !== test &&
      !window.confirm('Переключить мониторинг на ТЕСТОВОГО инструктора 4145151? В Telegram будут приходить сообщения только с явной пометкой «тестовый». После теста вернитесь на 4145159.')) return;
  $('saveMessage').textContent = 'Сохраняем…';
  try {
    await database('app_settings?id=eq.1', 'PATCH', {
      enabled: $('enabled').checked, interval_minutes: Number($('interval').value),
      target_master_id: target, notification_mode: $('notificationMode').value,
      notify_errors: $('notifyErrors').checked, notify_disappeared: $('notifyDisappeared').checked
    });
    $('saveMessage').textContent = 'Сохранено. Следующий запуск возьмёт новые настройки.';
    await loadDashboard();
  } catch (error) { $('saveMessage').textContent = error.message || 'Не удалось сохранить.'; }
});
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('is-active', page.id === button.dataset.page));
  document.querySelectorAll('[data-page]').forEach(tab => tab.classList.toggle('active', tab === button));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));
const savedTheme = localStorage.getItem('dikidi-theme');
document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('dikidi-theme', next);
});
try {
  session = JSON.parse(localStorage.getItem(sessionKey) || 'null');
  if (!configured()) showLogin('Перед входом укажите адрес и публичный ключ Supabase в js/config.js.');
  else if (session) loadDashboard();
  else showLogin();
} catch { setSession(null); showLogin(); }
