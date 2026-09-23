export const PRIMARY_MASTER_ID = 4145159;
export const TEST_MASTER_ID = 4145151;
export const SERVICE_ID = 22479921;
export const COMPANY_ID = 1926065;
export const ALLOWED_MASTERS = [PRIMARY_MASTER_ID, TEST_MASTER_ID];

export function masterLabel(id) {
  return Number(id) === TEST_MASTER_ID ? 'тестовый (4145151)' : 'основной (4145159)';
}

export function bookingUrl(masterId) {
  if (!ALLOWED_MASTERS.includes(Number(masterId))) throw new Error('Неизвестный мастер');
  const url = new URL(`https://dikidi.net/ru/record/${COMPANY_ID}`);
  url.searchParams.set('p', '4.pi-po-sm-ssm-sd');
  url.searchParams.set('o', '1');
  url.searchParams.set('m', String(masterId));
  url.searchParams.set('s', String(SERVICE_ID));
  url.searchParams.set('rl', '0_undefined');
  url.searchParams.set('source', 'direct_link');
  url.searchParams.set('backurl', `https://dikidi.net/ru/profile/avtoshkola_azimut_${COMPANY_ID}`);
  return url.toString();
}

const SLOT_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:00$/;
export function normalizeSlots(slots) {
  if (!Array.isArray(slots)) throw new Error('Расписание: список слотов отсутствует');
  for (const slot of slots) {
    if (typeof slot !== 'string' || !SLOT_PATTERN.test(slot) ||
      Number.isNaN(Date.parse(slot.slice(0, 10) + 'T12:00:00Z')) ||
      new Date(slot.slice(0, 10) + 'T12:00:00Z').toISOString().slice(0, 10) !== slot.slice(0, 10)) {
      throw new Error('Расписание: неизвестный формат даты или времени');
    }
  }
  return [...new Set(slots)].sort();
}

export function slotDiff(previous, current) {
  const before = new Set(normalizeSlots(previous));
  const after = new Set(normalizeSlots(current));
  return {
    added: [...after].filter(slot => !before.has(slot)),
    removed: [...before].filter(slot => !after.has(slot))
  };
}

export function localTime(iso) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yekaterinburg', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(iso));
}

export function dateTimeOfSlot(slot) {
  const [year, month, day] = slot.slice(0, 10).split('-');
  return `${day}.${month}.${year} ${slot.slice(11, 16)}`;
}
