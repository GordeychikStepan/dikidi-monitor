import { checkSchedule } from './dikidi.mjs';
import { Store } from './store.mjs';
import { masterLabel } from './core.mjs';
import { notificationText, sendTelegram } from './telegram.mjs';

function log(message) {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
  console.log(`[${time}] ${message}`);
}

async function deliverPending(store) {
  const pending = await store.pending();
  let failures = 0;
  for (const item of pending) {
    try {
      await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, notificationText(item));
      await store.markDelivery(item.id, null);
      log(`Telegram notification sent (${item.kind}, ${masterLabel(item.master_id)})`);
    } catch (error) {
      failures++;
      const reason = String(error.message).slice(0, 250);
      await store.markDelivery(item.id, reason);
      log(`Telegram delivery failed: ${reason}`);
      break; // не дублировать серию ошибок за один запуск
    }
  }
  if (failures) process.exitCode = 1;
}

async function main() {
  const store = new Store(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  if (process.env.CHECK_MODE === 'telegram_test') {
    log('Sending test Telegram notification');
    try {
      await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID,
        '✅ Тест Telegram: бот настроен, связь работает. Это НЕ результат проверки DIKIDI.');
      await store.recordTest(null);
      log('Test Telegram notification sent');
    } catch (error) {
      await store.recordTest(String(error.message).slice(0, 250));
      throw error;
    }
    return;
  }

  log('Starting DIKIDI check');
  const force = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const started = await store.begin(force);
  if (!started?.run) {
    log(`Check skipped: ${started?.reason || 'unknown'}`);
    await deliverPending(store);
    return;
  }
  const masterId = Number(started.master_id);
  log(`Target: ${masterLabel(masterId)}; service: 22479921`);
  const startTime = Date.now();
  let slots = null;
  let checkError = null;
  try {
    ({ slots } = await checkSchedule(masterId, { log }));
  } catch (error) {
    checkError = String(error.message || 'неизвестная ошибка').slice(0, 450);
    log(`DIKIDI check failed: ${checkError}`);
  }
  const result = await store.complete(started.lease, masterId, slots, checkError, Date.now() - startTime);
  if (result?.discarded) {
    log('Target changed during the check; result discarded');
  } else {
    log(`New slots: ${result.new_count}; removed: ${result.removed_count}`);
    log(`Check completed: ${result.status}; available slots: ${result.slot_count}`);
  }
  await deliverPending(store);
  if (checkError) process.exitCode = 1; // в Actions видна ошибка, в БД сохранена отдельно
}

main().catch(error => {
  console.error(`Monitor failed: ${String(error.message || error).slice(0, 400)}`);
  process.exitCode = 1;
});
