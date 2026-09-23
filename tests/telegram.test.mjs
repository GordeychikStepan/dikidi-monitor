import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationText, sendTelegram } from '../src/telegram.mjs';

const event = { master_id: 4145151, kind: 'new', checked_at: '2026-09-23T10:30:00Z', slots: ['2026-09-25 16:30:00'] };
test('тестовый мастер указан и в сообщении, и в ссылке', () => {
  const text = notificationText(event);
  assert.match(text, /тестовый \(4145151\)/);
  assert.match(text, /25\.09\.2026 16:30/);
  assert.match(text, /m=4145151/);
});
test('ошибка явно не выдаётся за отсутствие окон', () => {
  const text = notificationText({ ...event, kind: 'error', error: 'DIKIDI: HTTP 403 Forbidden' });
  assert.match(text, /403 Forbidden/);
  assert.match(text, /не означает, что мест нет/);
});
test('Bot API отправляет POST и проверяет флаг ok', async () => {
  let body;
  const result = await sendTelegram('123:TEST', '777', 'Привет', async (url, options) => {
    assert.match(url, /sendMessage$/);
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
  assert.equal(body.chat_id, '777'); assert.equal(body.text, 'Привет');
  assert.equal(result.message_id, 1);
  await assert.rejects(sendTelegram('123:TEST', '777', 'Привет', async () =>
    new Response(JSON.stringify({ ok: false, description: 'Forbidden' }), { status: 403 })), /Telegram: HTTP 403/);
});
