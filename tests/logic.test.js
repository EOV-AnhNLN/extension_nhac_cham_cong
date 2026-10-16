const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTodayString,
  isValidTimekeeping,
  parseHour,
  parseTimekeeping,
  getEffectiveTimekeeping,
  isEffectiveDone,
  isDayOffStatus,
  isInReminderWindow,
  getTodayOverrides,
  getSkipReason,
  getBadgeState,
  DEFAULT_CONFIG,
  normalizeConfig,
  computePopupPosition
} = require('../logic.js');

const SETTINGS = {
  morningIn: { hour: 8, minute: 0, enabled: true },
  noon: { hour: 12, minute: 0, enabled: true },
  afternoonIn: { hour: 13, minute: 30, enabled: true },
  evening: { hour: 17, minute: 0, enabled: true }
};

// 16/10/2026 (thứ 6) lúc hh:mm giờ local
function at(hour, minute = 0) {
  return new Date(2026, 9, 16, hour, minute);
}

function dayData({ s1 = [null, null], s2 = [null, null], workStatus = '1', date = '16/10/2026' } = {}) {
  return {
    date,
    found: true,
    session1: { checkIn: s1[0], checkOut: s1[1] },
    session2: { checkIn: s2[0], checkOut: s2[1] },
    workStatus
  };
}

test('getTodayString: DD/MM/YYYY', () => {
  assert.equal(getTodayString(new Date(2026, 0, 5)), '05/01/2026');
});

test('isValidTimekeeping', () => {
  assert.equal(isValidTimekeeping('08:00'), true);
  assert.equal(isValidTimekeeping('_____'), false);
  assert.equal(isValidTimekeeping('  '), false);
  assert.equal(isValidTimekeeping(null), false);
  assert.equal(isValidTimekeeping(undefined), false);
});

test('parseHour', () => {
  assert.equal(parseHour('13:30'), 13.5);
  assert.equal(parseHour('___'), null);
  assert.equal(parseHour('abc'), null);
});

test('parseTimekeeping', () => {
  assert.deepEqual(parseTimekeeping('08:08 - 12:00'), { checkIn: '08:08', checkOut: '12:00' });
  assert.deepEqual(parseTimekeeping('08:08 - ___'), { checkIn: '08:08', checkOut: null });
  assert.deepEqual(parseTimekeeping('-'), { checkIn: null, checkOut: null });
  assert.deepEqual(parseTimekeeping(''), { checkIn: null, checkOut: null });
});

test('getEffectiveTimekeeping: ngày bình thường', () => {
  const eff = getEffectiveTimekeeping(dayData({ s1: ['08:00', '12:00'], s2: ['13:30', null] }));
  assert.equal(eff.isAfternoonOnly, false);
  assert.equal(eff.morningCheckIn, '08:00');
  assert.equal(eff.morningCheckOut, '12:00');
  assert.equal(eff.afternoonCheckIn, '13:30');
  assert.equal(eff.afternoonCheckOut, null);
});

test('getEffectiveTimekeeping: nghỉ sáng (session1 chứa giờ chiều)', () => {
  const eff = getEffectiveTimekeeping(dayData({ s1: ['13:25', null] }));
  assert.equal(eff.isAfternoonOnly, true);
  assert.equal(eff.morningCheckIn, 'OFF');
  assert.equal(eff.morningCheckOut, 'OFF');
  assert.equal(eff.afternoonCheckIn, '13:25');
  assert.equal(isEffectiveDone(eff.morningCheckOut), true);
  assert.equal(isEffectiveDone(eff.afternoonCheckOut), false);
});

test('getEffectiveTimekeeping: không có dữ liệu', () => {
  const eff = getEffectiveTimekeeping({ found: false });
  assert.equal(eff.morningCheckIn, null);
});

test('isDayOffStatus', () => {
  assert.equal(isDayOffStatus('OFF'), true);
  assert.equal(isDayOffStatus(' off '), true);
  assert.equal(isDayOffStatus('0.96'), false);
  assert.equal(isDayOffStatus(null), false);
});

test('isInReminderWindow: khung tính từ giờ cài đặt', () => {
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(11, 59)), false);
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(12, 0)), true);
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(13, 29)), true);
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(13, 30)), false);
  assert.equal(isInReminderWindow('morningIn', SETTINGS.morningIn, at(7, 30)), false);
  assert.equal(isInReminderWindow('morningIn', SETTINGS.morningIn, at(9, 29)), true);
  assert.equal(isInReminderWindow('evening', SETTINGS.evening, at(23, 59)), true);
  assert.equal(isInReminderWindow('unknown', SETTINGS.noon, at(12, 0)), false);
});

test('isInReminderWindow: không nhắc checkin chiều trong giờ ăn trưa', () => {
  assert.equal(isInReminderWindow('afternoonIn', SETTINGS.afternoonIn, at(12, 10)), false);
  assert.equal(isInReminderWindow('afternoonIn', SETTINGS.afternoonIn, at(13, 30)), true);
});

test('isInReminderWindow: giờ về đổi sang 18:00 thì 17:00 chưa nhắc', () => {
  const evening = { hour: 18, minute: 0, enabled: true };
  assert.equal(isInReminderWindow('evening', evening, at(17, 0)), false);
  assert.equal(isInReminderWindow('evening', evening, at(18, 0)), true);
});

test('getTodayOverrides: bỏ dữ liệu ngày cũ', () => {
  const old = { date: '15/10/2026', skip: { noon: true }, snoozeUntil: {} };
  assert.deepEqual(getTodayOverrides(old, at(12)).skip, {});
  const today = { date: '16/10/2026', skip: { noon: true } };
  assert.deepEqual(getTodayOverrides(today, at(12)), { date: '16/10/2026', skip: { noon: true }, snoozeUntil: {} });
});

test('getSkipReason: nhắc khi trong khung giờ mà chưa chấm', () => {
  const ctx = { settings: SETTINGS, now: at(12, 5), data: dayData({ s1: ['08:00', null] }) };
  assert.equal(getSkipReason('noon', ctx), null);
});

test('getSkipReason: chưa có dữ liệu hôm nay → vẫn nhắc', () => {
  assert.equal(getSkipReason('noon', { settings: SETTINGS, now: at(12, 5), data: null }), null);
  const yesterday = dayData({ s1: ['08:00', '12:00'], date: '15/10/2026' });
  assert.equal(getSkipReason('noon', { settings: SETTINGS, now: at(12, 5), data: yesterday }), null);
});

test('getSkipReason: các lý do không nhắc', () => {
  const base = { settings: SETTINGS, now: at(12, 5), data: dayData({ s1: ['08:00', null] }) };

  const disabled = { ...SETTINGS, noon: { ...SETTINGS.noon, enabled: false } };
  assert.equal(getSkipReason('noon', { ...base, settings: disabled }), 'disabled');

  const skipped = { date: '16/10/2026', skip: { noon: true }, snoozeUntil: {} };
  assert.equal(getSkipReason('noon', { ...base, overrides: skipped }), 'skipped');

  const snoozed = { date: '16/10/2026', skip: {}, snoozeUntil: { noon: at(12, 10).getTime() } };
  assert.equal(getSkipReason('noon', { ...base, overrides: snoozed }), 'snoozed');
  assert.equal(getSkipReason('noon', { ...base, now: at(12, 10), overrides: snoozed }), null);

  assert.equal(getSkipReason('noon', { ...base, now: at(14, 0) }), 'out-of-window');

  const dayOff = dayData({ workStatus: 'OFF' });
  assert.equal(getSkipReason('noon', { ...base, data: dayOff }), 'day-off');

  const done = dayData({ s1: ['08:00', '12:01'] });
  assert.equal(getSkipReason('noon', { ...base, data: done }), 'done');
});

test('getSkipReason: nghỉ sáng → không nhắc checkout trưa, vẫn nhắc checkout chiều', () => {
  const data = dayData({ s1: ['13:25', null] });
  assert.equal(getSkipReason('noon', { settings: SETTINGS, now: at(13, 26), data }), 'done');
  assert.equal(getSkipReason('evening', { settings: SETTINGS, now: at(17, 5), data }), null);
});

test('getBadgeState', () => {
  const now = at(15);
  const noPending = { morningIn: false, noon: false };

  assert.equal(getBadgeState({ enabled: false, pending: noPending, data: null, now }).text, 'OFF');
  assert.equal(getBadgeState({ enabled: true, pending: noPending, data: null, now }).text, '?');
  assert.equal(getBadgeState({ enabled: true, pending: { noon: true }, data: null, now }).text, '!');
  assert.equal(getBadgeState({ enabled: true, pending: noPending, data: dayData({ workStatus: 'OFF' }), now }).text, '');

  const partial = getBadgeState({ enabled: true, pending: noPending, data: dayData({ s1: ['08:00', '12:00'], s2: ['13:30', null] }), now });
  assert.equal(partial.text, '3/4');
  assert.equal(partial.title, 'Sáng: 08:00 → 12:00\nChiều: 13:30 → ---');

  const full = dayData({ s1: ['08:00', '12:00'], s2: ['13:30', '17:30'] });
  assert.equal(getBadgeState({ enabled: true, pending: noPending, data: full, now }).text, '✓');

  const afternoonOnly = getBadgeState({ enabled: true, pending: noPending, data: dayData({ s1: ['13:25', null] }), now });
  assert.equal(afternoonOnly.text, '3/4');
  assert.equal(afternoonOnly.title, 'Sáng: nghỉ → nghỉ\nChiều: 13:25 → ---');
});

test('normalizeConfig: rỗng → mặc định', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test('normalizeConfig: ép về giới hạn hợp lệ, giữ giá trị đúng', () => {
  const config = normalizeConfig({
    repeatIntervalMinutes: '5',       // chuỗi từ form
    recheckAfterDismissMinutes: 0,    // < min
    snoozeMinutes: '',                // rỗng → mặc định
    reminderWindowMinutes: { noon: 45, evening: 'abc' },
    soundEnabled: false,
    soundIntervalSeconds: 1000,       // > max
    popupPosition: 'nowhere',         // không hợp lệ
    fastPollSeconds: 10,              // alarms tối thiểu 30 giây
    syncCheckTime: { hour: '14', minute: '30' },
    useApi: 'yes'                     // không phải boolean
  });
  assert.equal(config.repeatIntervalMinutes, 5);
  assert.equal(config.recheckAfterDismissMinutes, 1);
  assert.equal(config.snoozeMinutes, 10);
  assert.deepEqual(config.reminderWindowMinutes, { morningIn: 90, noon: 45, afternoonIn: 120, evening: 0 });
  assert.equal(config.soundEnabled, false);
  assert.equal(config.soundIntervalSeconds, 60);
  assert.equal(config.popupPosition, 'top-right');
  assert.equal(config.fastPollSeconds, 30);
  assert.deepEqual(config.syncCheckTime, { hour: 14, minute: 30 });
  assert.equal(config.useApi, true);
});

test('isInReminderWindow + getSkipReason: khung giờ theo cấu hình', () => {
  const windows = { ...DEFAULT_CONFIG.reminderWindowMinutes, noon: 30, morningIn: 0 };
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(12, 29), windows), true);
  assert.equal(isInReminderWindow('noon', SETTINGS.noon, at(12, 30), windows), false);
  // 0 = đến hết ngày
  assert.equal(isInReminderWindow('morningIn', SETTINGS.morningIn, at(16, 0), windows), true);

  const config = normalizeConfig({ reminderWindowMinutes: { noon: 30 } });
  const ctx = { settings: SETTINGS, now: at(12, 40), data: null, config };
  assert.equal(getSkipReason('noon', ctx), 'out-of-window');
  assert.equal(getSkipReason('noon', { ...ctx, config: undefined }), null);
});

test('computePopupPosition: theo cửa sổ trình duyệt', () => {
  const area = { left: 100, top: 50, width: 1200, height: 800 };
  const size = { width: 340, height: 280 };
  assert.deepEqual(computePopupPosition('top-right', area, size), { left: 940, top: 70 });
  assert.deepEqual(computePopupPosition('top-left', area, size), { left: 120, top: 70 });
  assert.deepEqual(computePopupPosition('bottom-right', area, size), { left: 940, top: 550 });
  assert.deepEqual(computePopupPosition('bottom-left', area, size), { left: 120, top: 550 });
  assert.deepEqual(computePopupPosition('center', area, size), { left: 530, top: 310 });
  // Cửa sổ nhỏ hơn popup → không vượt ra ngoài mép trái/trên
  assert.deepEqual(computePopupPosition('bottom-right', { left: 0, top: 0, width: 300, height: 200 }, size), { left: 0, top: 0 });
});
