const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'noon';

const messages = {
    morningIn: { icon: '🌅', message: 'Đã 8:00 - Checkin buổi sáng đi!' },
    noon: { icon: '🌞', message: 'Đã 12:00 - Chấm công ra ăn trưa!' },
    afternoonIn: { icon: '☀️', message: 'Đã 13:30 - Checkin buổi chiều đi!' },
    evening: { icon: '🌙', message: 'Đã 17:00 - Chấm công ra về!' },
    sync: { icon: '🔄', message: 'Chưa đồng bộ dữ liệu hôm nay! Mở FastWork để cập nhật.' }
};

const content = messages[type] || messages.noon;
document.getElementById('icon').textContent = content.icon;
document.getElementById('message').textContent = content.message;

function updateTime() {
    const now = new Date();
    document.getElementById('current-time').textContent =
        now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
updateTime();
setInterval(updateTime, 1000);

// Play notification sound using Web Audio API
function playNotificationSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const beepCount = 3;
        const beepDuration = 0.15;
        const beepGap = 0.12;
        const frequency = 880;

        for (let i = 0; i < beepCount; i++) {
            const startTime = audioCtx.currentTime + i * (beepDuration + beepGap);

            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, startTime);

            // Fade in/out to avoid click noise
            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(0.7, startTime + 0.02);
            gainNode.gain.setValueAtTime(0.7, startTime + beepDuration - 0.02);
            gainNode.gain.linearRampToValueAtTime(0, startTime + beepDuration);

            oscillator.start(startTime);
            oscillator.stop(startTime + beepDuration);
        }
    } catch (e) {
        console.log('Không thể phát âm thanh:', e);
    }
}
playNotificationSound();
// Lặp lại tiếng beep mỗi 5 giây
const soundInterval = setInterval(playNotificationSound, 5000);

function stopSoundAndClose(action) {
    clearInterval(soundInterval);
    chrome.runtime.sendMessage({ action: action });
    chrome.runtime.sendMessage({ action: 'dismissReminder', type: type });
    window.close();
}

document.getElementById('open-fastwork').addEventListener('click', () => {
    stopSoundAndClose('openFastwork');
});

document.getElementById('dismiss').addEventListener('click', () => {
    clearInterval(soundInterval);
    chrome.runtime.sendMessage({ action: 'dismissReminder', type: type });
    window.close();
});

window.focus();
