import { bookingUrl, dateTimeOfSlot, localTime, masterLabel } from './core.mjs';

export function notificationText(item) {
  const who = `Инструктор: ${masterLabel(item.master_id)}`;
  const when = `Время проверки: ${localTime(item.checked_at)} (Екб)`;
  const shown = (item.slots || []).slice(0, 90);
  const remainder = (item.slots || []).length - shown.length;
  const slots = shown.map(s => `• ${dateTimeOfSlot(s)}`).join('\n') +
    (remainder ? `\n…и ещё ${remainder} окон (все есть на сайте и в DIKIDI)` : '');
  const link = `Открыть DIKIDI:\n${bookingUrl(item.master_id)}`;
  switch (item.kind) {
    case 'new': return `🚗 Появилась новая запись!\n${who}\n\n${slots}\n\n${link}`;
    case 'removed': return `➖ Запись исчезла\n${who}\n\n${slots}\n\n${link}`;
    case 'all': return `✅ Проверка выполнена\n${who}\n${when}\nСвободных записей: ${item.slot_count}\n${slots || 'Окон пока нет'}\nСледующая плановая проверка: ${item.next_due_at ? localTime(item.next_due_at) + ' (Екб)' : 'выключена'}\n\n${link}`;
    case 'empty': return `📭 Свободных записей нет\n${who}\n${when}\n\n${link}`;
    case 'error': return `⚠️ Ошибка проверки DIKIDI\n${who}\n${when}\nОшибка: ${item.error || 'неизвестная ошибка'}\nНе удалось получить расписание. Это не означает, что мест нет.\n\n${link}`;
    default: throw new Error('Неизвестный тип уведомления');
  }
}

export async function sendTelegram(token, chatId, message, fetchFn = fetch) {
  if (!token || !chatId) throw new Error('Не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  let response;
  try {
    response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    // Не добавлять в исключение URL: он содержит токен бота.
    throw new Error('Telegram: ошибка сети или timeout');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Telegram: HTTP ${response.status}, неверный ответ`); }
  if (!response.ok || data.ok !== true) throw new Error(`Telegram: HTTP ${response.status}, ${String(data.description || 'ошибка API').slice(0, 150)}`);
  return data.result;
}
