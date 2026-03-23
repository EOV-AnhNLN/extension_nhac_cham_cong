// DOM Elements
const noonEnabled = document.getElementById('noon-enabled');
const noonTime = document.getElementById('noon-time');
const eveningEnabled = document.getElementById('evening-enabled');
const eveningTime = document.getElementById('evening-time');
const saveBtn = document.getElementById('save-btn');
const testNoonBtn = document.getElementById('test-noon');
const testEveningBtn = document.getElementById('test-evening');
const statusEl = document.getElementById('status');
const timekeepingStatusEl = document.getElementById('timekeeping-status');
const refreshBtn = document.getElementById('refresh-btn');
const openFastworkBtn = document.getElementById('open-fastwork');

// Load khi popup mở
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadTimekeepingStatus();
});

// Lắng nghe sự kiện
saveBtn.addEventListener('click', saveSettings);
testNoonBtn.addEventListener('click', () => testNotification('noon'));
testEveningBtn.addEventListener('click', () => testNotification('evening'));
refreshBtn.addEventListener('click', refreshTimekeeping);
openFastworkBtn.addEventListener('click', openFastwork);

// Load cài đặt
function loadSettings() {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        if (response && response.settings) {
            const settings = response.settings;
            noonEnabled.checked = settings.noon.enabled;
            noonTime.value = formatTime(settings.noon.hour, settings.noon.minute);
            eveningEnabled.checked = settings.evening.enabled;
            eveningTime.value = formatTime(settings.evening.hour, settings.evening.minute);
        }
    });
}

// Load trạng thái chấm công
function loadTimekeepingStatus() {
    chrome.runtime.sendMessage({ action: 'getTimekeepingStatus' }, (response) => {
        if (response && response.data && response.data.found) {
            renderTimekeepingStatus(response.data);
        } else {
            timekeepingStatusEl.innerHTML = `
        <div class="session-row">
          <span class="session-label">Chưa có dữ liệu</span>
          <span class="session-time not-yet">Mở FastWork để đồng bộ</span>
        </div>
      `;
        }
    });
}

// Render trạng thái chấm công
function renderTimekeepingStatus(data) {
    const session1In = data.session1.checkIn || '---';
    const session1Out = data.session1.checkOut || '---';
    const session2In = data.session2.checkIn || '---';
    const session2Out = data.session2.checkOut || '---';

    const getStatusClass = (value) => {
        if (value && value !== '---') return 'done';
        return 'pending';
    };

    timekeepingStatusEl.innerHTML = `
    <div class="session-row">
      <span class="session-label">🌅 Buổi sáng</span>
      <span class="session-time ${getStatusClass(session1In)}">${session1In}</span>
      <span>→</span>
      <span class="session-time ${getStatusClass(session1Out)}">${session1Out}</span>
    </div>
    <div class="session-row">
      <span class="session-label">🌇 Buổi chiều</span>
      <span class="session-time ${getStatusClass(session2In)}">${session2In}</span>
      <span>→</span>
      <span class="session-time ${getStatusClass(session2Out)}">${session2Out}</span>
    </div>
  `;
}

// Làm mới dữ liệu
function refreshTimekeeping() {
    refreshBtn.classList.add('spinning');
    timekeepingStatusEl.innerHTML = '<div class="loading">Đang cập nhật...</div>';

    chrome.runtime.sendMessage({ action: 'refreshTimekeeping' }, (response) => {
        refreshBtn.classList.remove('spinning');
        if (response && response.data && response.data.found) {
            renderTimekeepingStatus(response.data);
            showStatus('✅ Đã cập nhật dữ liệu!', 'success');
        } else {
            timekeepingStatusEl.innerHTML = `
        <div class="session-row">
          <span class="session-label">Không thể lấy dữ liệu</span>
          <span class="session-time not-yet">Hãy mở trang FastWork</span>
        </div>
      `;
            showStatus('⚠️ Cần mở trang FastWork trước', 'error');
        }
    });
}

// Mở FastWork
function openFastwork() {
    chrome.runtime.sendMessage({ action: 'openFastwork' });
}

// Lưu cài đặt
function saveSettings() {
    const noonTimeParts = noonTime.value.split(':');
    const eveningTimeParts = eveningTime.value.split(':');

    const settings = {
        noon: {
            hour: parseInt(noonTimeParts[0]),
            minute: parseInt(noonTimeParts[1]),
            enabled: noonEnabled.checked
        },
        evening: {
            hour: parseInt(eveningTimeParts[0]),
            minute: parseInt(eveningTimeParts[1]),
            enabled: eveningEnabled.checked
        }
    };

    chrome.runtime.sendMessage({ action: 'saveSettings', settings }, (response) => {
        if (response && response.success) {
            showStatus('✅ Đã lưu cài đặt thành công!', 'success');
        } else {
            showStatus('❌ Có lỗi xảy ra!', 'error');
        }
    });
}

// Test notification
function testNotification(type) {
    chrome.runtime.sendMessage({ action: 'testNotification', type }, (response) => {
        if (response && response.success) {
            showStatus('🔔 Đã gửi thông báo test!', 'success');
        }
    });
}

// Hiển thị trạng thái
function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;

    setTimeout(() => {
        statusEl.className = 'status';
    }, 3000);
}

// Format thời gian
function formatTime(hour, minute) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}
