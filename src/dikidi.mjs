import { ALLOWED_MASTERS, COMPANY_ID, SERVICE_ID, normalizeSlots } from './core.mjs';

export class ScheduleError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'ScheduleError';
    this.retryable = retryable;
  }
}

const API = 'https://dikidi.net/ru/mobile/ajax/newrecord/get_datetimes/';
const MAX_DATES = 31;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(masterId, date, { fetchFn, sleep, timeoutMs }) {
  const url = new URL(API);
  url.searchParams.set('company_id', String(COMPANY_ID));
  url.searchParams.append('service_id[]', String(SERVICE_ID));
  url.searchParams.set('master_id', String(masterId));
  if (date) url.searchParams.set('date', date);
  else url.searchParams.set('with_first', '1');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        const error = new ScheduleError(`DIKIDI: HTTP ${res.status}${res.status === 403 ? ' Forbidden' : ''}`, RETRY_STATUS.has(res.status));
        const retryAfter = Number(res.headers.get('retry-after'));
        if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
          error.retryAfterMs = retryAfter * 1000;
          if (error.retryAfterMs > 30000) error.retryable = false; // соблюдаем долгий запрет
        }
        throw error;
      }
      if (!res.headers.get('content-type')?.includes('json')) throw new ScheduleError('DIKIDI: вместо JSON получена другая страница');
      let body;
      try { body = await res.json(); }
      catch { throw new ScheduleError('DIKIDI: некорректный JSON'); }
      if (!body || typeof body !== 'object' || !body.error || typeof body.error.code !== 'number') {
        throw new ScheduleError('DIKIDI: изменилась структура ответа');
      }
      if (body.error.code !== 0) throw new ScheduleError(`DIKIDI: API вернул ошибку ${body.error.code}`);
      const data = body.data;
      if (!data || String(data.company?.id) !== String(COMPANY_ID) || !Array.isArray(data.dates_true) ||
        !(Array.isArray(data.times) || (data.times && typeof data.times === 'object'))) {
        throw new ScheduleError('DIKIDI: не удалось определить расписание');
      }
      return data;
    } catch (error) {
      const normalized = error instanceof ScheduleError ? error : new ScheduleError(
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'DIKIDI: timeout' : 'DIKIDI: ошибка сети', true
      );
      if (!normalized.retryable || attempt === 2) throw normalized;
      await sleep(Math.max(attempt === 0 ? 1000 : 2500, normalized.retryAfterMs || 0));
    }
  }
}

function validDates(data) {
  if (data.dates_true.length > MAX_DATES || !data.dates_true.every(d => /^\d{4}-\d\d-\d\d$/.test(d))) {
    throw new ScheduleError(`DIKIDI: больше ${MAX_DATES} доступных дат или неверный формат дат`);
  }
  if (data.dates_true.length && !data.dates_true.includes(data.date_near)) {
    throw new ScheduleError('DIKIDI: дата ответа не совпадает со списком дат');
  }
  return [...new Set(data.dates_true)].sort();
}

function timesOf(data, masterId, expectedDate) {
  if (!data.dates_true.length) {
    if (Object.keys(data.times).length) throw new ScheduleError('DIKIDI: противоречивый пустой ответ');
    return [];
  }
  if (expectedDate && !data.dates_true.includes(expectedDate)) return []; // дата исчезла во время проверки
  if (expectedDate && data.date_near !== expectedDate) throw new ScheduleError('DIKIDI: ответ для другой даты');
  const times = data.times[String(masterId)];
  if (!Array.isArray(times)) throw new ScheduleError('DIKIDI: отсутствует время выбранного мастера');
  const normalized = normalizeSlots(times);
  if (!normalized.length) throw new ScheduleError('DIKIDI: дата доступна, но время не определено');
  if (normalized.some(slot => slot.slice(0, 10) !== data.date_near)) {
    throw new ScheduleError('DIKIDI: время привязано к другой дате');
  }
  return normalized;
}

export async function checkSchedule(masterId, options = {}) {
  if (!ALLOWED_MASTERS.includes(Number(masterId))) throw new ScheduleError('Неизвестный ID инструктора');
  const deps = { fetchFn: options.fetchFn || fetch, sleep: options.sleep || wait, timeoutMs: options.timeoutMs || 12000 };
  const first = await request(masterId, null, deps);
  const dates = validDates(first);
  const slots = timesOf(first, masterId);
  options.log?.(`Found ${dates.length} dates`);
  for (const date of dates) {
    if (date === first.date_near) continue;
    await deps.sleep(350); // ограничиваем частоту запросов при нескольких датах
    const day = await request(masterId, date, deps);
    validDates(day);
    slots.push(...timesOf(day, masterId, date));
  }
  const result = normalizeSlots(slots);
  options.log?.(`Found ${result.length} available slots`);
  return { slots: result, datesCount: dates.length };
}
