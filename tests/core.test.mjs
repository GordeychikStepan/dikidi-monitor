import test from 'node:test';
import assert from 'node:assert/strict';
import { slotDiff, normalizeSlots, bookingUrl, masterLabel } from '../src/core.mjs';

const a = '2026-09-26 14:00:00';
const b = '2026-09-26 16:00:00';
test('оповещение только о новом времени', () => {
  assert.deepEqual(slotDiff([a], [a, b]), { added: [b], removed: [] });
  assert.deepEqual(slotDiff([a, b], [b]), { added: [], removed: [a] });
  assert.deepEqual(slotDiff([a, b], [a, b]), { added: [], removed: [] });
});
test('возвращение слота после исчезновения снова считается новым', () => {
  assert.deepEqual(slotDiff([a], []).removed, [a]);
  assert.deepEqual(slotDiff([], [a]).added, [a]);
});
test('слоты сортируются и повторения удаляются', () => {
  assert.deepEqual(normalizeSlots([b, a, b]), [a, b]);
  assert.throws(() => normalizeSlots(['2026-02-30 16:00:00']));
});
test('тестовая ссылка и уведомление явно содержат ID тестового мастера', () => {
  assert.equal(new URL(bookingUrl(4145151)).searchParams.get('m'), '4145151');
  assert.equal(new URL(bookingUrl(4145159)).searchParams.get('s'), '22479921');
  assert.match(masterLabel(4145151), /тестовый/);
});
