// Timestamp trong fixture là giờ Việt Nam
process.env.TZ = 'Asia/Ho_Chi_Minh';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatClock,
  parseTimesheetUrl,
  buildTimesheetUrl,
  parseTimesheetResponse,
  getEffectiveTimekeeping
} = require('../logic.js');

const EMAIL = 'user@example';

// Rút gọn từ response thật của /TimesheetMobile (chỉ giữ field extension dùng)
function sampleResponse() {
  return {
    result: [
      {
        email: EMAIL,
        data: {
          1: {
            text: 1,
            date: 1790787600000, // 01/10/2026 00:00
            isNghiLe: false,
            ca: 'HC',
            shift: [{ label: 'Hành chính' }],
            checkin: [
              { V: { datetime: 1790816387442 }, R: { datetime: 1790830842673 } }, // 07:59 - 12:00
              { V: { datetime: 1790830862075 }, R: { datetime: 1790848849033 } }  // 12:01 - 17:00
            ]
          },
          2: {
            text: 0.97,
            date: 1790874000000, // 02/10/2026 00:00
            isNghiLe: false,
            ca: 'HC',
            shift: [{ label: 'Hành chính' }],
            checkin: [
              { V: { datetime: 1790903556255 }, R: { datetime: 1790917424990 } }, // 08:12 - 12:03
              { V: { datetime: 1790917437482 }, R: { datetime: 1790935503073 } }  // 12:03 - 17:05
            ]
          }
        }
      }
    ]
  };
}

test('formatClock', () => {
  assert.equal(formatClock(1790816387442), '07:59');
  assert.equal(formatClock(1790935503073), '17:05');
});

test('parseTimesheetUrl: URL thật của trang FastWork', () => {
  const url = 'https://fwhrm.fastwork.vn/TimesheetMobile/abc123?email=user@example&from_date=1790787600000&to_date=1793379600000&web=true&report=true&view=true';
  assert.deepEqual(parseTimesheetUrl(url), {
    origin: 'https://fwhrm.fastwork.vn',
    companyId: 'abc123',
    email: 'user@example'
  });
  assert.equal(parseTimesheetUrl('https://fwhrm.fastwork.vn/Other/abc123?email=x'), null);
  assert.equal(parseTimesheetUrl('https://fwhrm.fastwork.vn/TimesheetMobile/abc123'), null);
  assert.equal(parseTimesheetUrl('not a url'), null);
});

test('buildTimesheetUrl: khoảng 00:00 hôm nay → 00:00 ngày mai', () => {
  const config = { origin: 'https://fwhrm.fastwork.vn', companyId: 'abc123', email: EMAIL };
  const url = new URL(buildTimesheetUrl(config, new Date(2026, 9, 2, 12, 30)));
  assert.equal(url.pathname, '/TimesheetMobile/abc123');
  assert.equal(url.searchParams.get('email'), EMAIL);
  assert.equal(url.searchParams.get('from_date'), '1790874000000');
  assert.equal(url.searchParams.get('to_date'), '1790960400000');
  assert.equal(url.searchParams.get('web'), 'true');
  // Đọc ngược lại được cấu hình
  assert.deepEqual(parseTimesheetUrl(url.href), config);
});

test('buildTimesheetUrl: URL học từ tháng 10 vẫn đúng sang tháng/năm sau', () => {
  // Ngày trong URL đã học bị bỏ, chỉ giữ origin/companyId/email
  const config = parseTimesheetUrl('https://fwhrm.fastwork.vn/TimesheetMobile/abc123?email=user@example&from_date=1790787600000&to_date=1793379600000');
  const range = (now) => {
    const url = new URL(buildTimesheetUrl(config, now));
    return [url.searchParams.get('from_date'), url.searchParams.get('to_date')].map(t => new Date(Number(t)).toLocaleString('vi-VN'));
  };
  assert.deepEqual(range(new Date(2026, 9, 31, 17, 0)), ['00:00:00 31/10/2026', '00:00:00 1/11/2026']);
  assert.deepEqual(range(new Date(2026, 10, 1, 8, 0)), ['00:00:00 1/11/2026', '00:00:00 2/11/2026']);
  assert.deepEqual(range(new Date(2026, 11, 31, 17, 0)), ['00:00:00 31/12/2026', '00:00:00 1/1/2027']);
});

test('parseTimesheetResponse: ngày đủ 4 lần chấm', () => {
  const data = parseTimesheetResponse(sampleResponse(), EMAIL, new Date(2026, 9, 2, 18, 0));
  assert.deepEqual(data, {
    date: '02/10/2026',
    found: true,
    session1: { checkIn: '08:12', checkOut: '12:03' },
    session2: { checkIn: '12:03', checkOut: '17:05' },
    shift: 'Hành chính',
    workStatus: '0.97'
  });
});

test('parseTimesheetResponse: đang trong ngày (mới checkin sáng)', () => {
  const json = sampleResponse();
  json.result[0].data[1].checkin = [{ V: { datetime: 1790816387442 } }];
  const data = parseTimesheetResponse(json, EMAIL, new Date(2026, 9, 1, 10, 0));
  assert.deepEqual(data.session1, { checkIn: '07:59', checkOut: null });
  assert.deepEqual(data.session2, { checkIn: null, checkOut: null });
});

test('parseTimesheetResponse: thứ tự checkin lộn xộn, nhiều hơn 2 lần', () => {
  const json = sampleResponse();
  json.result[0].data[1].checkin = [
    { V: { datetime: 1790830862075 }, R: { datetime: 1790838000000 } }, // 12:01 - 14:00
    { V: { datetime: 1790816387442 }, R: { datetime: 1790830842673 } }, // 07:59 - 12:00
    { V: { datetime: 1790841600000 }, R: { datetime: 1790848849033 } }  // 15:00 - 17:00
  ];
  const data = parseTimesheetResponse(json, EMAIL, new Date(2026, 9, 1, 18, 0));
  assert.deepEqual(data.session1, { checkIn: '07:59', checkOut: '12:00' });
  assert.deepEqual(data.session2, { checkIn: '15:00', checkOut: '17:00' });
});

test('parseTimesheetResponse: nghỉ sáng → logic nhận ra chỉ làm chiều', () => {
  const json = sampleResponse();
  json.result[0].data[1].checkin = [{ V: { datetime: 1790836200000 } }]; // 13:30
  const data = parseTimesheetResponse(json, EMAIL, new Date(2026, 9, 1, 14, 0));
  assert.equal(getEffectiveTimekeeping(data).isAfternoonOnly, true);
});

test('parseTimesheetResponse: ngày OFF / ngày lễ', () => {
  const json = sampleResponse();
  json.result[0].data[1].text = 'OFF';
  json.result[0].data[1].checkin = [];
  assert.equal(parseTimesheetResponse(json, EMAIL, new Date(2026, 9, 1, 8, 0)).workStatus, 'OFF');

  const holiday = sampleResponse();
  holiday.result[0].data[2].isNghiLe = true;
  assert.equal(parseTimesheetResponse(holiday, EMAIL, new Date(2026, 9, 2, 8, 0)).workStatus, 'OFF');
});

test('parseTimesheetResponse: không có ngày hôm nay → found=false', () => {
  const data = parseTimesheetResponse(sampleResponse(), EMAIL, new Date(2026, 9, 5, 8, 0));
  assert.equal(data.found, false);
  assert.equal(data.date, '05/10/2026');
});

test('parseTimesheetResponse: chọn đúng nhân viên theo email', () => {
  const json = sampleResponse();
  json.result.unshift({ email: 'other@example', data: { 1: { date: 1790787600000, text: 0, checkin: [] } } });
  const data = parseTimesheetResponse(json, EMAIL, new Date(2026, 9, 1, 18, 0));
  assert.equal(data.session1.checkIn, '07:59');
});

test('parseTimesheetResponse: sai format → null (để fallback)', () => {
  assert.equal(parseTimesheetResponse(null, EMAIL, new Date()), null);
  assert.equal(parseTimesheetResponse({ error: 'unauthorized' }, EMAIL, new Date()), null);
  assert.equal(parseTimesheetResponse('<html>', EMAIL, new Date()), null);
});
