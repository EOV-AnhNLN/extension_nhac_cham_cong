// Hàm thuần dùng chung (REMINDER_TYPES, getSkipReason, getBadgeState, ...)
importScripts('logic.js');

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

// Lock để tránh tạo popup đồng thời
let isCreatingPopup = false;

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

// Khôi phục state khi service worker restart
// State tạm (popup, cửa sổ ẩn, pending) nằm ở chrome.storage.session: tự xoá khi tắt trình duyệt
async function restoreState() {
  try {
    const [session, local] = await Promise.all([
      chrome.storage.session.get(['reminderWindowId', 'pendingNotifications', 'hiddenFetchWindowId']),
      chrome.storage.local.get(['timekeepingData'])
    ]);
    if (session.reminderWindowId) {
      reminderWindowId = session.reminderWindowId;
      // Kiểm tra window còn tồn tại không
      try {
        await chrome.windows.get(reminderWindowId);
      } catch (e) {
        reminderWindowId = null;
      }
    }
    if (session.hiddenFetchWindowId) {
      hiddenFetchWindowId = session.hiddenFetchWindowId;
      try {
        await chrome.windows.get(hiddenFetchWindowId);
      } catch (e) {
        hiddenFetchWindowId = null;
      }
    }
    if (session.pendingNotifications) {
      Object.assign(pendingNotifications, session.pendingNotifications);
    }
    if (local.timekeepingData) {
      timekeepingData = local.timekeepingData;
    }
    // Dọn key cũ (bản trước lưu ở storage.local)
    await chrome.storage.local.remove(['reminderWindowId', 'pendingNotifications']);
    console.log('[restore] reminderWindowId:', reminderWindowId, 'pending:', JSON.stringify(pendingNotifications));
  } catch (e) {
    console.error('[restore] Lỗi:', e);
  }
}

// Mọi event handler phải đợi restore xong trước khi đọc state
const stateReady = restoreState();

// Lưu state vào storage
async function saveState() {
  await chrome.storage.session.set({
    reminderWindowId,
    pendingNotifications,
    hiddenFetchWindowId
  });
}

// Kích thước popup nhắc
const REMINDER_POPUP_SIZE = { width: 340, height: 280 };
const SYNC_POPUP_SIZE = { width: 340, height: 220 };

// Debounce: thời gian tối thiểu giữa 2 lần hiển thị popup cùng loại (ms)
const POPUP_DEBOUNCE_MS = 10000; // 10 giây
let lastPopupTime = {};

// Thời gian tối đa chờ cửa sổ ẩn gửi dữ liệu về (ms)
const HIDDEN_FETCH_WAIT_MS = 20000;

// URL trang chấm công FastWork
const FASTWORK_URL = 'https://app.fastwork.vn/timekeepingpersonal#!/';

// Khởi tạo khi extension được cài đặt
chrome.runtime.onInstalled.addListener(async () => {
  console.log('=== Extension đã được cài đặt/cập nhật ===');
  await stateReady;
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
chrome.runtime.onStartup.addListener(async () => {
  console.log('=== Chrome đã khởi động ===');
  await stateReady;
  initializeAlarms().catch(e => console.error('Lỗi initializeAlarms (onStartup):', e));
});

// Xử lý khi alarm được kích hoạt
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await stateReady;
  const name = alarm.name;
  console.log('Alarm triggered:', name);

  // Extension tắt → bỏ qua hết (watchdog vẫn còn để khôi phục khi bật lại)
  if (!(await isExtensionEnabled())) {
    console.log(`[alarm] Extension đang tắt, bỏ qua alarm: ${name}`);
    return;
  }

  try {
    if (name === 'watchdog') {
      await handleWatchdog();
    } else if (name === 'check-fastwork') {
      await fetchTimekeepingFromFastwork();
    } else if (name === 'check-sync' || name === 'recheck-sync') {
      await checkSyncStatus();
    } else if (name === 'repeat-sync') {
      if (pendingNotifications.sync) await showSyncReminderPopup();
    } else {
      const type = REMINDER_TYPES.find(t =>
        name === `${t}-reminder` || name === `repeat-${t}` || name === `recheck-${t}`);
      if (!type) return;
      if (name.startsWith('repeat-')) {
        await handleRepeat(type);
      } else if (name.startsWith('recheck-')) {
        await recheckAfterDismiss(type);
      } else {
        console.log(`[alarm] Kích hoạt ${name}`);
        await handleDailyReminder(type);
      }
    }
  } catch (e) {
    console.error(`[alarm] Lỗi khi xử lý ${name}:`, e);
  }
});

// Khởi chạy ngay khi service worker load (không phụ thuộc onInstalled/onStartup)
// Service worker có thể restart bất cứ lúc nào mà không trigger onInstalled/onStartup
(async () => {
  console.log('=== Service worker loaded ===');
  try {
    await stateReady;

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
      await resetForNewDay();
      await checkImmediateReminders();
    }
    await updateBadge();
  } catch (e) {
    console.error('[startup] Lỗi:', e);
  }
})();

// Cấu hình riêng của extension (trang Cài đặt nâng cao), đã gộp mặc định
async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  return normalizeConfig(config);
}

// Đọc toàn bộ dữ liệu cần để quyết định có nhắc hay không
async function loadReminderContext() {
  const [settings, config, local] = await Promise.all([
    getSettings(),
    getConfig(),
    chrome.storage.local.get(['timekeepingData', 'reminderOverrides'])
  ]);
  return {
    settings,
    config,
    data: local.timekeepingData,
    overrides: local.reminderOverrides,
    now: new Date()
  };
}

// Toạ độ popup theo cấu hình, tính theo cửa sổ trình duyệt đang dùng
async function getPopupBounds(size) {
  const { popupPosition } = await getConfig();
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const area = { left: win.left, top: win.top, width: win.width, height: win.height };
    return { ...size, ...computePopupPosition(popupPosition, area, size) };
  } catch (e) {
    // Không có cửa sổ trình duyệt nào → để Chrome tự đặt vị trí
    return { ...size };
  }
}

// Điểm kiểm tra chung cho mọi nguồn nhắc (alarm chính, lặp lại, kiểm tra lại, watchdog):
// extension bật, loại nhắc bật, không bỏ qua/tạm hoãn, trong khung giờ, không phải ngày OFF, chưa chấm
async function shouldRemind(type, ctx = null) {
  if (!(await isExtensionEnabled())) return false;
  const context = ctx || await loadReminderContext();
  const reason = getSkipReason(type, context);
  if (reason) {
    console.log(`[shouldRemind] ${type}: không nhắc (${reason})`);
  }
  return reason === null;
}

// Đọc/ghi bỏ qua & tạm hoãn của hôm nay
async function updateOverrides(mutate) {
  const { reminderOverrides } = await chrome.storage.local.get('reminderOverrides');
  const overrides = getTodayOverrides(reminderOverrides, new Date());
  if (mutate) {
    mutate(overrides);
    await chrome.storage.local.set({ reminderOverrides: overrides });
  }
  return overrides;
}

// Cập nhật badge trên icon extension
async function updateBadge() {
  try {
    const [enabled, local] = await Promise.all([
      isExtensionEnabled(),
      chrome.storage.local.get(['timekeepingData'])
    ]);
    const badge = getBadgeState({
      enabled,
      pending: pendingNotifications,
      data: local.timekeepingData,
      now: new Date()
    });
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setTitle({ title: badge.title });
  } catch (e) {
    console.log('[badge] Lỗi:', e);
  }
}

// Kiểm tra trạng thái đồng bộ (mặc định 13:00)
async function checkSyncStatus() {
  const now = new Date();
  const today = getTodayString();
  const { syncCheckEnabled, syncCheckTime } = await getConfig();
  if (!syncCheckEnabled) return;

  // Chỉ kiểm tra sau giờ cài đặt
  const syncMinutes = syncCheckTime.hour * 60 + syncCheckTime.minute;
  if (now.getHours() * 60 + now.getMinutes() >= syncMinutes) {
    // Lấy dữ liệu từ storage
    const result = await chrome.storage.local.get(['timekeepingData']);
    const data = result.timekeepingData;

    // Kiểm tra xem đã có dữ liệu của ngày hôm nay chưa
    if (!data || !data.found || data.date !== today) {
      console.log('Chưa đồng bộ dữ liệu hôm nay, nhắc nhở...');
      pendingNotifications.sync = true;
      await saveState();
      await showSyncReminderPopup();
      await startRepeatAlarm('sync');
      await updateBadge();
    } else {
      console.log('Đã có dữ liệu hôm nay:', data.date);
    }
  }
}

// Hiển thị popup nhắc đồng bộ
async function showSyncReminderPopup() {
  if (isCreatingPopup) return;
  isCreatingPopup = true;

  try {
    await closeReminderPopups();

    const popup = await chrome.windows.create({
      url: 'reminder.html?type=sync',
      type: 'popup',
      ...(await getPopupBounds(SYNC_POPUP_SIZE)),
      focused: true
    });

    reminderWindowId = popup.id;
    await saveState();
  } catch (e) {
    console.error('[popup] Không tạo được sync popup:', e);
  } finally {
    isCreatingPopup = false;
  }
}

// Reset trạng thái khi qua ngày mới
async function resetForNewDay() {
  const today = getTodayString();
  const result = await chrome.storage.local.get(['lastActiveDate']);
  const lastDate = result.lastActiveDate;

  if (lastDate && lastDate !== today) {
    console.log(`Đã qua ngày mới (${lastDate} -> ${today}), reset trạng thái`);

    // Reset pending notifications
    Object.keys(pendingNotifications).forEach(k => { pendingNotifications[k] = false; });
    await saveState();

    // Xóa các alarm recheck và repeat cũ
    for (const type of REMINDER_TYPES) {
      await chrome.alarms.clear(`recheck-${type}`);
      await chrome.alarms.clear(`repeat-${type}`);
    }
    await chrome.alarms.clear('repeat-sync');

    // Reset dữ liệu chấm công và bỏ qua/tạm hoãn của hôm qua
    timekeepingData = {
      date: null,
      found: false,
      session1: { checkIn: null, checkOut: null },
      session2: { checkIn: null, checkOut: null },
      workStatus: null,
      lastUpdated: null
    };
    await chrome.storage.local.set({ timekeepingData });
    await chrome.storage.local.remove('reminderOverrides');

    // Đóng popup nhắc nhở cũ nếu có
    await closeReminderPopups();

    // Đóng cửa sổ ẩn fetch nếu có
    closeHiddenFetchWindow();

    // Xóa notification hệ thống cũ
    for (const type of REMINDER_TYPES) {
      chrome.notifications.clear(`${type}-reminder`);
    }

    await updateBadge();
  }

  // Luôn cập nhật ngày hiện tại
  await chrome.storage.local.set({ lastActiveDate: today });
}

// Bắt đầu nhắc: hiện popup + lặp lại mỗi repeatIntervalMinutes (cấu hình)
async function startReminder(type) {
  pendingNotifications[type] = true;
  await saveState();
  await startRepeatAlarm(type);
  await showReminderPopup(type);
  await updateBadge();
}

// Dừng hẳn nhắc (đã chấm công / ngoài khung giờ / bỏ qua) và đóng popup đang kêu
async function stopReminder(type) {
  console.log(`[stop] Dừng nhắc ${type}`);
  pendingNotifications[type] = false;
  await saveState();
  await chrome.alarms.clear(`repeat-${type}`);
  await chrome.alarms.clear(`recheck-${type}`);
  chrome.notifications.clear(`${type}-reminder`);
  await closeReminderPopups(type);
  await updateBadge();
}

// Xử lý alarm nhắc chính hằng ngày
async function handleDailyReminder(type) {
  await resetForNewDay();
  if (pendingNotifications[type]) {
    console.log(`${type} đang pending, bỏ qua`);
    return;
  }
  await fetchTimekeepingFromFastwork();

  if (await shouldRemind(type)) {
    await startReminder(type);
  }
}

// Xử lý alarm lặp lại: kiểm tra lại điều kiện trước khi hiện popup
async function handleRepeat(type) {
  if (!pendingNotifications[type]) {
    await chrome.alarms.clear(`repeat-${type}`);
    return;
  }
  if (await shouldRemind(type)) {
    await showReminderPopup(type);
  } else {
    await stopReminder(type);
  }
}

// Đóng popup nhắc đang mở (tìm theo URL); type = null → đóng tất cả
async function closeReminderPopups(type = null) {
  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      if (win.type !== 'popup' || !win.tabs) continue;
      const isMatch = win.tabs.some(tab => {
        if (!tab.url || !tab.url.includes('reminder.html')) return false;
        return !type || new URL(tab.url).searchParams.get('type') === type;
      });
      if (!isMatch) continue;

      console.log(`[popup] Đóng popup cũ (tìm theo URL): windowId=${win.id}`);
      try {
        await chrome.windows.remove(win.id);
      } catch (e) { /* đã đóng */ }
      if (win.id === reminderWindowId) reminderWindowId = null;
    }
  } catch (e) {
    console.log('[popup] Lỗi khi tìm popup cũ:', e);
  }
  if (!type) reminderWindowId = null;
}

// Hiển thị popup window nhắc nhở
async function showReminderPopup(type) {
  // Lock: tránh tạo popup đồng thời từ nhiều nguồn
  if (isCreatingPopup) {
    console.log(`[popup] Đang tạo popup khác, bỏ qua ${type}`);
    return;
  }

  // Debounce: tránh tạo popup liên tục trong thời gian ngắn
  const now = Date.now();
  if (lastPopupTime[type] && (now - lastPopupTime[type]) < POPUP_DEBOUNCE_MS) {
    console.log(`[popup] Debounce ${type}: chỉ mới ${now - lastPopupTime[type]}ms từ lần trước`);
    return;
  }

  isCreatingPopup = true;
  lastPopupTime[type] = now;

  console.log(`[popup] Tạo popup cho: ${type}`);

  try {
    // Đóng TẤT CẢ popup reminder cũ (kể cả từ service worker trước)
    await closeReminderPopups();

    // Tạo popup window nhỏ gọn (vị trí theo cấu hình, mặc định góc phải trên)
    const popup = await chrome.windows.create({
      url: `reminder.html?type=${type}`,
      type: 'popup',
      ...(await getPopupBounds(REMINDER_POPUP_SIZE)),
      focused: true
    });

    reminderWindowId = popup.id;
    await saveState();
    console.log(`[popup] Popup ${type} đã tạo xong, windowId=${popup.id}`);
  } catch (e) {
    console.error(`[popup] KHÔNG TẠO ĐƯỢC POPUP ${type}:`, e);
    // Chỉ gửi notification hệ thống khi KHÔNG tạo được popup
    showSystemNotification(type);
  } finally {
    isCreatingPopup = false;
  }
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
chrome.notifications.onClicked.addListener(async (notificationId) => {
  await stateReady;
  chrome.notifications.clear(notificationId);

  const type = REMINDER_TYPES.find(t => notificationId.startsWith(t));
  if (type) await dismissReminder(type);

  chrome.tabs.create({ url: FASTWORK_URL });
});

// Xử lý khi đóng notification
chrome.notifications.onClosed.addListener(async (notificationId, byUser) => {
  if (!byUser) return;
  await stateReady;
  const type = REMINDER_TYPES.find(t => notificationId.startsWith(t));
  if (type) await dismissReminder(type);
});

// Dọn dẹp khi cửa sổ bị đóng
chrome.windows.onRemoved.addListener(async (windowId) => {
  await stateReady;
  if (windowId === reminderWindowId) {
    reminderWindowId = null;
    await saveState();
  }
  if (windowId === hiddenFetchWindowId) {
    hiddenFetchWindowId = null;
    await saveState();
  }
});

// Tạm hoãn nhắc `minutes` phút, hết hạn thì kiểm tra lại
async function snoozeReminder(type, minutes) {
  pendingNotifications[type] = false;
  await saveState();
  await chrome.alarms.clear(`repeat-${type}`);
  chrome.notifications.clear(`${type}-reminder`);

  if (type !== 'sync') {
    await updateOverrides(o => { o.snoozeUntil[type] = Date.now() + minutes * 60 * 1000; });
  }
  chrome.alarms.create(`recheck-${type}`, { delayInMinutes: minutes });
  console.log(`Tạm hoãn ${type}, sẽ kiểm tra lại sau ${minutes} phút`);
  await updateBadge();
}

// Dismiss reminder (nút OK) = tạm hoãn ngắn để kiểm tra xem đã chấm công thật chưa
async function dismissReminder(type) {
  const { recheckAfterDismissMinutes } = await getConfig();
  await snoozeReminder(type, recheckAfterDismissMinutes);
}

// Bỏ qua nhắc hôm nay (nghỉ sáng → bỏ cả checkout trưa, nghỉ chiều → bỏ cả checkout chiều)
async function skipReminderToday(type) {
  const types = SKIP_GROUPS[type] || [type];
  await updateOverrides(o => { types.forEach(t => { o.skip[t] = true; }); });
  for (const t of types) {
    await stopReminder(t);
  }
  console.log(`Bỏ qua hôm nay: ${types.join(', ')}`);
}

// Kiểm tra lại sau khi dismiss/tạm hoãn - nếu chưa chấm công thì nhắc lại
async function recheckAfterDismiss(type) {
  console.log(`Đang kiểm tra lại chấm công ${type}...`);

  // Reset trạng thái nếu đã qua ngày mới
  await resetForNewDay();

  // Hết thời gian tạm hoãn
  await updateOverrides(o => { delete o.snoozeUntil[type]; });

  if (pendingNotifications[type]) return;

  // Lấy dữ liệu mới nhất từ FastWork
  await fetchTimekeepingFromFastwork();

  if (await shouldRemind(type)) {
    console.log(`Chưa chấm công ${type}, nhắc lại!`);
    await startReminder(type);
  } else {
    console.log(`Không cần nhắc ${type} nữa`);
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

// Các lời gọi đang chờ dữ liệu từ content script (cửa sổ ẩn)
const dataWaiters = [];

// Đợi tới khi 1 waiter trong `waiters` được gọi (true) hoặc hết thời gian (false)
function waitFor(waiters, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(done);
      if (index >= 0) waiters.splice(index, 1);
      resolve(false);
    }, timeoutMs);
    function done() {
      clearTimeout(timer);
      resolve(true);
    }
    waiters.push(done);
  });
}

// Đợi content script gửi dữ liệu về (true) hoặc hết thời gian (false)
function waitForTimekeepingData(timeoutMs = HIDDEN_FETCH_WAIT_MS) {
  return waitFor(dataWaiters, timeoutMs);
}

// Tạo cửa sổ ẩn và đợi dữ liệu về
async function fetchViaHiddenWindow() {
  if (await createHiddenFetchWindow()) {
    await waitForTimekeepingData();
  }
}

// Request API chấm công mà trang FastWork gọi
const TIMESHEET_API_PATTERN = 'https://fwhrm.fastwork.vn/TimesheetMobile/*';

// Header trình duyệt tự gắn → không gửi lại qua fetch (cookie do fetch tự gửi, Origin/Referer đặt bằng DNR)
const BROWSER_MANAGED_HEADER_RE = /^(host|connection|content-length|cookie|origin|referer|user-agent|accept-encoding|accept-language|pragma|cache-control|priority|dnt|upgrade-insecure-requests|if-none-match|if-modified-since|sec-[\w-]+)$/i;

// Origin trang FastWork (dùng khi chưa học được từ request thật)
const DEFAULT_PAGE_ORIGIN = 'https://app.fastwork.vn';

// ID rule declarativeNetRequest gắn Origin/Referer cho request API của extension
const API_HEADER_RULE_ID = 1;

// Thời gian chờ tối đa khi gọi API (ms)
const API_TIMEOUT_MS = 10000;

// Các lời gọi đang chờ học được cấu hình API
const apiConfigWaiters = [];

// Học URL (companyId, email) + header xác thực từ request thật của trang FastWork
chrome.webRequest.onSendHeaders.addListener(async (details) => {
  // Bỏ qua request của chính extension và preflight CORS
  if (details.method !== 'GET') return;
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;

  const config = parseTimesheetUrl(details.url);
  if (!config) return;

  const requestHeaders = details.requestHeaders || [];
  const headers = {};
  let pageOrigin = details.initiator || null;
  let pageReferer = null;
  for (const { name, value } of requestHeaders) {
    const lower = name.toLowerCase();
    if (lower === 'origin') {
      pageOrigin = value;
    } else if (lower === 'referer') {
      pageReferer = value;
    } else if (value && !BROWSER_MANAGED_HEADER_RE.test(name)) {
      headers[name] = value;
    }
  }
  await Promise.all([
    chrome.storage.local.set({ fastworkApi: { ...config, pageOrigin, pageReferer } }),
    // Giá trị header (có thể chứa token) chỉ giữ trong bộ nhớ phiên (xoá khi tắt trình duyệt)
    chrome.storage.session.set({
      fastworkApiHeaders: headers,
      fastworkApiPageHeaderNames: requestHeaders.map(h => h.name.toLowerCase())
    })
  ]);
  console.log('[api] Đã học cấu hình API:', config, 'origin:', pageOrigin, 'headers:', Object.keys(headers));
  apiConfigWaiters.splice(0).forEach(resolve => resolve());
}, { urls: [TIMESHEET_API_PATTERN] }, ['requestHeaders', 'extraHeaders']);

// fetch() từ service worker không gửi Origin/Referer → server FastWork trả 403 "Access denied"
// Rule DNR gắn 2 header như trang FastWork, chỉ cho request ngoài tab (của extension) tới API
async function ensureApiHeaderRule(api) {
  const pageOrigin = api.pageOrigin || DEFAULT_PAGE_ORIGIN;
  const pageReferer = api.pageReferer || `${pageOrigin}/`;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [API_HEADER_RULE_ID],
    addRules: [{
      id: API_HEADER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: pageOrigin },
          { header: 'referer', operation: 'set', value: pageReferer }
        ]
      },
      condition: {
        urlFilter: `|${api.origin}/TimesheetMobile/`,
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest']
      }
    }]
  });
}

// Mở ngầm trang chấm công để trang tự gọi API → webRequest học cấu hình
async function learnApiConfig() {
  const learned = waitFor(apiConfigWaiters, HIDDEN_FETCH_WAIT_MS);
  if (!(await createHiddenFetchWindow())) return false;
  const success = await learned;
  // Học xong thì không cần cửa sổ nữa (lần sau gọi API trực tiếp)
  closeHiddenFetchWindow();
  return success;
}

// Cắt ngắn nội dung response để hiển thị khi lỗi
function snippet(text, max = 200) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// Gọi API JSON chấm công → { data } hoặc { error } (lý do lỗi để hiển thị/ghi log)
async function requestTimesheetApi() {
  const [{ fastworkApi }, { fastworkApiHeaders }] = await Promise.all([
    chrome.storage.local.get('fastworkApi'),
    chrome.storage.session.get('fastworkApiHeaders')
  ]);
  if (!fastworkApi) {
    return { error: 'Chưa có cấu hình API (cần mở trang chấm công FastWork 1 lần)' };
  }

  const now = new Date();
  const url = buildTimesheetUrl(fastworkApi, now);
  let res;
  let text;
  try {
    await ensureApiHeaderRule(fastworkApi);
  } catch (e) {
    console.log('[api] Không đặt được rule Origin/Referer:', e);
  }
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: fastworkApiHeaders || {},
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    text = await res.text();
  } catch (e) {
    return { error: `Lỗi mạng: ${e.message}`, url };
  }

  if (!res.ok) {
    // Hết phiên → bỏ header cũ, lần mở trang FastWork sau sẽ học lại
    if (res.status === 401 || res.status === 403) {
      await chrome.storage.session.remove('fastworkApiHeaders');
    }
    return { error: `HTTP ${res.status}: ${snippet(text)}`, url };
  }

  // Không dựa vào content-type: có server trả JSON với text/html hoặc text/plain
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const contentType = res.headers.get('content-type') || '?';
    return { error: `Response không phải JSON (${contentType}), có thể bị chuyển về trang đăng nhập: ${snippet(text)}`, url };
  }

  const data = parseTimesheetResponse(json, fastworkApi.email, now);
  if (!data) {
    const shape = json && typeof json === 'object' ? `keys: ${Object.keys(json).join(', ')}` : typeof json;
    return { error: `Response sai format (không có mảng "result"), ${shape}: ${snippet(text)}`, url };
  }
  return { data: { ...data, source: 'api' }, url };
}

// Gọi API JSON chấm công; null = chưa có cấu hình / lỗi → fallback đọc trang
async function fetchTimekeepingViaApi() {
  const { data, error, url } = await requestTimesheetApi();
  if (error) {
    console.log('[api] Không lấy được dữ liệu qua API:', error, url || '');
    return null;
  }
  console.log('[api] Lấy dữ liệu qua API thành công');
  return data;
}

// Fetch đang chạy (gộp các lời gọi trùng nhau để không mở nhiều cửa sổ ẩn)
let fetchInFlight = null;

// Lấy dữ liệu chấm công từ FastWork
function fetchTimekeepingFromFastwork() {
  if (!fetchInFlight) {
    fetchInFlight = doFetchTimekeeping().finally(() => { fetchInFlight = null; });
  }
  return fetchInFlight;
}

async function doFetchTimekeeping() {
  try {
    // 0. Ưu tiên gọi API JSON (không cần mở/reload tab)
    const { useApi } = await getConfig();
    const apiData = useApi ? await fetchTimekeepingViaApi() : null;
    if (apiData) {
      await onTimekeepingData(apiData);
      return;
    }

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
                  await onTimekeepingData(response);
                  return;
                }
              }
            }
          } catch (e) {
            hiddenFetchWindowId = null;
          }
        }
        // Tạo cửa sổ ẩn mới
        await fetchViaHiddenWindow();
        return;
      }

      // Tab không active (đang ở background) → navigate về đúng URL chấm công
      console.log('Navigate tab FastWork (background tab) về trang chấm công:', tab.id);
      const loaded = await ensureTimekeepingUrl(tab.id);

      if (loaded) {
        const response = await getDataFromTab(tab.id);
        if (response) {
          await onTimekeepingData(response);
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
              await onTimekeepingData(response);
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
    await fetchViaHiddenWindow();

  } catch (error) {
    console.log('Lỗi khi lấy dữ liệu:', error);
  }
}

// Nhận dữ liệu chấm công mới (từ fetch hoặc content script)
async function onTimekeepingData(data) {
  // Không ghi đè dữ liệu tốt của hôm nay bằng lần đọc lỗi (bảng chưa render xong)
  if (!data.found) {
    const { timekeepingData: stored } = await chrome.storage.local.get('timekeepingData');
    if (isTodayData(stored, new Date())) return;
  }

  timekeepingData = {
    ...data,
    lastUpdated: new Date().toISOString()
  };
  await chrome.storage.local.set({ timekeepingData });
  console.log('Đã cập nhật dữ liệu chấm công:', timekeepingData);

  if (data.found) {
    // Đóng cửa sổ ẩn nếu đã nhận dữ liệu
    closeHiddenFetchWindow();
    dataWaiters.splice(0).forEach(resolve => resolve());
  }

  // Dừng các nhắc nhở không còn cần (đã chấm công / ngày OFF / ...)
  const ctx = await loadReminderContext();
  for (const type of REMINDER_TYPES) {
    if (pendingNotifications[type] && !(await shouldRemind(type, ctx))) {
      await stopReminder(type);
    }
  }
  if (pendingNotifications.sync && isTodayData(timekeepingData, ctx.now)) {
    await stopReminder('sync');
  }

  // Cập nhật tần suất polling
  await updatePollingFrequency();
  await updateBadge();
}

// Tạo cửa sổ ẩn (minimized) để load FastWork ngầm
async function createHiddenFetchWindow() {
  // Đóng cửa sổ ẩn cũ để không bị mồ côi khi ghi đè ID
  closeHiddenFetchWindow();
  try {
    console.log('Tạo cửa sổ ẩn để fetch dữ liệu FastWork...');
    // Không truyền width/height: Chrome báo "Invalid value for state" khi kết hợp với 'minimized'
    const win = await chrome.windows.create({
      url: FASTWORK_URL,
      type: 'popup',
      state: 'minimized',
      focused: false
    });
    hiddenFetchWindowId = win.id;
    await saveState();
    console.log('Đã tạo cửa sổ ẩn:', win.id);

    // Tự động đóng sau 60 giây để tránh zombie window
    setTimeout(() => {
      if (hiddenFetchWindowId === win.id) closeHiddenFetchWindow();
    }, 60000);
    return true;
  } catch (e) {
    console.log('Không thể tạo cửa sổ ẩn:', e);
    hiddenFetchWindowId = null;
    return false;
  }
}

// Đóng cửa sổ ẩn
function closeHiddenFetchWindow() {
  if (hiddenFetchWindowId) {
    console.log('Đóng cửa sổ ẩn:', hiddenFetchWindowId);
    chrome.windows.remove(hiddenFetchWindowId).catch(() => {});
    hiddenFetchWindowId = null;
    saveState();
  }
}

// Cập nhật tần suất polling: nhanh khi đang có loại nhắc tới hạn mà chưa chấm công
async function updatePollingFrequency() {
  await chrome.alarms.clear('check-fastwork');
  if (!(await isExtensionEnabled())) return;

  // Cùng điều kiện với shouldRemind (đã tính ngày OFF, khung giờ theo cài đặt, bỏ qua/tạm hoãn)
  const ctx = await loadReminderContext();
  const dueTypes = REMINDER_TYPES.filter(type => getSkipReason(type, ctx) === null);

  const { fastPollSeconds, slowPollMinutes } = ctx.config;
  if (dueTypes.length > 0) {
    chrome.alarms.create('check-fastwork', {
      delayInMinutes: fastPollSeconds / 60,
      periodInMinutes: fastPollSeconds / 60
    });
    console.log(`Polling nhanh: mỗi ${fastPollSeconds} giây (chưa chấm: ${dueTypes.join(', ')})`);
  } else {
    chrome.alarms.create('check-fastwork', {
      delayInMinutes: slowPollMinutes,
      periodInMinutes: slowPollMinutes
    });
    console.log(`Polling bình thường: mỗi ${slowPollMinutes} phút`);
  }
}

// Bắt đầu alarm lặp lại
async function startRepeatAlarm(type) {
  const { repeatIntervalMinutes } = await getConfig();
  chrome.alarms.create(`repeat-${type}`, {
    delayInMinutes: repeatIntervalMinutes,
    periodInMinutes: repeatIntervalMinutes
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
    await updateBadge();
    return;
  }

  const [settings, config] = await Promise.all([getSettings(), getConfig()]);

  // Xóa tất cả alarm cũ (bao gồm cả repeat và recheck)
  // Loại nào còn pending sẽ được checkImmediateReminders tạo lại alarm lặp
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    await chrome.alarms.clear(alarm.name);
  }

  for (const type of REMINDER_TYPES) {
    const setting = settings[type];
    if (setting && setting.enabled) {
      createDailyAlarm(`${type}-reminder`, setting.hour, setting.minute);
    }
  }

  // Polling thông minh: nhanh khi chưa chấm công, chậm khi đã chấm (theo cấu hình)
  await updatePollingFrequency();

  // Tạo alarm kiểm tra đồng bộ (mặc định 13:00)
  if (config.syncCheckEnabled) {
    createDailyAlarm('check-sync', config.syncCheckTime.hour, config.syncCheckTime.minute);
  }

  // Watchdog: kiểm tra nhắc nhở mỗi 5 phút (backup cho trường hợp alarm chính bị miss)
  // Chrome MV3 minimum period = 1 phút
  chrome.alarms.create('watchdog', {
    delayInMinutes: 5,
    periodInMinutes: 5
  });

  console.log('Alarms đã được khởi tạo');

  // Kiểm tra ngay: nếu đang trong khung giờ nhắc mà chưa chấm công → nhắc luôn
  try {
    await checkImmediateReminders();
  } catch (e) {
    console.error('Lỗi checkImmediateReminders trong initializeAlarms:', e);
  }
  await updateBadge();
}

// Kiểm tra và nhắc ngay nếu đang trong khung giờ mà chưa chấm công
async function checkImmediateReminders() {
  // Đọc từ storage (nhanh, không cần fetch)
  const ctx = await loadReminderContext();
  console.log(`[checkImmediate] ====== Bắt đầu kiểm tra lúc ${ctx.now.toLocaleTimeString()} (${getTodayString(ctx.now)}) ======`);
  console.log('[checkImmediate] pendingNotifications:', JSON.stringify(pendingNotifications));

  for (const type of REMINDER_TYPES) {
    if (pendingNotifications[type]) {
      // Đang nhắc: đảm bảo còn alarm lặp (có thể bị xoá khi khởi tạo lại alarms)
      if (!(await chrome.alarms.get(`repeat-${type}`))) {
        console.log(`[checkImmediate] ${type} pending nhưng mất alarm lặp → tạo lại`);
        await startRepeatAlarm(type);
      }
      continue;
    }

    if (!(await shouldRemind(type, ctx))) continue;

    // CẦN NHẮC → hiển thị ngay, KHÔNG đợi fetch
    console.log(`[checkImmediate] >>> NHẮC NGAY: ${type} <<<`);
    await startReminder(type);

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
    await checkImmediateReminders();
  } catch (e) {
    console.error('[watchdog] Lỗi:', e);
  }
}

// Tạo alarm hàng ngày
function createDailyAlarm(name, hour, minute) {
  const now = new Date();
  const alarmTime = new Date();
  alarmTime.setHours(hour, minute, 0, 0);

  // Giờ đã qua → đặt ngày mai (khung giờ hiện tại do checkImmediateReminders xử lý,
  // tránh race condition tạo popup trùng)
  if (alarmTime <= now) {
    alarmTime.setDate(alarmTime.getDate() + 1);
  }

  chrome.alarms.create(name, {
    when: alarmTime.getTime(),
    periodInMinutes: 24 * 60
  });

  console.log(`Alarm "${name}" được đặt lúc ${alarmTime.toLocaleString()}`);
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

// Bật/tắt toàn bộ extension
async function setExtensionEnabled(enabled) {
  await chrome.storage.sync.set({ extensionEnabled: enabled });
  if (enabled) {
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
    Object.keys(pendingNotifications).forEach(k => { pendingNotifications[k] = false; });
    await saveState();
    // Đóng cửa sổ reminder nếu đang mở
    await closeReminderPopups();
  }
  await updateBadge();
}

// Xử lý message từ popup / reminder / content script
async function handleMessage(request) {
  await stateReady;

  switch (request.action) {
    case 'getExtensionEnabled':
      return { enabled: await isExtensionEnabled() };

    case 'setExtensionEnabled':
      await setExtensionEnabled(request.enabled);
      return { success: true };

    case 'getSettings':
      return { settings: await getSettings() };

    case 'saveSettings':
      await saveSettings(request.settings);
      // initializeAlarms đã gọi checkImmediateReminders
      await initializeAlarms();
      return { success: true };

    case 'testNotification':
      // Alarm lặp sẽ tự dừng nếu ngoài khung giờ / đã chấm công
      await startReminder(request.type);
      return { success: true };

    case 'getTimekeepingStatus': {
      const result = await chrome.storage.local.get(['timekeepingData']);
      return { data: result.timekeepingData || timekeepingData };
    }

    case 'timekeepingDataUpdated':
      await onTimekeepingData(request.data);
      return { success: true };

    case 'refreshTimekeeping': {
      await fetchTimekeepingFromFastwork();
      const result = await chrome.storage.local.get(['timekeepingData']);
      return { data: result.timekeepingData || timekeepingData };
    }

    case 'openFastwork':
      chrome.tabs.create({ url: FASTWORK_URL });
      return { success: true };

    case 'dismissReminder':
      await dismissReminder(request.type);
      return { success: true };

    case 'snoozeReminder': {
      const minutes = request.minutes || (await getConfig()).snoozeMinutes;
      await snoozeReminder(request.type, minutes);
      return { success: true };
    }

    case 'skipReminderToday':
      await skipReminderToday(request.type);
      return { success: true };

    case 'getOverrides':
      return { overrides: await updateOverrides() };

    case 'clearSkips':
      await updateOverrides(o => { o.skip = {}; });
      await checkImmediateReminders();
      return { success: true };

    case 'getConfig':
      return { config: await getConfig(), defaults: normalizeConfig(null) };

    case 'saveConfig': {
      const config = normalizeConfig(request.config);
      await chrome.storage.sync.set({ config });
      // Tạo lại alarm theo cấu hình mới (polling, lặp lại, nhắc đồng bộ)
      await initializeAlarms();
      return { success: true, config };
    }

    case 'resetConfig':
      await chrome.storage.sync.remove('config');
      await initializeAlarms();
      return { success: true, config: normalizeConfig(null) };

    case 'getApiStatus': {
      const [local, session] = await Promise.all([
        chrome.storage.local.get(['fastworkApi', 'timekeepingData']),
        chrome.storage.session.get(['fastworkApiHeaders', 'fastworkApiPageHeaderNames'])
      ]);
      const data = local.timekeepingData;
      return {
        api: local.fastworkApi || null,
        pageOrigin: (local.fastworkApi && local.fastworkApi.pageOrigin) || DEFAULT_PAGE_ORIGIN,
        headerNames: Object.keys(session.fastworkApiHeaders || {}),
        pageHeaderNames: session.fastworkApiPageHeaderNames || [],
        lastSource: data && data.found ? (data.source || 'page') : null,
        lastUpdated: (data && data.lastUpdated) || null
      };
    }

    case 'setApiConfigFromUrl': {
      const api = parseTimesheetUrl((request.url || '').trim());
      if (!api) return { success: false };
      await chrome.storage.local.set({ fastworkApi: api });
      return { success: true, api };
    }

    case 'learnApiConfig':
      return { success: await learnApiConfig() };

    case 'clearApiConfig':
      await chrome.storage.local.remove('fastworkApi');
      await chrome.storage.session.remove(['fastworkApiHeaders', 'fastworkApiPageHeaderNames']);
      return { success: true };

    case 'testApi': {
      const { data, error, url } = await requestTimesheetApi();
      if (data) await onTimekeepingData(data);
      return { success: !!data, data, error, url };
    }

    default:
      return undefined;
  }
}

// Lắng nghe message
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request)
    .then(sendResponse)
    .catch((e) => {
      console.error(`[message] Lỗi khi xử lý ${request.action}:`, e);
      sendResponse({ success: false });
    });
  return true; // Async response
});
