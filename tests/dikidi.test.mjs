import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchedule, ScheduleError } from '../src/dikidi.mjs';

const ok = (data, status = 200) => new Response(JSON.stringify({ error: { code: 0 }, data }), {
  status, headers: { 'content-type': 'application/json' }
});
const data = (master, dates, date, times) => ({
  company: { id: '1926065' }, dates_true: dates, date_near: date, times: dates.length ? { [master]: times } : []
});
test('собирает все даты, а не только первый открытый день', async () => {
  const calls = [];
  const fetchFn = async url => {
    const params = new URL(url).searchParams;
    calls.push(params);
    assert.equal(params.get('service_id[]'), '22479921');
    if (params.get('date') === '2026-09-25') return ok(data(4145151, ['2026-09-25'], '2026-09-25', ['2026-09-25 16:30:00']));
    return ok(data(4145151, ['2026-09-24', '2026-09-25'], '2026-09-24', [
      '2026-09-24 09:00:00', '2026-09-24 10:30:00'
    ]));
  };
  const result = await checkSchedule(4145151, { fetchFn, sleep: async () => {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.slots, [
    '2026-09-24 09:00:00', '2026-09-24 10:30:00', '2026-09-25 16:30:00'
  ]);
});
test('пустой подтверждённый ответ считается успешным', async () => {
  const result = await checkSchedule(4145159, { fetchFn: async () => ok(data(4145159, [], [], [])) });
  assert.deepEqual(result, { slots: [], datesCount: 0 });
});
test('HTTP 403 и изменение структуры являются ошибкой, а не нулём слотов', async () => {
  await assert.rejects(checkSchedule(4145159, { fetchFn: async () => new Response('Forbidden', { status: 403 }) }),
    error => error instanceof ScheduleError && /403/.test(error.message));
  await assert.rejects(checkSchedule(4145159, { fetchFn: async () => ok({ dates_true: [] }) }),
    /не удалось определить расписание/);
});
test('429 повторяется ограниченное число раз', async () => {
  let tries = 0;
  const result = await checkSchedule(4145159, {
    fetchFn: async () => ++tries < 3 ? new Response('', { status: 429 }) : ok(data(4145159, [], [], [])),
    sleep: async () => {}
  });
  assert.equal(tries, 3); assert.deepEqual(result.slots, []);
});
test('неизвестное время другого мастера не принимается', async () => {
  await assert.rejects(checkSchedule(4145159, {
    fetchFn: async () => ok(data(4145151, ['2026-09-25'], '2026-09-25', ['2026-09-25 16:30:00']))
  }), /отсутствует время выбранного мастера/);
});
