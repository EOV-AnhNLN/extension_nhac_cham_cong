// Các hàm thuần (không dùng chrome.* / DOM) – dùng chung cho background, content script và unit test

// Các loại nhắc nhở theo thứ tự trong ngày
const REMINDER_TYPES = ['morningIn', 'noon', 'afternoonIn', 'evening'];

// Field tương ứng trong kết quả getEffectiveTimekeeping của từng loại nhắc
const EFFECTIVE_FIELD = {
  morningIn: 'morningCheckIn',
  noon: 'morningCheckOut',
  afternoonIn: 'afternoonCheckIn',
  evening: 'afternoonCheckOut'
};

// Vị trí popup nhắc (so với cửa sổ trình duyệt đang dùng)
const POPUP_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

// Cấu hình riêng của extension (trang Cài đặt nâng cao)
const DEFAULT_CONFIG = {
  repeatIntervalMinutes: 3,         // Lặp lại popup mỗi X phút
  recheckAfterDismissMinutes: 1,    // Bấm OK → kiểm tra lại sau X phút
  snoozeMinutes: 10,                // Nút tạm hoãn
  // Độ dài khung nhắc (phút) tính từ giờ cài đặt; 0 = đến hết ngày
  reminderWindowMinutes: {
    morningIn: 90,    // 8:00 → 9:30
    noon: 90,         // 12:00 → 13:30
    afternoonIn: 120, // 13:30 → 15:30
    evening: 0        // 17:00 → 23:59
  },
  soundEnabled: true,
  soundIntervalSeconds: 5,          // Lặp tiếng bíp mỗi X giây
  popupPosition: 'top-right',
  fastPollSeconds: 30,              // Đang chờ chấm công → kiểm tra mỗi X giây
  slowPollMinutes: 60,              // Ngoài giờ nhắc → kiểm tra mỗi X phút
  syncCheckEnabled: true,           // Nhắc đồng bộ khi chưa có dữ liệu hôm nay
  syncCheckTime: { hour: 13, minute: 0 },
  useApi: true                      // Ưu tiên gọi API JSON thay vì đọc trang
};

// Số nguyên trong [min, max]; không hợp lệ → fallback
function clampInt(value, min, max, fallback) {
  let n = NaN;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  }
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Gộp cấu hình đã lưu với mặc định, ép về giới hạn hợp lệ
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_CONFIG;
  const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

  const reminderWindowMinutes = {};
  for (const type of REMINDER_TYPES) {
    reminderWindowMinutes[type] = clampInt(c.reminderWindowMinutes?.[type], 0, 24 * 60, d.reminderWindowMinutes[type]);
  }

  return {
    repeatIntervalMinutes: clampInt(c.repeatIntervalMinutes, 1, 60, d.repeatIntervalMinutes),
    recheckAfterDismissMinutes: clampInt(c.recheckAfterDismissMinutes, 1, 60, d.recheckAfterDismissMinutes),
    snoozeMinutes: clampInt(c.snoozeMinutes, 1, 120, d.snoozeMinutes),
    reminderWindowMinutes,
    soundEnabled: bool(c.soundEnabled, d.soundEnabled),
    soundIntervalSeconds: clampInt(c.soundIntervalSeconds, 2, 60, d.soundIntervalSeconds),
    popupPosition: POPUP_POSITIONS.includes(c.popupPosition) ? c.popupPosition : d.popupPosition,
    // chrome.alarms tối thiểu 30 giây
    fastPollSeconds: clampInt(c.fastPollSeconds, 30, 600, d.fastPollSeconds),
    slowPollMinutes: clampInt(c.slowPollMinutes, 5, 240, d.slowPollMinutes),
    syncCheckEnabled: bool(c.syncCheckEnabled, d.syncCheckEnabled),
    syncCheckTime: {
      hour: clampInt(c.syncCheckTime?.hour, 0, 23, d.syncCheckTime.hour),
      minute: clampInt(c.syncCheckTime?.minute, 0, 59, d.syncCheckTime.minute)
    },
    useApi: bool(c.useApi, d.useApi)
  };
}

// Toạ độ popup nhắc trong vùng `area` (bounds cửa sổ trình duyệt)
function computePopupPosition(position, area, size, margin = 20) {
  const maxLeft = area.left + Math.max(0, area.width - size.width);
  const maxTop = area.top + Math.max(0, area.height - size.height);
  let left;
  let top;
  switch (position) {
    case 'top-left':
      left = area.left + margin;
      top = area.top + margin;
      break;
    case 'bottom-right':
      left = maxLeft - margin;
      top = maxTop - margin;
      break;
    case 'bottom-left':
      left = area.left + margin;
      top = maxTop - margin;
      break;
    case 'center':
      left = area.left + (area.width - size.width) / 2;
      top = area.top + (area.height - size.height) / 2;
      break;
    default: // top-right
      left = maxLeft - margin;
      top = area.top + margin;
  }
  const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
  return { left: clamp(left, area.left, maxLeft), top: clamp(top, area.top, maxTop) };
}

// "Nghỉ buổi này" bỏ qua luôn các mốc còn lại của cùng buổi
const SKIP_GROUPS = {
  morningIn: ['morningIn', 'noon'],
  noon: ['noon'],
  afternoonIn: ['afternoonIn', 'evening'],
  evening: ['evening']
};

// Lấy ngày dạng DD/MM/YYYY
function getTodayString(now = new Date()) {
  const day = now.getDate().toString().padStart(2, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

// Kiểm tra giá trị chấm công có hợp lệ không (không phải null/undefined/""/"_____")
function isValidTimekeeping(val) {
  return !!val && typeof val === 'string' && val.trim() !== '' && !/^_+$/.test(val.trim());
}

// Parse giờ từ chuỗi thời gian ("08:20" → 8.33, "13:23" → 13.38)
function parseHour(timeStr) {
  if (!isValidTimekeeping(timeStr)) return null;
  const parts = timeStr.trim().split(':');
  if (parts.length >= 2) {
    return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
  }
  return null;
}

// Parse ô chấm công FastWork (ví dụ: "08:08 - 12:00" hoặc "08:08 - ___")
function parseTimekeeping(text) {
  if (!text || text.trim() === '' || text.trim() === '-') {
    return { checkIn: null, checkOut: null };
  }

  const parts = text.split('-').map(p => p.trim());
  return {
    checkIn: isValidTimekeeping(parts[0]) ? parts[0] : null,
    checkOut: isValidTimekeeping(parts[1]) ? parts[1] : null
  };
}

// Xác định thực tế đã chấm công gì
// Trường hợp nghỉ sáng: session1 chứa giờ chiều (checkIn >= 12:00), session2 trống
// Trường hợp bình thường: session1 = buổi sáng, session2 = buổi chiều
function getEffectiveTimekeeping(data) {
  const result = {
    morningCheckIn: null,     // checkin sáng
    morningCheckOut: null,    // checkout trưa
    afternoonCheckIn: null,   // checkin chiều
    afternoonCheckOut: null,  // checkout chiều
    isAfternoonOnly: false    // true = nghỉ sáng, chỉ làm chiều
  };

  if (!data || !data.found) return result;

  const s1In = data.session1?.checkIn;
  const s1Out = data.session1?.checkOut;
  const s2In = data.session2?.checkIn;
  const s2Out = data.session2?.checkOut;

  const s1InHour = parseHour(s1In);

  // Nếu session1.checkIn >= 12:00 và session2 trống → nghỉ sáng, chỉ chấm chiều
  if (s1InHour !== null && s1InHour >= 12 && !isValidTimekeeping(s2In) && !isValidTimekeeping(s2Out)) {
    result.isAfternoonOnly = true;
    result.morningCheckIn = 'OFF';    // Nghỉ sáng
    result.morningCheckOut = 'OFF';   // Nghỉ sáng
    result.afternoonCheckIn = s1In;   // Checkin chiều nằm ở session1
    result.afternoonCheckOut = s1Out; // Checkout chiều nằm ở session1
  } else {
    // Trường hợp bình thường
    result.morningCheckIn = s1In;
    result.morningCheckOut = s1Out;
    result.afternoonCheckIn = s2In;
    result.afternoonCheckOut = s2Out;
  }

  return result;
}

// Kiểm tra 1 field effective đã hoàn thành chưa
function isEffectiveDone(val) {
  return val === 'OFF' || isValidTimekeeping(val);
}

// Cột "Công" từ FastWork: "OFF" = nghỉ, các giá trị số (1, 0.96, ...) = đi làm
function isDayOffStatus(workStatus) {
  return typeof workStatus === 'string' && workStatus.trim().toLowerCase() === 'off';
}

// Dữ liệu chấm công có phải của ngày `now` không
function isTodayData(data, now) {
  return !!(data && data.found && data.date === getTodayString(now));
}

// Đang trong khung nhắc của loại `type` không (tính từ giờ cài đặt)
function isInReminderWindow(type, setting, now, windowMinutes = DEFAULT_CONFIG.reminderWindowMinutes) {
  if (!setting || !REMINDER_TYPES.includes(type)) return false;
  const start = setting.hour * 60 + setting.minute;
  const duration = windowMinutes?.[type] ?? DEFAULT_CONFIG.reminderWindowMinutes[type];
  const end = duration > 0 ? start + duration : 24 * 60;
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= start && current < end;
}

// Bỏ qua/tạm hoãn của hôm nay (dữ liệu ngày cũ coi như rỗng)
function getTodayOverrides(overrides, now) {
  const date = getTodayString(now);
  if (!overrides || overrides.date !== date) {
    return { date, skip: {}, snoozeUntil: {} };
  }
  return {
    date,
    skip: { ...(overrides.skip || {}) },
    snoozeUntil: { ...(overrides.snoozeUntil || {}) }
  };
}

// Lý do KHÔNG nhắc loại `type`, hoặc null nếu cần nhắc
function getSkipReason(type, { settings, now, data, overrides, config }) {
  const setting = settings?.[type];
  if (!setting || !setting.enabled) return 'disabled';

  const todayOverrides = getTodayOverrides(overrides, now);
  if (todayOverrides.skip[type]) return 'skipped';
  const snoozeUntil = todayOverrides.snoozeUntil[type];
  if (snoozeUntil && now.getTime() < snoozeUntil) return 'snoozed';

  if (!isInReminderWindow(type, setting, now, config?.reminderWindowMinutes)) return 'out-of-window';

  // Chưa có dữ liệu hôm nay → không biết, mặc định nhắc
  if (isTodayData(data, now)) {
    if (isDayOffStatus(data.workStatus)) return 'day-off';
    const eff = getEffectiveTimekeeping(data);
    if (isEffectiveDone(eff[EFFECTIVE_FIELD[type]])) return 'done';
  }

  return null;
}

// ===== API JSON FastWork (fwhrm.fastwork.vn/TimesheetMobile) =====

// Timestamp (ms) → "HH:MM" giờ local
function formatClock(timestamp) {
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Lấy cấu hình API từ URL request thật của trang FastWork
// https://fwhrm.fastwork.vn/TimesheetMobile/<companyId>?email=<email>&from_date=...
function parseTimesheetUrl(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/TimesheetMobile\/([^/]+)$/);
    const email = u.searchParams.get('email');
    if (!match || !email) return null;
    return { origin: u.origin, companyId: decodeURIComponent(match[1]), email };
  } catch (e) {
    return null;
  }
}

// URL lấy chấm công của ngày `now` (from = 00:00 hôm nay, to = 00:00 ngày mai)
function buildTimesheetUrl({ origin, companyId, email }, now) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const params = new URLSearchParams({
    email,
    from_date: String(from.getTime()),
    to_date: String(to.getTime()),
    web: 'true',
    report: 'true',
    view: 'true'
  });
  return `${origin}/TimesheetMobile/${encodeURIComponent(companyId)}?${params}`;
}

// Chuyển response API sang cùng format với dữ liệu đọc từ bảng (content.js)
// Trả về null nếu response không đúng format (để fallback sang đọc trang)
function parseTimesheetResponse(json, email, now) {
  if (!json || !Array.isArray(json.result)) return null;

  const today = getTodayString(now);
  const result = {
    date: today,
    found: false,
    session1: { checkIn: null, checkOut: null },
    session2: { checkIn: null, checkOut: null },
    shift: null,
    workStatus: null
  };

  const employee = json.result.find(r => r && r.email === email) || json.result[0];
  if (!employee || !employee.data) return result;

  // data: { "1": {...}, "2": {...} } – key là ngày trong tháng, `date` = 00:00 local
  const day = Object.values(employee.data).find(d => d && d.date && getTodayString(new Date(d.date)) === today);
  if (!day) return result;

  // Mỗi phần tử checkin = 1 cặp V (vào) / R (ra)
  const timeOf = (c) => c.V?.datetime || c.R?.datetime;
  const pairs = (day.checkin || []).filter(c => c && timeOf(c)).sort((a, b) => timeOf(a) - timeOf(b));
  const toSession = (c) => ({
    checkIn: c?.V?.datetime ? formatClock(c.V.datetime) : null,
    checkOut: c?.R?.datetime ? formatClock(c.R.datetime) : null
  });

  result.found = true;
  // Lần 1 = cặp đầu, lần 2 = cặp cuối (nếu chấm nhiều hơn 2 lần)
  result.session1 = toSession(pairs[0]);
  result.session2 = pairs.length >= 2 ? toSession(pairs[pairs.length - 1]) : toSession(null);
  result.shift = day.shift?.[0]?.label || day.ca || null;
  // `text` = cột "Công" (1, 0.97, "OFF"...); ngày lễ coi như OFF
  if (day.isNghiLe) {
    result.workStatus = 'OFF';
  } else if (day.text !== '' && day.text !== null && day.text !== undefined) {
    result.workStatus = String(day.text);
  }
  return result;
}

const BADGE_COLORS = {
  grey: '#9e9e9e',
  red: '#d93025',
  orange: '#f29900',
  green: '#1e8e3e'
};

// Nội dung badge trên icon extension
function getBadgeState({ enabled, pending, data, now }) {
  if (!enabled) {
    return { text: 'OFF', color: BADGE_COLORS.grey, title: 'Nhắc Nhở Chấm Công: đang tắt' };
  }

  const hasPending = Object.values(pending || {}).some(Boolean);

  if (!isTodayData(data, now)) {
    return {
      text: hasPending ? '!' : '?',
      color: hasPending ? BADGE_COLORS.red : BADGE_COLORS.grey,
      title: 'Chưa có dữ liệu chấm công hôm nay'
    };
  }

  if (isDayOffStatus(data.workStatus) && !hasPending) {
    return { text: '', color: BADGE_COLORS.grey, title: 'Hôm nay nghỉ' };
  }

  const eff = getEffectiveTimekeeping(data);
  const show = (val) => val === 'OFF' ? 'nghỉ' : (isValidTimekeeping(val) ? val : '---');
  const title = `Sáng: ${show(eff.morningCheckIn)} → ${show(eff.morningCheckOut)}\n` +
    `Chiều: ${show(eff.afternoonCheckIn)} → ${show(eff.afternoonCheckOut)}`;

  if (hasPending) return { text: '!', color: BADGE_COLORS.red, title };

  const doneCount = REMINDER_TYPES.filter(t => isEffectiveDone(eff[EFFECTIVE_FIELD[t]])).length;
  if (doneCount === REMINDER_TYPES.length) {
    return { text: '✓', color: BADGE_COLORS.green, title };
  }
  return { text: `${doneCount}/${REMINDER_TYPES.length}`, color: BADGE_COLORS.orange, title };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REMINDER_TYPES,
    EFFECTIVE_FIELD,
    SKIP_GROUPS,
    POPUP_POSITIONS,
    DEFAULT_CONFIG,
    normalizeConfig,
    computePopupPosition,
    getTodayString,
    isValidTimekeeping,
    parseHour,
    parseTimekeeping,
    getEffectiveTimekeeping,
    isEffectiveDone,
    isDayOffStatus,
    isTodayData,
    isInReminderWindow,
    getTodayOverrides,
    getSkipReason,
    getBadgeState,
    formatClock,
    parseTimesheetUrl,
    buildTimesheetUrl,
    parseTimesheetResponse
  };
}
