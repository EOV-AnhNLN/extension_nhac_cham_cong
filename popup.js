// DOM Elements
const extensionEnabledEl = document.getElementById('extension-enabled');
const mainContent = document.getElementById('main-content');
const morningInEnabled = document.getElementById('morningIn-enabled');
const morningInTime = document.getElementById('morningIn-time');
const noonEnabled = document.getElementById('noon-enabled');
const noonTime = document.getElementById('noon-time');
const afternoonInEnabled = document.getElementById('afternoonIn-enabled');
const afternoonInTime = document.getElementById('afternoonIn-time');
const eveningEnabled = document.getElementById('evening-enabled');
const eveningTime = document.getElementById('evening-time');
const saveBtn = document.getElementById('save-btn');
const testMorningInBtn = document.getElementById('test-morningIn');
const testNoonBtn = document.getElementById('test-noon');
const testAfternoonInBtn = document.getElementById('test-afternoonIn');
const testEveningBtn = document.getElementById('test-evening');
const statusEl = document.getElementById('status');
const timekeepingStatusEl = document.getElementById('timekeeping-status');
const refreshBtn = document.getElementById('refresh-btn');
const openFastworkBtn = document.getElementById('open-fastwork');
const skipInfoEl = document.getElementById('skip-info');
const skipTextEl = document.getElementById('skip-text');
const clearSkipsBtn = document.getElementById('clear-skips');

// Tên hiển thị của từng loại nhắc
const REMINDER_LABELS = {
    morningIn: 'checkin sáng',
    noon: 'checkout trưa',
    afternoonIn: 'checkin chiều',
    evening: 'checkout chiều'
};

// Load khi popup mở
document.addEventListener('DOMContentLoaded', () => {
    loadExtensionEnabled();
    loadSettings();
    loadTimekeepingStatus();
    loadSkips();
});

// Lắng nghe sự kiện
extensionEnabledEl.addEventListener('change', toggleExtension);
saveBtn.addEventListener('click', saveSettings);
testMorningInBtn.addEventListener('click', () => testNotification('morningIn'));
testNoonBtn.addEventListener('click', () => testNotification('noon'));
testAfternoonInBtn.addEventListener('click', () => testNotification('afternoonIn'));
testEveningBtn.addEventListener('click', () => testNotification('evening'));
refreshBtn.addEventListener('click', refreshTimekeeping);
openFastworkBtn.addEventListener('click', openFastwork);
clearSkipsBtn.addEventListener('click', clearSkips);
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Load các nhắc nhở đã bỏ qua hôm nay
function loadSkips() {
    chrome.runtime.sendMessage({ action: 'getOverrides' }, (response) => {
        const skip = (response && response.overrides && response.overrides.skip) || {};
        const skippedTypes = Object.keys(REMINDER_LABELS).filter(type => skip[type]);
        if (skippedTypes.length === 0) {
            skipInfoEl.classList.remove('visible');
            return;
        }
        skipTextEl.textContent = '🏖️ Hôm nay bỏ qua: ' + skippedTypes.map(type => REMINDER_LABELS[type]).join(', ');
        skipInfoEl.classList.add('visible');
    });
}

// Bật lại các nhắc nhở đã bỏ qua hôm nay
function clearSkips() {
    chrome.runtime.sendMessage({ action: 'clearSkips' }, (response) => {
        if (response && response.success) {
            loadSkips();
            showStatus('🔔 Đã bật lại nhắc nhở hôm nay!', 'success');
        }
    });
}

// Load cài đặt
function loadSettings() {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        if (response && response.settings) {
            const settings = response.settings;
            if (settings.morningIn) {
                morningInEnabled.checked = settings.morningIn.enabled;
                morningInTime.value = formatTime(settings.morningIn.hour, settings.morningIn.minute);
            }
            noonEnabled.checked = settings.noon.enabled;
            noonTime.value = formatTime(settings.noon.hour, settings.noon.minute);
            if (settings.afternoonIn) {
                afternoonInEnabled.checked = settings.afternoonIn.enabled;
                afternoonInTime.value = formatTime(settings.afternoonIn.hour, settings.afternoonIn.minute);
            }
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
    const morningInTimeParts = morningInTime.value.split(':');
    const noonTimeParts = noonTime.value.split(':');
    const afternoonInTimeParts = afternoonInTime.value.split(':');
    const eveningTimeParts = eveningTime.value.split(':');

    const settings = {
        morningIn: {
            hour: parseInt(morningInTimeParts[0]),
            minute: parseInt(morningInTimeParts[1]),
            enabled: morningInEnabled.checked
        },
        noon: {
            hour: parseInt(noonTimeParts[0]),
            minute: parseInt(noonTimeParts[1]),
            enabled: noonEnabled.checked
        },
        afternoonIn: {
            hour: parseInt(afternoonInTimeParts[0]),
            minute: parseInt(afternoonInTimeParts[1]),
            enabled: afternoonInEnabled.checked
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

// Load trạng thái bật/tắt extension
function loadExtensionEnabled() {
    chrome.runtime.sendMessage({ action: 'getExtensionEnabled' }, (response) => {
        if (response) {
            extensionEnabledEl.checked = response.enabled;
            updateMainContentState(response.enabled);
        }
    });
}

// Bật/tắt extension
function toggleExtension() {
    const enabled = extensionEnabledEl.checked;
    chrome.runtime.sendMessage({ action: 'setExtensionEnabled', enabled }, (response) => {
        if (response && response.success) {
            updateMainContentState(enabled);
            showStatus(enabled ? '✅ Extension đã bật!' : '⏸️ Extension đã tắt!', 'success');
        }
    });
}

// Cập nhật trạng thái giao diện
function updateMainContentState(enabled) {
    if (enabled) {
        mainContent.classList.remove('disabled');
    } else {
        mainContent.classList.add('disabled');
    }
}

// Format thời gian
function formatTime(hour, minute) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}
