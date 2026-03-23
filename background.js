// Thời gian nhắc nhở mặc định (giờ:phút)
const DEFAULT_REMINDERS = {
  noon: { hour: 12, minute: 0, enabled: true },
  evening: { hour: 17, minute: 0, enabled: true }
};

// Lưu trữ các thông báo đang chờ xác nhận
let pendingNotifications = {
  noon: false,
  evening: false,
  sync: false
};

// Lưu ID popup window đang mở
let reminderWindowId = null;

// Lưu trữ dữ liệu chấm công
let timekeepingData = {
  date: null,
  found: false,
  session1: { checkIn: null, checkOut: null },
  session2: { checkIn: null, checkOut: null },
  lastUpdated: null
};

// Thời gian lặp lại thông báo (phút)
const REPEAT_INTERVAL_MINUTES = 1;

// Thời gian kiểm tra lại sau khi dismiss (phút)
const RECHECK_AFTER_DISMISS_MINUTES = 1;

// URL trang chấm công FastWork
const FASTWORK_URL = 'https://app.fastwork.vn/timekeepingpersonal#!/';

// Khởi tạo khi extension được cài đặt
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension đã được cài đặt');
  initializeAlarms();
});

// Khởi tạo khi Chrome khởi động
chrome.runtime.onStartup.addListener(() => {
  console.log('Chrome đã khởi động');
  initializeAlarms();
});

// Xử lý khi alarm được kích hoạt
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('Alarm triggered:', alarm.name);

  if (alarm.name === 'noon-reminder') {
    await handleNoonReminder();
  } else if (alarm.name === 'evening-reminder') {
    await handleEveningReminder();
  } else if (alarm.name === 'repeat-noon' && pendingNotifications.noon) {
    showReminderPopup('noon');
  } else if (alarm.name === 'repeat-evening' && pendingNotifications.evening) {
    showReminderPopup('evening');
  } else if (alarm.name === 'check-fastwork') {
    await fetchTimekeepingFromFastwork();
  } else if (alarm.name === 'check-sync') {
    await checkSyncStatus();
  } else if (alarm.name === 'repeat-sync' && pendingNotifications.sync) {
    showSyncReminderPopup();
  } else if (alarm.name === 'recheck-noon') {
    await recheckAfterDismiss('noon');
  } else if (alarm.name === 'recheck-evening') {
    await recheckAfterDismiss('evening');
  }
});

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
    pendingNotifications.noon = false;
    pendingNotifications.evening = false;
    pendingNotifications.sync = false;

    // Xóa các alarm recheck và repeat cũ
    await chrome.alarms.clear('recheck-noon');
    await chrome.alarms.clear('recheck-evening');
    await chrome.alarms.clear('repeat-noon');
    await chrome.alarms.clear('repeat-evening');
    await chrome.alarms.clear('repeat-sync');

    // Reset dữ liệu chấm công
    timekeepingData = {
      date: null,
      found: false,
      session1: { checkIn: null, checkOut: null },
      session2: { checkIn: null, checkOut: null },
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

    // Xóa notification hệ thống cũ
    chrome.notifications.clear('noon-reminder');
    chrome.notifications.clear('evening-reminder');
  }

  // Luôn cập nhật ngày hiện tại
  await chrome.storage.local.set({ lastActiveDate: today });
}

// Kiểm tra thời gian nhắc có hợp lệ cho ngày hiện tại không
function isTimeValidForReminder(type) {
  const now = new Date();
  const hour = now.getHours();

  if (type === 'noon') {
    // Chỉ nhắc buổi trưa từ 12:00 đến 13:30
    return hour >= 12 && hour < 14;
  } else if (type === 'evening') {
    // Chỉ nhắc buổi chiều từ 17:00 đến 23:59
    return hour >= 17;
  }
  return false;
}

// Xử lý nhắc nhở buổi trưa (12:00)
async function handleNoonReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  // Kiểm tra đã chấm công ra buổi sáng chưa
  if (!timekeepingData.session1.checkOut) {
    pendingNotifications.noon = true;
    showReminderPopup('noon');
    startRepeatAlarm('noon');
  } else {
    console.log('Đã chấm công ra buổi sáng, không cần nhắc');
  }
}

// Xử lý nhắc nhở buổi chiều (17:00)
async function handleEveningReminder() {
  await resetForNewDay();
  await fetchTimekeepingFromFastwork();

  // Kiểm tra đã chấm công ra buổi chiều chưa
  if (!timekeepingData.session2.checkOut) {
    pendingNotifications.evening = true;
    showReminderPopup('evening');
    startRepeatAlarm('evening');
  } else {
    console.log('Đã chấm công ra buổi chiều, không cần nhắc');
  }
}

// Hiển thị popup window nhắc nhở
async function showReminderPopup(type) {
  // Đóng popup cũ nếu có
  if (reminderWindowId) {
    try {
      await chrome.windows.remove(reminderWindowId);
    } catch (e) {
      // Window đã bị đóng
    }
  }

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
  console.log('Reminder popup created:', popup.id);

  // Cũng gửi notification hệ thống (backup)
  showSystemNotification(type);
}

// Hiển thị notification hệ thống (backup)
function showSystemNotification(type) {
  const messages = {
    noon: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 12:00 - Đừng quên chấm công ra ăn trưa!'
    },
    evening: {
      title: '⏰ Nhắc Nhở Chấm Công',
      message: 'Đã 17:00 - Đừng quên chấm công ra về!'
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

  if (notificationId.startsWith('noon')) {
    dismissReminder('noon');
  } else if (notificationId.startsWith('evening')) {
    dismissReminder('evening');
  }

  chrome.tabs.create({ url: FASTWORK_URL });
});

// Xử lý khi đóng notification
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (byUser) {
    if (notificationId.startsWith('noon')) {
      dismissReminder('noon');
    } else if (notificationId.startsWith('evening')) {
      dismissReminder('evening');
    }
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
      if (type === 'noon') {
        needReminder = !data.session1?.checkOut;
      } else if (type === 'evening') {
        needReminder = !data.session2?.checkOut;
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

// Lấy dữ liệu chấm công từ FastWork
async function fetchTimekeepingFromFastwork() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://app.fastwork.vn/*' });

    if (tabs.length > 0) {
      const response = await chrome.tabs.sendMessage(tabs[0].id, {
        action: 'getTimekeepingData'
      });

      if (response && response.found) {
        timekeepingData = {
          ...response,
          lastUpdated: new Date().toISOString()
        };
        await chrome.storage.local.set({ timekeepingData });
        console.log('Đã cập nhật dữ liệu chấm công:', timekeepingData);
      }
    }
  } catch (error) {
    console.log('Lỗi khi lấy dữ liệu:', error);
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

  const settings = await getSettings();

  // Xóa tất cả alarm cũ (bao gồm cả repeat và recheck)
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    await chrome.alarms.clear(alarm.name);
  }

  if (settings.noon.enabled) {
    createDailyAlarm('noon-reminder', settings.noon.hour, settings.noon.minute);
  }

  if (settings.evening.enabled) {
    createDailyAlarm('evening-reminder', settings.evening.hour, settings.evening.minute);
  }

  // Kiểm tra FastWork mỗi 30 phút
  chrome.alarms.create('check-fastwork', {
    delayInMinutes: 1,
    periodInMinutes: 30
  });

  // Tạo alarm kiểm tra đồng bộ lúc 13:00
  createDailyAlarm('check-sync', 13, 0);

  console.log('Alarms đã được khởi tạo');
}

// Tạo alarm hàng ngày
function createDailyAlarm(name, hour, minute) {
  const now = new Date();
  let alarmTime = new Date();

  alarmTime.setHours(hour, minute, 0, 0);

  if (alarmTime <= now) {
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
  if (request.action === 'getSettings') {
    getSettings().then((settings) => {
      sendResponse({ settings });
    });
    return true;
  }

  if (request.action === 'saveSettings') {
    saveSettings(request.settings).then(() => {
      initializeAlarms();
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

    // Kiểm tra và dừng thông báo nếu đã chấm công
    if (timekeepingData.session1.checkOut && pendingNotifications.noon) {
      dismissReminder('noon');
    }
    if (timekeepingData.session2.checkOut && pendingNotifications.evening) {
      dismissReminder('evening');
    }

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
