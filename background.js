// Thời gian nhắc nhở mặc định (giờ:phút)
const DEFAULT_REMINDERS = {
  morningIn: { hour: 8, minute: 0, enabled: true },
  noon: { hour: 12, minute: 0, enabled: true },
  afternoonIn: { hour: 13, minute: 30, enabled: true },
  evening: { hour: 17, minute: 0, enabled: true }
};

// Lưu trữ các thông báo đang chờ xác nhận
let pendingNotifications = {
  morningIn: false,
  noon: false,
  afternoonIn: false,
  evening: false,
  sync: false
};

// Lưu ID popup window đang mở
let reminderWindowId = null;

// Lưu ID cửa sổ ẩn để fetch dữ liệu FastWork ngầm
let hiddenFetchWindowId = null;

// Lưu trữ dữ liệu chấm công
let timekeepingData = {
  date: null,
  found: false,
  session1: { checkIn: null, checkOut: null },
  session2: { checkIn: null, checkOut: null },
  workStatus: null,
  lastUpdated: null
};

// Thời gian lặp lại thông báo (phút)
const REPEAT_INTERVAL_MINUTES = 1;

// Thời gian kiểm tra lại sau khi dismiss (phút)
const RECHECK_AFTER_DISMISS_MINUTES = 1;

// Kiểm tra giá trị chấm công có hợp lệ không (không phải null/undefined/""/"_____")
function isValidTimekeeping(val) {
  return val && typeof val === 'string' && val.trim() !== '' && !/^_+$/.test(val.trim());
}

// Parse giờ từ chuỗi thời gian ("08:20" → 8.33, "13:23" → 13.38)
function parseHour(timeStr) {
  if (!isValidTimekeeping(timeStr)) return null;
  const parts = timeStr.trim().split(':');
  if (parts.length >= 2) {
    return parseInt(parts[0]) + parseInt(parts[1]) / 60;
  }
  return null;
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

// URL trang chấm công FastWork
const FASTWORK_URL = 'https://app.fastwork.vn/timekeepingpersonal#!/';

// Kiểm tra hôm nay có phải ngày OFF không (dựa vào cột "Công" từ FastWork)
async function checkIfDayOff() {
  const today = getTodayString();
  const result = await chrome.storage.local.get(['timekeepingData']);
  const data = result.timekeepingData;

  if (data && data.date === today && data.workStatus !== null && data.workStatus !== undefined) {
    const status = data.workStatus.toLowerCase().trim();
    // "OFF" = nghỉ (từ FastWork), các giá trị số (1, 0.96, 0.98...) = đi làm
    if (status === 'off') {
      console.log(`[dayOff] Hôm nay ${today} là ngày OFF (workStatus="${data.workStatus}")`);
      return true;
    }
    console.log(`[dayOff] Hôm nay ${today} workStatus="${data.workStatus}" → đi làm`);
    return false;
  }

  // Chưa có dữ liệu workStatus → không biết, mặc định = đi làm (sẽ nhắc)
  console.log(`[dayOff] Chưa có workStatus cho ${today}, mặc định đi làm`);
  return false;
}

// Khởi tạo khi extension được cài đặt
chrome.runtime.onInstalled.addListener(() => {
  console.log('=== Extension đã được cài đặt/cập nhật ===');
  initializeAlarms().catch(e => console.error('Lỗi initializeAlarms (onInstalled):', e));
});

// Kiểm tra extension có đang bật không
async function isExtensionEnabled() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['extensionEnabled'], (result) => {
      // Mặc định là bật (true) nếu chưa có giá trị
      resolve(result.extensionEnabled !== false);
    });
  });
}

// Khởi tạo khi Chrome khởi động
chrome.runtime.onStartup.addListener(() => {
  console.log('=== Chrome đã khởi động ===');
  initializeAlarms().catch(e => console.error('Lỗi initializeAlarms (onStartup):', e));
});

// Xử lý khi alarm được kích hoạt
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('Alarm triggered:', alarm.name);

  // Nếu extension tắt, chỉ cho phép watchdog chạy (để có thể khôi phục khi bật lại)
  const enabled = await isExtensionEnabled();
  if (!enabled && alarm.name !== 'watchdog') {
    console.log(`[alarm] Extension đang tắt, bỏ qua alarm: ${alarm.name}`);
    return;
  }

  if (alarm.name === 'morningIn-reminder') {
    console.log('[alarm] Kích hoạt morningIn-reminder');
    await handleMorningInReminder();
  } else if (alarm.name === 'noon-reminder') {
    console.log('[alarm] Kích hoạt noon-reminder');
    await handleNoonReminder();
  } else if (alarm.name === 'afternoonIn-reminder') {
    console.log('[alarm] Kích hoạt afternoonIn-reminder');
    await handleAfternoonInReminder();
  } else if (alarm.name === 'evening-reminder') {
    console.log('[alarm] Kích hoạt evening-reminder');
    await handleEveningReminder();
  } else if (alarm.name === 'repeat-morningIn' && pendingNotifications.morningIn) {
    showReminderPopup('morningIn');
  } else if (alarm.name === 'repeat-noon' && pendingNotifications.noon) {
    showReminderPopup('noon');
  } else if (alarm.name === 'repeat-afternoonIn' && pendingNotifications.afternoonIn) {
    showReminderPopup('afternoonIn');
  } else if (alarm.name === 'repeat-evening' && pendingNotifications.evening) {
    showReminderPopup('evening');
  } else if (alarm.name === 'check-fastwork') {
    await fetchTimekeepingFromFastwork();
  } else if (alarm.name === 'check-sync') {
    await checkSyncStatus();
  } else if (alarm.name === 'repeat-sync' && pendingNotifications.sync) {
    showSyncReminderPopup();
  } else if (alarm.name === 'recheck-morningIn') {
    await recheckAfterDismiss('morningIn');
  } else if (alarm.name === 'recheck-noon') {
    await recheckAfterDismiss('noon');
  } else if (alarm.name === 'recheck-afternoonIn') {
    await recheckAfterDismiss('afternoonIn');
  } else if (alarm.name === 'recheck-evening') {
    await recheckAfterDismiss('evening');
  } else if (alarm.name === 'recheck-sync') {
    await checkSyncStatus();
  } else if (alarm.name === 'watchdog') {
    // Watchdog luôn chạy, nhưng chỉ kiểm tra nếu extension bật
    if (enabled) {
      await handleWatchdog();
    }
  }
});

// Khởi chạy ngay khi service worker load (không phụ thuộc onInstalled/onStartup)
// Service worker có thể restart bất cứ lúc nào mà không trigger onInstalled/onStartup
(async () => {
  console.log('=== Service worker loaded ===');
  try {
    // Kiểm tra xem alarms đã có chưa
    const existingAlarms = await chrome.alarms.getAll();
    console.log(`[startup] Có ${existingAlarms.length} alarms:`, existingAlarms.map(a => a.name));

    // Nếu không có watchdog alarm → cần khởi tạo lại
    const hasWatchdog = existingAlarms.some(a => a.name === 'watchdog');
    if (!hasWatchdog) {
      console.log('[startup] Không có watchdog → khởi tạo alarms');
      await initializeAlarms();
    } else {
      // Watchdog đã có → chỉ cần chạy kiểm tra ngay
      console.log('[startup] Watchdog đang chạy → kiểm tra ngay');
      const settings = await getSettings();
      await checkImmediateReminders(settings);
    }
  } catch (e) {
    console.error('[startup] Lỗi:', e);
  }
})();

// Kiểm tra trạng thái đồng bộ lúc 13:00
async function checkSyncStatus() {
  const now = new Date();
  const today = getTodayString();

  // Chỉ kiểm tra sau 13:00
  if (now.getHours() >= 13) {
    // Lấy dữ liệu từ storage
    const result = await chrome.storage.local.get(['timekeepingData']);
    const data = result.timekeepingData;

    // Kiểm tra xem đã có dữ liệu của ngày hôm nay chưa
    if (!data || !data.found || data.date !== today) {
      console.log('Chưa đồng bộ dữ liệu hôm nay, nhắc nhở...');
      pendingNotifications.sync = true;
      showSyncReminderPopup();
      startRepeatAlarm('sync');
    } else {
      console.log('Đã có dữ liệu hôm nay:', data.date);
    }
  }
}

// Hiển thị popup nhắc đồng bộ
async function showSyncReminderPopup() {
  if (reminderWindowId) {
    try {
      await chrome.windows.remove(reminderWindowId);
    } catch (e) { }
  }

  const popup = await chrome.windows.create({
    url: 'reminder.html?type=sync',
    type: 'popup',
    width: 340,
    height: 220,
    top: 20,
    left: 1560,
    focused: true
  });

  reminderWindowId = popup.id;
}

// Lấy ngày hôm nay dạng DD/MM/YYYY
function getTodayString() {
  const today = new Date();
  const day = today.getDate().toString().padStart(2, '0');
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const year = today.getFullYear();
  return `${day}/${month}/${year}`;
}

// Reset trạng thái khi qua ngày mới
async function resetForNewDay() {
  const today = getTodayString();
  const result = await chrome.storage.local.get(['timekeepingData', 'lastActiveDate']);
  const lastDate = result.lastActiveDate;

  if (lastDate && lastDate !== today) {
    console.log(`Đã qua ngày mới (${lastDate} -> ${today}), reset trạng thái`);

    // Reset pending notifications
    pendingNotifications.morningIn = false;
    pendingNotifications.noon = false;
    pendingNotifications.afternoonIn = false;
    pendingNotifications.evening = false;
    pendingNotifications.sync = false;

    // Xóa các alarm recheck và repeat cũ
    await chrome.alarms.clear('recheck-morningIn');
    await chrome.alarms.clear('recheck-noon');
    await chrome.alarms.clear('recheck-afternoonIn');
    await chrome.alarms.clear('recheck-evening');
    await chrome.alarms.clear('repeat-morningIn');
    await chrome.alarms.clear('repeat-noon');
    await chrome.alarms.clear('repeat-afternoonIn');
    await chrome.alarms.clear('repeat-evening');
    await chrome.alarms.clear('repeat-sync');

    // Reset dữ liệu chấm công
    timekeepingData = {
      date: null,
      found: false,
      session1: { checkIn: null, checkOut: null },
      session2: { checkIn: null, checkOut: null },
      workStatus: null,
      lastUpdated: null
    };
    await chrome.storage.local.set({ timekeepingData });

    // Đóng popup nhắc nhở cũ nếu có
    if (reminderWindowId) {
      try {
        await chrome.windows.remove(reminderWindowId);
      } catch (e) { }
      reminderWindowId = null;
    }

    // Đóng cửa sổ ẩn fetch nếu có
    closeHiddenFetchWindow();

    // Xóa notification hệ thống cũ
    chrome.notifications.clear('morningIn-reminder');
    chrome.notifications.clear('noon-reminder');
    chrome.notifications.clear('afternoonIn-reminder');
    chrome.notifications.clear('evening-reminder');
  }

  // Luôn cập nhật ngày hiện tại
  await chrome.storage.local.set({ lastActiveDate: today });
}

// Kiểm tra thời gian nhắc có hợp lệ cho ngày hiện tại không
function isTimeValidForReminder(type) {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  if (type === 'morningIn') {
    // Chỉ nhắc checkin sáng từ 7:30 đến 9:30
    return (hour === 7 && minute >= 30) || (hour === 8) || (hour === 9 && minute <= 30);
  } else if (type === 'noon') {
    // Chỉ nhắc checkout trưa từ 12:00 đến 13:30
    return hour >= 12 && hour < 14;
  } else if (type === 'afternoonIn') {
    // Chỉ nhắc checkin chiều từ 12:00 đến 15:30
    return (hour === 12 && minute >= 0) || (hour === 13) || (hour === 14) || (hour === 15 && minute <= 30);
  } else if (type === 'evening') {
    // Chỉ nhắc checkout chiều từ 17:00 đến 23:59
    return hour >= 17;
  }
  return false;
}

// Xử lý nhắc nhở checkin sáng (8:00)
async function handleMorningInReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  const eff = getEffectiveTimekeeping(timekeepingData);
  if (!isEffectiveDone(eff.morningCheckIn)) {
    pendingNotifications.morningIn = true;
    showReminderPopup('morningIn');
    startRepeatAlarm('morningIn');
  } else {
    console.log('Đã checkin buổi sáng (hoặc nghỉ sáng), không cần nhắc');
  }
}

// Xử lý nhắc nhở checkout trưa (12:00)
async function handleNoonReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  const eff = getEffectiveTimekeeping(timekeepingData);
  if (!isEffectiveDone(eff.morningCheckOut)) {
    pendingNotifications.noon = true;
    showReminderPopup('noon');
    startRepeatAlarm('noon');
  } else {
    console.log('Đã checkout trưa (hoặc nghỉ sáng), không cần nhắc');
  }
}

// Xử lý nhắc nhở checkin chiều (13:30)
async function handleAfternoonInReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  const eff = getEffectiveTimekeeping(timekeepingData);
  if (!isEffectiveDone(eff.afternoonCheckIn)) {
    pendingNotifications.afternoonIn = true;
    showReminderPopup('afternoonIn');
    startRepeatAlarm('afternoonIn');
  } else {
    console.log('Đã checkin buổi chiều, không cần nhắc');
  }
}

// Xử lý nhắc nhở checkout chiều (17:00)
async function handleEveningReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  const eff = getEffectiveTimekeeping(timekeepingData);
  if (!isEffectiveDone(eff.afternoonCheckOut)) {
    pendingNotifications.evening = true;
    showReminderPopup('evening');
    startRepeatAlarm('evening');
  } else {
    console.log('Đã checkout buổi chiều, không cần nhắc');
  }
}

// Hiển thị popup window nhắc nhở
async function showReminderPopup(type) {
  console.log(`[popup] Tạo popup cho: ${type}`);

  // Đóng popup cũ nếu có
  if (reminderWindowId) {
    try {
      await chrome.windows.remove(reminderWindowId);
      console.log(`[popup] Đã đóng popup cũ: ${reminderWindowId}`);
    } catch (e) {
      // Window đã bị đóng
    }
    reminderWindowId = null;
  }

  try {
    // Tạo popup window nhỏ gọn ở góc phải trên
    const popup = await chrome.windows.create({
      url: `reminder.html?type=${type}`,
      type: 'popup',
      width: 340,
      height: 220,
      top: 20,
      left: 1560,  // Góc phải (điều chỉnh theo màn hình của bạn)
      focused: true
    });

    reminderWindowId = popup.id;
    console.log(`[popup] Popup ${type} đã tạo xong, windowId=${popup.id}`);
  } catch (e) {
    console.error(`[popup] KHÔNG TẠO ĐƯỢC POPUP ${type}:`, e);
  }

  // Cũng gửi notification hệ thống (backup)
  showSystemNotification(type);
}

// Hiển thị notification hệ thống (backup)
function showSystemNotification(type) {
  const messages = {
    morningIn: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 8:00 - Đừng quên checkin buổi sáng!'
    },
    noon: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 12:00 - Đừng quên chấm công ra ăn trưa!'
    },
    afternoonIn: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 13:30 - Đừng quên checkin buổi chiều!'
    },
    evening: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 17:00 - Đừng về trễ nhaaaa!'
    }
  };

  chrome.notifications.create(`${type}-reminder`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: messages[type].title,
    message: messages[type].message,
    priority: 2,
    requireInteraction: true
  });
}

// Xử lý khi click vào notification hệ thống
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);

  if (notificationId.startsWith('morningIn')) {
    dismissReminder('morningIn');
  } else if (notificationId.startsWith('noon')) {
    dismissReminder('noon');
  } else if (notificationId.startsWith('afternoonIn')) {
    dismissReminder('afternoonIn');
  } else if (notificationId.startsWith('evening')) {
    dismissReminder('evening');
  }

  chrome.tabs.create({ url: FASTWORK_URL });
});

// Xử lý khi đóng notification
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (byUser) {
    if (notificationId.startsWith('morningIn')) {
      dismissReminder('morningIn');
    } else if (notificationId.startsWith('noon')) {
      dismissReminder('noon');
    } else if (notificationId.startsWith('afternoonIn')) {
      dismissReminder('afternoonIn');
    } else if (notificationId.startsWith('evening')) {
      dismissReminder('evening');
    }
  }
});

// Dọn dẹp khi cửa sổ bị đóng
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === reminderWindowId) {
    reminderWindowId = null;
  }
  if (windowId === hiddenFetchWindowId) {
    hiddenFetchWindowId = null;
  }
});

// Dismiss reminder và dừng lặp, nhưng đặt alarm kiểm tra lại
function dismissReminder(type) {
  pendingNotifications[type] = false;
  chrome.alarms.clear(`repeat-${type}`);
  chrome.notifications.clear(`${type}-reminder`);

  // Đặt alarm kiểm tra lại sau 5 phút để xem đã chấm công thật chưa
  chrome.alarms.create(`recheck-${type}`, {
    delayInMinutes: RECHECK_AFTER_DISMISS_MINUTES
  });
  console.log(`Đã dismiss reminder ${type}, sẽ kiểm tra lại sau ${RECHECK_AFTER_DISMISS_MINUTES} phút`);
}

// Kiểm tra lại sau khi dismiss - nếu chưa chấm công thì nhắc lại
async function recheckAfterDismiss(type) {
  console.log(`Đang kiểm tra lại chấm công ${type}...`);

  // Reset trạng thái nếu đã qua ngày mới
  await resetForNewDay();

  // Kiểm tra thời gian có hợp lệ cho loại nhắc nhở này không
  if (!isTimeValidForReminder(type)) {
    console.log(`Đã quá giờ nhắc ${type} cho ngày hiện tại, bỏ qua`);
    pendingNotifications[type] = false;
    return;
  }

  // Lấy dữ liệu mới nhất từ FastWork
  await fetchTimekeepingFromFastwork();

  // Đọc từ storage để đảm bảo có dữ liệu mới nhất
  const result = await chrome.storage.local.get(['timekeepingData']);
  const data = result.timekeepingData || timekeepingData;
  const today = getTodayString();

  console.log('Dữ liệu kiểm tra:', data);

  // Mặc định là cần nhắc lại (nếu không có dữ liệu thì vẫn nhắc)
  let needReminder = true;

  if (data && data.found) {
    // Chỉ dùng dữ liệu nếu đúng ngày hôm nay
    if (data.date === today) {
      const eff = getEffectiveTimekeeping(data);
      if (type === 'morningIn') {
        needReminder = !isEffectiveDone(eff.morningCheckIn);
      } else if (type === 'noon') {
        needReminder = !isEffectiveDone(eff.morningCheckOut);
      } else if (type === 'afternoonIn') {
        needReminder = !isEffectiveDone(eff.afternoonCheckIn);
      } else if (type === 'evening') {
        needReminder = !isEffectiveDone(eff.afternoonCheckOut);
      }
    } else {
      // Dữ liệu cũ ngày khác, không tin cậy → nhắc nếu còn trong khung giờ
      console.log(`Dữ liệu chấm công là ngày ${data.date}, không phải hôm nay ${today}`);
      needReminder = isTimeValidForReminder(type);
    }
  }

  if (needReminder) {
    console.log(`Chưa chấm công ${type}, nhắc lại!`);
    pendingNotifications[type] = true;
    showReminderPopup(type);
    startRepeatAlarm(type);
  } else {
    console.log(`Đã chấm công ${type} rồi, không cần nhắc nữa`);
  }
}

// Helper: đợi tab load xong sau khi reload
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false); // timeout
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Helper: lấy data từ tab sau khi đảm bảo content script đã chạy
async function getDataFromTab(tabId, retries = 3, delayMs = 1500) {
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getTimekeepingData'
      });
      if (response && response.found) {
        return response;
      }
    } catch (e) { /* content script chưa sẵn sàng, thử lại */ }
  }
  return null;
}

// Helper: đảm bảo tab đang ở đúng URL chấm công, nếu không thì navigate về
async function ensureTimekeepingUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.includes('/timekeepingpersonal')) {
      // Đúng URL rồi → reload
      await chrome.tabs.reload(tabId);
    } else {
      // Sai URL → navigate về trang chấm công
      await chrome.tabs.update(tabId, { url: FASTWORK_URL });
    }
    return await waitForTabLoad(tabId);
  } catch (e) {
    console.log('Lỗi khi navigate tab:', e);
    return false;
  }
}

// Lấy dữ liệu chấm công từ FastWork
async function fetchTimekeepingFromFastwork() {
  try {
    // 1. Thử lấy từ tab FastWork đang mở (không phải cửa sổ ẩn)
    const allTabs = await chrome.tabs.query({ url: 'https://app.fastwork.vn/*' });
    const visibleTabs = allTabs.filter(t => !hiddenFetchWindowId || t.windowId !== hiddenFetchWindowId);

    if (visibleTabs.length > 0) {
      const tab = visibleTabs[0];

      // Kiểm tra tab có đang active (user đang nhìn) không
      const isActiveTab = tab.active;

      if (isActiveTab) {
        // Tab đang active → không reload để tránh gây phiền
        // Dùng cửa sổ ẩn thay thế
        console.log('Tab FastWork đang active, dùng cửa sổ ẩn để tránh reload gây phiền');

        if (hiddenFetchWindowId) {
          // Đã có cửa sổ ẩn → navigate về đúng URL chấm công
          try {
            const hiddenTabs = await chrome.tabs.query({ windowId: hiddenFetchWindowId });
            if (hiddenTabs.length > 0) {
              const loaded = await ensureTimekeepingUrl(hiddenTabs[0].id);
              if (loaded) {
                const response = await getDataFromTab(hiddenTabs[0].id);
                if (response) {
                  await handleTimekeepingResponse(response);
                  return;
                }
              }
            }
          } catch (e) {
            hiddenFetchWindowId = null;
          }
        }
        // Tạo cửa sổ ẩn mới
        await createHiddenFetchWindow();
        return;
      }

      // Tab không active (đang ở background) → navigate về đúng URL chấm công
      console.log('Navigate tab FastWork (background tab) về trang chấm công:', tab.id);
      const loaded = await ensureTimekeepingUrl(tab.id);

      if (loaded) {
        const response = await getDataFromTab(tab.id);
        if (response) {
          await handleTimekeepingResponse(response);
          return;
        }
      }
      console.log('Tab FastWork không trả về dữ liệu sau reload');
    }

    // 2. Thử lấy từ cửa sổ ẩn nếu đang mở
    if (hiddenFetchWindowId) {
      try {
        const hiddenTabs = await chrome.tabs.query({ windowId: hiddenFetchWindowId });
        for (const tab of hiddenTabs) {
          const loaded = await ensureTimekeepingUrl(tab.id);
          if (loaded) {
            const response = await getDataFromTab(tab.id);
            if (response) {
              await handleTimekeepingResponse(response);
              return;
            }
          }
        }
      } catch (e) {
        hiddenFetchWindowId = null;
      }
      return;
    }

    // 3. Không có tab nào → tạo cửa sổ ẩn (minimized) để fetch
    await createHiddenFetchWindow();

  } catch (error) {
    console.log('Lỗi khi lấy dữ liệu:', error);
  }
}

// Xử lý khi nhận được dữ liệu chấm công
async function handleTimekeepingResponse(response) {
  timekeepingData = {
    ...response,
    lastUpdated: new Date().toISOString()
  };
  await chrome.storage.local.set({ timekeepingData });
  console.log('Đã cập nhật dữ liệu chấm công:', timekeepingData);

  // Đóng cửa sổ ẩn nếu đã nhận dữ liệu
  closeHiddenFetchWindow();

  // Cập nhật tần suất polling
  await updatePollingFrequency();
}

// Tạo cửa sổ ẩn (minimized) để load FastWork ngầm
async function createHiddenFetchWindow() {
  try {
    console.log('Tạo cửa sổ ẩn để fetch dữ liệu FastWork...');
    const win = await chrome.windows.create({
      url: FASTWORK_URL,
      type: 'popup',
      state: 'minimized',
      focused: false,
      width: 800,
      height: 600
    });
    hiddenFetchWindowId = win.id;
    console.log('Đã tạo cửa sổ ẩn:', win.id);

    // Tự động đóng sau 60 giây để tránh zombie window
    setTimeout(() => {
      closeHiddenFetchWindow();
    }, 60000);
  } catch (e) {
    console.log('Không thể tạo cửa sổ ẩn:', e);
    hiddenFetchWindowId = null;
  }
}

// Đóng cửa sổ ẩn
function closeHiddenFetchWindow() {
  if (hiddenFetchWindowId) {
    console.log('Đóng cửa sổ ẩn:', hiddenFetchWindowId);
    chrome.windows.remove(hiddenFetchWindowId).catch(() => {});
    hiddenFetchWindowId = null;
  }
}

// Cập nhật tần suất polling dựa trên trạng thái chấm công
async function updatePollingFrequency() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=CN, 6=T7

  // Giảm tần suất ngày OFF
  const isDayOff = await checkIfDayOff();
  if (isDayOff) {
    await chrome.alarms.clear('check-fastwork');
    chrome.alarms.create('check-fastwork', {
      delayInMinutes: 60,
      periodInMinutes: 60
    });
    console.log('Polling ngày OFF: mỗi 60 phút');
    return;
  }

  const result = await chrome.storage.local.get(['timekeepingData']);
  const data = result.timekeepingData;
  const today = getTodayString();
  const hasData = data && data.date === today && data.found;
  const eff = hasData ? getEffectiveTimekeeping(data) : null;

  let needFrequentPoll = false;

  if (hour >= 7 && hour < 10) {
    // Gần giờ sáng - kiểm tra checkin buổi sáng
    needFrequentPoll = !eff || !isEffectiveDone(eff.morningCheckIn);
  } else if (hour >= 12 && hour < 14) {
    // Gần giờ trưa - kiểm tra checkout buổi sáng
    needFrequentPoll = !eff || !isEffectiveDone(eff.morningCheckOut);
  } else if (hour >= 12 && hour < 15) {
    // Gần giờ chiều - kiểm tra checkin buổi chiều
    needFrequentPoll = !eff || !isEffectiveDone(eff.afternoonCheckIn);
  } else if (hour >= 17) {
    // Gần giờ về - kiểm tra checkout buổi chiều
    needFrequentPoll = !eff || !isEffectiveDone(eff.afternoonCheckOut);
  }

  await chrome.alarms.clear('check-fastwork');

  if (needFrequentPoll) {
    chrome.alarms.create('check-fastwork', {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5  // 30 giây
    });
    console.log('Polling nhanh: mỗi 30 giây (chưa chấm công)');
  } else {
    chrome.alarms.create('check-fastwork', {
      delayInMinutes: 60,
      periodInMinutes: 60
    });
    console.log('Polling bình thường: mỗi 60 phút');
  }
}

// Bắt đầu alarm lặp lại
function startRepeatAlarm(type) {
  chrome.alarms.create(`repeat-${type}`, {
    delayInMinutes: REPEAT_INTERVAL_MINUTES,
    periodInMinutes: REPEAT_INTERVAL_MINUTES
  });
}

// Khởi tạo alarms
async function initializeAlarms() {
  // Reset trạng thái nếu qua ngày mới
  await resetForNewDay();

  // Kiểm tra extension có bật không
  const enabled = await isExtensionEnabled();
  if (!enabled) {
    console.log('[initAlarms] Extension đang tắt, chỉ tạo watchdog');
    // Xóa tất cả alarm trừ watchdog
    const allAlarms = await chrome.alarms.getAll();
    for (const alarm of allAlarms) {
      if (alarm.name !== 'watchdog') {
        await chrome.alarms.clear(alarm.name);
      }
    }
    // Đảm bảo watchdog vẫn chạy
    const hasWatchdog = allAlarms.some(a => a.name === 'watchdog');
    if (!hasWatchdog) {
      chrome.alarms.create('watchdog', {
        delayInMinutes: 5,
        periodInMinutes: 5
      });
    }
    return;
  }

  const settings = await getSettings();

  // Xóa tất cả alarm cũ (bao gồm cả repeat và recheck)
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    await chrome.alarms.clear(alarm.name);
  }

  if (settings.morningIn && settings.morningIn.enabled) {
    createDailyAlarm('morningIn-reminder', settings.morningIn.hour, settings.morningIn.minute);
  }

  if (settings.noon.enabled) {
    createDailyAlarm('noon-reminder', settings.noon.hour, settings.noon.minute);
  }

  if (settings.afternoonIn && settings.afternoonIn.enabled) {
    createDailyAlarm('afternoonIn-reminder', settings.afternoonIn.hour, settings.afternoonIn.minute);
  }

  if (settings.evening.enabled) {
    createDailyAlarm('evening-reminder', settings.evening.hour, settings.evening.minute);
  }

  // Polling thông minh: 30s khi chưa chấm công, 30p khi đã chấm
  await updatePollingFrequency();

  // Tạo alarm kiểm tra đồng bộ lúc 13:00
  createDailyAlarm('check-sync', 13, 0);

  // Watchdog: kiểm tra nhắc nhở mỗi 5 phút (backup cho trường hợp alarm chính bị miss)
  // Chrome MV3 minimum period = 1 phút
  chrome.alarms.create('watchdog', {
    delayInMinutes: 5,
    periodInMinutes: 5
  });

  console.log('Alarms đã được khởi tạo');

  // Kiểm tra ngay: nếu đang trong khung giờ nhắc mà chưa chấm công → nhắc luôn
  try {
    await checkImmediateReminders(settings);
  } catch (e) {
    console.error('Lỗi checkImmediateReminders trong initializeAlarms:', e);
  }
}

// Kiểm tra và nhắc ngay nếu đang trong khung giờ mà chưa chấm công
async function checkImmediateReminders(settings) {
  const now = new Date();
  const today = getTodayString();
  console.log(`[checkImmediate] ====== Bắt đầu kiểm tra lúc ${now.toLocaleTimeString()} (${today}) ======`);

  // Kiểm tra ngày OFF (dựa vào cột "Công" từ FastWork thay vì hardcode T7/CN)
  const isDayOff = await checkIfDayOff();
  if (isDayOff) {
    console.log('[checkImmediate] Ngày OFF, bỏ qua');
    return;
  }

  // Đọc từ storage (nhanh, không cần fetch)
  const result = await chrome.storage.local.get(['timekeepingData']);
  const data = result.timekeepingData;

  console.log('[checkImmediate] Data từ storage:', JSON.stringify(data));
  console.log('[checkImmediate] pendingNotifications:', JSON.stringify(pendingNotifications));

  const hasData = data && data.date === today && data.found;

  // Danh sách kiểm tra với effective mapping (xử lý cả case nghỉ sáng)
  const eff = hasData ? getEffectiveTimekeeping(data) : null;
  const checks = [
    { type: 'morningIn', setting: settings?.morningIn, effectiveValue: eff?.morningCheckIn },
    { type: 'noon', setting: settings?.noon, effectiveValue: eff?.morningCheckOut },
    { type: 'afternoonIn', setting: settings?.afternoonIn, effectiveValue: eff?.afternoonCheckIn },
    { type: 'evening', setting: settings?.evening, effectiveValue: eff?.afternoonCheckOut }
  ];

  if (eff) {
    console.log(`[checkImmediate] Effective: afternoonOnly=${eff.isAfternoonOnly}, morningIn=${eff.morningCheckIn}, morningOut=${eff.morningCheckOut}, afternoonIn=${eff.afternoonCheckIn}, afternoonOut=${eff.afternoonCheckOut}`);
  }

  for (const check of checks) {
    const enabled = check.setting?.enabled;
    const inTimeWindow = isTimeValidForReminder(check.type);
    const pending = pendingNotifications[check.type];
    const alreadyDone = hasData && isEffectiveDone(check.effectiveValue);

    console.log(`[checkImmediate] ${check.type}: enabled=${enabled}, inTimeWindow=${inTimeWindow}, pending=${pending}, hasData=${hasData}, alreadyDone=${alreadyDone}`);

    if (!enabled) continue;
    if (!inTimeWindow) continue;
    if (pending) continue;  // Đang nhắc rồi
    if (alreadyDone) continue;  // Đã chấm công rồi

    // CẦN NHẮC → hiển thị ngay, KHÔNG đợi fetch
    console.log(`[checkImmediate] >>> NHẮC NGAY: ${check.type} <<<`);
    pendingNotifications[check.type] = true;

    try {
      await showReminderPopup(check.type);
      console.log(`[checkImmediate] Popup ${check.type} đã hiển thị thành công`);
    } catch (e) {
      console.error(`[checkImmediate] Lỗi hiển thị popup ${check.type}:`, e);
      // Fallback: notification hệ thống
      try {
        showSystemNotification(check.type);
        console.log(`[checkImmediate] Fallback notification ${check.type} đã gửi`);
      } catch (e2) {
        console.error(`[checkImmediate] Cả fallback cũng lỗi:`, e2);
      }
    }
    startRepeatAlarm(check.type);

    // Fetch dữ liệu mới nhất ở background (không block)
    fetchTimekeepingFromFastwork().catch(e => console.log('[checkImmediate] Fetch background lỗi:', e));

    return; // Chỉ nhắc 1 loại tại 1 thời điểm (watchdog sẽ xử lý loại tiếp theo)
  }

  console.log('[checkImmediate] Không có loại nào cần nhắc lúc này');
}

// Watchdog: chạy định kỳ, kiểm tra có nhắc nhở nào bị bỏ sót
async function handleWatchdog() {
  const now = new Date();
  console.log(`[watchdog] ====== Watchdog chạy lúc ${now.toLocaleTimeString()} ======`);

  try {
    await resetForNewDay();
    const settings = await getSettings();
    console.log('[watchdog] Settings:', JSON.stringify(settings));
    await checkImmediateReminders(settings);
  } catch (e) {
    console.error('[watchdog] Lỗi:', e);
  }
}

// Tạo alarm hàng ngày
function createDailyAlarm(name, hour, minute) {
  const now = new Date();
  let alarmTime = new Date();

  alarmTime.setHours(hour, minute, 0, 0);

  if (alarmTime <= now) {
    // Giờ đã qua → kiểm tra nếu vẫn trong khung giờ hợp lệ thì kích hoạt ngay (1 phút)
    const type = name.replace('-reminder', '');
    if (isTimeValidForReminder(type)) {
      chrome.alarms.create(name, {
        delayInMinutes: 0.1,  // Kích hoạt gần như ngay lập tức
        periodInMinutes: 24 * 60
      });
      console.log(`Alarm "${name}" - giờ đã qua nhưng còn trong khung → kích hoạt ngay`);
      return;
    }
    // Ngoài khung giờ → đặt cho ngày mai
    alarmTime.setDate(alarmTime.getDate() + 1);
  }

  const delayInMinutes = (alarmTime.getTime() - now.getTime()) / (1000 * 60);

  chrome.alarms.create(name, {
    delayInMinutes: delayInMinutes,
    periodInMinutes: 24 * 60
  });

  console.log(`Alarm "${name}" được đặt lúc ${hour}:${minute.toString().padStart(2, '0')}`);
}

// Lấy cài đặt từ storage
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['reminders'], (result) => {
      if (result.reminders) {
        resolve(result.reminders);
      } else {
        chrome.storage.sync.set({ reminders: DEFAULT_REMINDERS });
        resolve(DEFAULT_REMINDERS);
      }
    });
  });
}

// Lưu cài đặt
async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ reminders: settings }, () => {
      resolve();
    });
  });
}

// Lắng nghe message
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getExtensionEnabled') {
    isExtensionEnabled().then((enabled) => {
      sendResponse({ enabled });
    });
    return true;
  }

  if (request.action === 'setExtensionEnabled') {
    chrome.storage.sync.set({ extensionEnabled: request.enabled }, async () => {
      if (request.enabled) {
        console.log('[toggle] Extension BẬT - khởi tạo lại alarms');
        await initializeAlarms();
      } else {
        console.log('[toggle] Extension TẮT - xóa alarms và dừng thông báo');
        // Xóa tất cả alarms trừ watchdog
        const allAlarms = await chrome.alarms.getAll();
        for (const alarm of allAlarms) {
          if (alarm.name !== 'watchdog') {
            await chrome.alarms.clear(alarm.name);
          }
        }
        // Reset pending notifications
        Object.keys(pendingNotifications).forEach(k => pendingNotifications[k] = false);
        // Đóng cửa sổ reminder nếu đang mở
        if (reminderWindowId) {
          try { await chrome.windows.remove(reminderWindowId); } catch (e) {}
          reminderWindowId = null;
        }
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getSettings') {
    getSettings().then((settings) => {
      sendResponse({ settings });
    });
    return true;
  }

  if (request.action === 'saveSettings') {
    saveSettings(request.settings).then(async () => {
      await initializeAlarms();
      // Kiểm tra ngay sau khi lưu - không chờ watchdog
      const settings = await getSettings();
      await checkImmediateReminders(settings);
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'testNotification') {
    pendingNotifications[request.type] = true;
    showReminderPopup(request.type);
    startRepeatAlarm(request.type);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getTimekeepingStatus') {
    chrome.storage.local.get(['timekeepingData'], (result) => {
      sendResponse({ data: result.timekeepingData || timekeepingData });
    });
    return true;
  }

  if (request.action === 'timekeepingDataUpdated') {
    timekeepingData = {
      ...request.data,
      lastUpdated: new Date().toISOString()
    };
    chrome.storage.local.set({ timekeepingData });

    // Đóng cửa sổ ẩn nếu đã nhận được dữ liệu
    if (request.data.found) {
      closeHiddenFetchWindow();
    }

    // Kiểm tra và dừng thông báo nếu đã chấm công (dùng effective mapping)
    const eff = getEffectiveTimekeeping(timekeepingData);
    if (isEffectiveDone(eff.morningCheckIn) && pendingNotifications.morningIn) {
      dismissReminder('morningIn');
    }
    if (isEffectiveDone(eff.morningCheckOut) && pendingNotifications.noon) {
      dismissReminder('noon');
    }
    if (isEffectiveDone(eff.afternoonCheckIn) && pendingNotifications.afternoonIn) {
      dismissReminder('afternoonIn');
    }
    if (isEffectiveDone(eff.afternoonCheckOut) && pendingNotifications.evening) {
      dismissReminder('evening');
    }

    // Cập nhật tần suất polling
    updatePollingFrequency();

    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'refreshTimekeeping') {
    fetchTimekeepingFromFastwork().then(() => {
      sendResponse({ data: timekeepingData });
    });
    return true;
  }

  if (request.action === 'openFastwork') {
    chrome.tabs.create({ url: FASTWORK_URL });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'dismissReminder') {
    dismissReminder(request.type);
    sendResponse({ success: true });
    return true;
  }
});
