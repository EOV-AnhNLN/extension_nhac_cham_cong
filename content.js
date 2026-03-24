// Content script để đọc dữ liệu chấm công từ FastWork

// Hàm lấy ngày hôm nay theo định dạng DD/MM/YYYY
function getTodayString() {
    const today = new Date();
    const day = today.getDate().toString().padStart(2, '0');
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const year = today.getFullYear();
    return `${day}/${month}/${year}`;
}

// Hàm parse thời gian chấm công (ví dụ: "08:08 - 12:00" hoặc "08:08 - ___")
function parseTimekeeping(text) {
    if (!text || text.trim() === '' || text.trim() === '-') {
        return { checkIn: null, checkOut: null };
    }

    const parts = text.split('-').map(p => p.trim());
    // Kiểm tra giá trị hợp lệ (không phải rỗng, không phải chỉ có dấu gạch dưới)
    const isValid = (val) => val && val !== '' && !/^_+$/.test(val);
    return {
        checkIn: isValid(parts[0]) ? parts[0] : null,
        checkOut: isValid(parts[1]) ? parts[1] : null
    };
}

// Hàm tìm và trích xuất dữ liệu chấm công của ngày hôm nay
function extractTimekeepingData() {
    const todayStr = getTodayString();
    console.log('Đang tìm dữ liệu cho ngày:', todayStr);

    // Tìm tất cả các hàng trong bảng
    const rows = document.querySelectorAll('table tbody tr, .table tbody tr, [class*="table"] tbody tr');

    let result = {
        date: todayStr,
        found: false,
        session1: { checkIn: null, checkOut: null },
        session2: { checkIn: null, checkOut: null },
        shift: null
    };

    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 9) continue;

        // Cột ngày thường là cột thứ 2 (index 1)
        const dateCell = cells[1];
        if (!dateCell) continue;

        const dateText = dateCell.textContent.trim();

        if (dateText === todayStr) {
            result.found = true;

            // Cột "Ca làm việc" - index 7
            if (cells[7]) {
                result.shift = cells[7].textContent.trim();
            }

            // Cột "Chấm công lần 1" - index 8
            if (cells[8]) {
                result.session1 = parseTimekeeping(cells[8].textContent);
            }

            // Cột "Chấm công lần 2" - index 9
            if (cells[9]) {
                result.session2 = parseTimekeeping(cells[9].textContent);
            }

            console.log('Tìm thấy dữ liệu:', result);
            break;
        }
    }

    return result;
}

// Kiểm tra extension context còn hợp lệ không
function isExtensionValid() {
    try {
        return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
        return false;
    }
}

// Gửi message an toàn, tự dọn dẹp nếu extension đã bị invalidate
function safeSendMessage(message) {
    if (!isExtensionValid()) {
        console.log('Extension context đã mất, dừng content script');
        cleanup();
        return;
    }
    try {
        chrome.runtime.sendMessage(message);
    } catch (e) {
        console.log('Extension context invalidated, dừng content script');
        cleanup();
    }
}

// Dọn dẹp: ngắt observer và interval khi extension bị reload
function cleanup() {
    if (observer) {
        observer.disconnect();
    }
    clearTimeout(window.timekeepingDebounce);
}

// Lắng nghe message từ background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isExtensionValid()) return;
    if (request.action === 'getTimekeepingData') {
        // Đợi một chút để đảm bảo trang đã load xong
        setTimeout(() => {
            const data = extractTimekeepingData();
            sendResponse(data);
        }, 500);
        return true; // Async response
    }
});

// Tự động gửi dữ liệu khi trang load xong
window.addEventListener('load', () => {
    setTimeout(() => {
        const data = extractTimekeepingData();
        safeSendMessage({
            action: 'timekeepingDataUpdated',
            data: data
        });
    }, 2000);
});

// Theo dõi thay đổi DOM (khi AngularJS cập nhật)
const observer = new MutationObserver((mutations) => {
    // Debounce để tránh gọi quá nhiều lần
    clearTimeout(window.timekeepingDebounce);
    window.timekeepingDebounce = setTimeout(() => {
        const data = extractTimekeepingData();
        if (data.found) {
            safeSendMessage({
                action: 'timekeepingDataUpdated',
                data: data
            });
        }
    }, 1000);
});

// Bắt đầu observe sau khi trang load
setTimeout(() => {
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}, 3000);
