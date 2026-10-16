// Trang Cài đặt nâng cao: đọc/ghi cấu hình qua background (background chuẩn hoá giá trị)
// REMINDER_TYPES lấy từ logic.js

const NUMBER_FIELDS = [
    'repeatIntervalMinutes',
    'recheckAfterDismissMinutes',
    'snoozeMinutes',
    'soundIntervalSeconds',
    'fastPollSeconds',
    'slowPollMinutes'
];
const CHECKBOX_FIELDS = ['soundEnabled', 'syncCheckEnabled', 'useApi'];

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadApiStatus();
});

$('save-btn').addEventListener('click', saveConfig);
$('reset-btn').addEventListener('click', resetConfig);
$('api-url-save').addEventListener('click', setApiFromUrl);
$('api-learn').addEventListener('click', learnApi);
$('api-test').addEventListener('click', testApi);
$('api-clear').addEventListener('click', clearApi);

function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function pad(n) {
    return n.toString().padStart(2, '0');
}

// Đổ cấu hình vào form
function renderConfig(config) {
    NUMBER_FIELDS.forEach((key) => { $(key).value = config[key]; });
    CHECKBOX_FIELDS.forEach((key) => { $(key).checked = config[key]; });
    REMINDER_TYPES.forEach((type) => { $(`window-${type}`).value = config.reminderWindowMinutes[type]; });
    $('popupPosition').value = config.popupPosition;
    $('syncCheckTime').value = `${pad(config.syncCheckTime.hour)}:${pad(config.syncCheckTime.minute)}`;
    $('syncCheckTime').disabled = !config.syncCheckEnabled;
    $('soundIntervalSeconds').disabled = !config.soundEnabled;
}

// Đọc form (giá trị thô, background sẽ ép về giới hạn hợp lệ)
function readForm() {
    const config = {};
    NUMBER_FIELDS.forEach((key) => { config[key] = $(key).value; });
    CHECKBOX_FIELDS.forEach((key) => { config[key] = $(key).checked; });
    config.reminderWindowMinutes = {};
    REMINDER_TYPES.forEach((type) => { config.reminderWindowMinutes[type] = $(`window-${type}`).value; });
    config.popupPosition = $('popupPosition').value;
    const [hour, minute] = ($('syncCheckTime').value || '').split(':');
    config.syncCheckTime = { hour, minute };
    return config;
}

$('syncCheckEnabled').addEventListener('change', (e) => { $('syncCheckTime').disabled = !e.target.checked; });
$('soundEnabled').addEventListener('change', (e) => { $('soundIntervalSeconds').disabled = !e.target.checked; });

async function loadConfig() {
    const response = await sendMessage({ action: 'getConfig' });
    if (response && response.config) renderConfig(response.config);
}

async function saveConfig() {
    const response = await sendMessage({ action: 'saveConfig', config: readForm() });
    if (response && response.success) {
        // Hiện lại giá trị đã chuẩn hoá (VD: nhập 10 giây polling → 30)
        renderConfig(response.config);
        showStatus('✅ Đã lưu cấu hình!', 'success');
    } else {
        showStatus('❌ Không lưu được cấu hình', 'error');
    }
}

async function resetConfig() {
    if (!confirm('Khôi phục toàn bộ cài đặt nâng cao về mặc định?')) return;
    const response = await sendMessage({ action: 'resetConfig' });
    if (response && response.success) {
        renderConfig(response.config);
        showStatus('↺ Đã khôi phục mặc định', 'success');
    }
}

// Trạng thái cấu hình API đã học
async function loadApiStatus() {
    const status = await sendMessage({ action: 'getApiStatus' });
    if (!status) return;
    $('api-company').textContent = status.api ? status.api.companyId : 'chưa có';
    $('api-email').textContent = status.api ? status.api.email : 'chưa có';
    $('api-origin').textContent = status.pageOrigin;
    $('api-headers').textContent = status.headerNames.length ? status.headerNames.join(', ') : 'không có (dùng cookie)';
    $('api-page-headers').textContent = status.pageHeaderNames.length ? status.pageHeaderNames.join(', ') : 'chưa thấy';

    if (status.lastUpdated) {
        const source = status.lastSource === 'api' ? 'API' : status.lastSource === 'page' ? 'đọc trang' : 'không tìm thấy';
        $('api-last').textContent = `${new Date(status.lastUpdated).toLocaleString('vi-VN')} (${source})`;
    } else {
        $('api-last').textContent = 'chưa có';
    }
}

async function setApiFromUrl() {
    const response = await sendMessage({ action: 'setApiConfigFromUrl', url: $('api-url').value });
    if (response && response.success) {
        $('api-url').value = '';
        await loadApiStatus();
        showStatus('✅ Đã lưu cấu hình API', 'success');
    } else {
        showStatus('❌ URL không đúng dạng .../TimesheetMobile/<mã>?email=...', 'error');
    }
}

// Mở ngầm trang chấm công FastWork để học cấu hình API
async function learnApi() {
    $('api-learn').disabled = true;
    showStatus('⏳ Đang kết nối FastWork (mở ngầm trang chấm công)...', 'success');
    const response = await sendMessage({ action: 'learnApiConfig' });
    $('api-learn').disabled = false;
    await loadApiStatus();
    if (response && response.success) {
        showStatus('✅ Đã kết nối FastWork', 'success');
    } else {
        showStatus('❌ Không kết nối được: kiểm tra đã đăng nhập FastWork chưa, hoặc nhập URL thủ công', 'error');
    }
}

async function testApi() {
    $('api-test').disabled = true;
    showStatus('⏳ Đang gọi API...', 'success');
    const response = await sendMessage({ action: 'testApi' });
    $('api-test').disabled = false;
    await loadApiStatus();
    if (response && response.success) {
        const d = response.data;
        const show = (v) => v || '---';
        const detail = d.found
            ? `Sáng ${show(d.session1.checkIn)} → ${show(d.session1.checkOut)}, chiều ${show(d.session2.checkIn)} → ${show(d.session2.checkOut)}`
            : 'API chạy nhưng không có dòng hôm nay';
        showStatus(`✅ API OK: ${detail}`, 'success');
    } else {
        const reason = (response && response.error) || 'không rõ lý do';
        showStatus(`❌ Gọi API thất bại: ${reason}`, 'error', 0);
    }
}

async function clearApi() {
    if (!confirm('Quên mã công ty, email và header đã học? Tiện ích sẽ học lại khi bạn mở trang FastWork.')) return;
    await sendMessage({ action: 'clearApiConfig' });
    await loadApiStatus();
    showStatus('🗑️ Đã xoá cấu hình API', 'success');
}

// durationMs = 0 → giữ thông báo cho tới lần sau (để đọc/copy lỗi)
let statusTimer = null;
function showStatus(message, type, durationMs = 5000) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
    clearTimeout(statusTimer);
    if (durationMs > 0) {
        statusTimer = setTimeout(() => { statusEl.className = 'status'; }, durationMs);
    }
}
