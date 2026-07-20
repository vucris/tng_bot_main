/**
 * data.js
 * ------------------------------------------------------------------
 * Lớp dữ liệu KPI cho vùng Tây Nam Bộ (TNB).
 *
 * Hiện tại trả về DỮ LIỆU DEMO (giống dashboard demo).
 * Khi tích hợp thật, thay nội dung bên trong từng hàm fetch* bằng
 * truy vấn API/DB nội bộ (SME Sales API, TTS Fulfillment API, OPR API...).
 * Không cần đổi chữ ký hàm — phần composeReport.js sẽ tự chạy đúng.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const PEOPLE_DEMO_FILE = path.join(__dirname, '..', 'data', 'people-demo.tsv');
let cachedDemoEmployees;

function todayVN() {
  return new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function normalizeText(value) {
  return String(value || '').trim().normalize('NFC');
}

function loadDemoEmployees() {
  if (cachedDemoEmployees) return cachedDemoEmployees;
  if (!fs.existsSync(PEOPLE_DEMO_FILE)) return [];

  const seenEmployeeIds = new Set();
  cachedDemoEmployees = fs.readFileSync(PEOPLE_DEMO_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const columns = line.split('\t');
      if (columns.length !== 13) {
        throw new Error(`Dữ liệu nhân sự dòng ${index + 1} có ${columns.length} cột, yêu cầu 13 cột`);
      }
      const employee = {
        employeeId: normalizeText(columns[0]),
        name: normalizeText(columns[1]),
        jobTitle: normalizeText(columns[2]),
        startDate: normalizeText(columns[3]),
        endDate: normalizeText(columns[4]),
        status: normalizeText(columns[5]),
        office: normalizeText(columns[6]),
        zone: normalizeText(columns[7]),
        manager: normalizeText(columns[8]),
        contractType: normalizeText(columns[9]),
        province: normalizeText(columns[10]),
        region: normalizeText(columns[11]),
        tenureGroup: normalizeText(columns[12]),
      };
      if (!employee.employeeId || seenEmployeeIds.has(employee.employeeId)) {
        throw new Error(`Mã nhân viên trống hoặc trùng tại dòng ${index + 1}`);
      }
      seenEmployeeIds.add(employee.employeeId);
      return employee;
    });
  return cachedDemoEmployees;
}

function parseVietnameseDate(value) {
  const match = String(value).match(/^(\d{1,2})\s+thg\s+(\d{1,2}),\s+(\d{4})$/i);
  return match ? { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) } : null;
}

function summarizeBy(items, field) {
  const counts = new Map();
  items.forEach((item) => counts.set(item[field], (counts.get(item[field]) || 0) + 1));
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'vi'));
}

/** Doanh thu SME + tăng trưởng */
async function fetchBusinessKPI() {
  // TODO: thay bằng gọi API SME Sales thật, ví dụ:
  // const res = await fetch(`${process.env.SME_API_URL}/revenue/daily?region=TNB`);
  return {
    date: todayVN(),
    revenueToday: 1.85,        // tỷ đồng
    revenueDeltaDayPct: 8.3,   // % so với hôm qua
    revenueMTD: 38.6,          // tỷ đồng, lũy kế tháng
    growthMoMPct: 12.4,        // % tăng trưởng tháng n so với n-1
    revenueTargetMTD: 45.0,    // kế hoạch doanh thu tháng
    revenueTargetPct: 85.8,    // % hoàn thành kế hoạch tháng
    newCustomersToday: 37,     // khách hàng SME mới trong ngày
    activeCustomers: 1284,
  };
}

/** GTC TTS + Ontime + FD */
async function fetchOperationsKPI() {
  // TODO: thay bằng gọi API TTS Fulfillment thật
  return {
    gtcTTS: 18450,
    gtcDeltaDayPct: 5.1,
    ontimeGtcTTSPct: 94.2,
    ontimeTargetPct: 96,
    fdTTSPct: 3.8,
    fdWarnThresholdPct: 5,
    deliverySuccessPct: 92.6,
    backlogOrders: 684,
    backlogDeltaDayPct: -6.4,
  };
}

/** Biên chế, chấm công và trạng thái nhân sự vùng */
async function fetchPeopleKPI() {
  // TODO: thay bằng HRIS/Timesheet API thật.
  const employees = loadDemoEmployees();
  const activeEmployees = employees.filter((employee) => employee.status === 'Đang làm việc').length;
  const currentDateParts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const currentYear = Number(currentDateParts.find((part) => part.type === 'year').value);
  const currentMonth = Number(currentDateParts.find((part) => part.type === 'month').value);
  const newHiresMTD = employees.filter((employee) => {
    const date = parseVietnameseDate(employee.startDate);
    return date?.year === currentYear && date?.month === currentMonth;
  }).length;

  return {
    date: todayVN(),
    totalEmployees: employees.length,
    activeEmployees,
    attendanceRatePct: 96.8,
    attendanceTargetPct: 97,
    onLeaveToday: 6,
    absentToday: 2,
    openPositions: 9,
    newHiresMTD,
    attendance7d: [96.1, 97.4, 96.9, 97.2, 96.5, 95.8, 96.8],
    headcountByProvince: summarizeBy(employees, 'province'),
    jobTitleSummary: summarizeBy(employees, 'jobTitle'),
    tenureSummary: summarizeBy(employees, 'tenureGroup'),
    employees,
    attendanceExceptions: [
      { name: 'Nguyễn Hoàng Phúc', unit: 'Kiên Giang', status: 'Nghỉ phép', shift: 'Ca sáng' },
      { name: 'Trần Minh Khoa', unit: 'Cà Mau', status: 'Nghỉ phép', shift: 'Ca chiều' },
      { name: 'Lê Thị Ngọc', unit: 'Cần Thơ', status: 'Công tác', shift: 'Hành chính' },
      { name: 'Phạm Anh Tuấn', unit: 'An Giang', status: 'Vắng mặt', shift: 'Ca sáng' },
      { name: 'Võ Thanh Hà', unit: 'Sóc Trăng', status: 'Nghỉ phép', shift: 'Hành chính' },
    ],
  };
}

/** Top 10 bưu cục rớt luân chuyển TTS */
async function fetchTopDropOffices() {
  // TODO: thay bằng truy vấn dữ liệu rớt luân chuyển thật, sắp theo orders giảm dần, lấy top 10
  return {
    date: todayVN(),
    items: [
      { name: '238 Quốc Lộ 80-Kiên Lương-Kiên Giang', orders: 56, rate: 81.2 },
      { name: 'Dương Thị Cẩm Vân-Khóm 4-Đầm Dơi-Cà Mau', orders: 13, rate: 38.2 },
      { name: 'Đường Tuyến Tránh-Phú Quốc-Kiên Giang', orders: 13, rate: 100.0 },
      { name: 'Thạnh An-An Minh-Kiên Giang', orders: 10, rate: 12.2 },
      { name: '729 Đông An-Xã Tân Hiệp-Kiên Giang', orders: 10, rate: 15.4 },
      { name: '03 Lê Lợi-An Châu-An Giang', orders: 8, rate: 2.6 },
      { name: '88 Quốc Lộ 61C-Xã Tân Hòa-Hậu Giang', orders: 5, rate: 71.4 },
      { name: 'Nguyễn Trung Thành Khóm 1-U Minh-Cà Mau', orders: 5, rate: 71.4 },
      { name: '154B Mai Thị Hồng Hạnh-Rạch Giá-Kiên Giang', orders: 4, rate: 6.2 },
      { name: 'Xã Cửa Cạn-Phú Quốc-Kiên Giang', orders: 4, rate: 40.0 },
    ],
    grandTotal: { orders: 147, rate: 2.9 },
  };
}

/** Tỉ lệ %OPR TTS AM theo nhân viên */
async function fetchOprRanking() {
  // TODO: thay bằng truy vấn API OPR Tracking thật
  const items = [
    { name: 'Chế Minh Công', pct: 41.0 },
    { name: 'Lê Minh Tú', pct: 50.0 },
    { name: 'Huỳnh Khánh Duy', pct: 63.9 },
    { name: 'Nguyễn Bình Định', pct: 70.4 },
    { name: 'Lê Thanh Tiền', pct: 73.3 },
    { name: 'Nguyễn Trọng Hậu', pct: 74.7 },
    { name: 'Đoàn Hồng Thắng', pct: 78.9 },
    { name: 'Phạm Quốc Huy', pct: 80.7 },
    { name: 'Nguyễn Phi Hùng', pct: 82.6 },
    { name: 'Nguyễn Vĩnh Tường', pct: 83.4 },
    { name: 'Phan Thanh Cần', pct: 83.6 },
    { name: 'Trần Công Sạch', pct: 89.2 },
    { name: 'Đỗ Văn Nhì', pct: 96.0 },
  ];
  const threshold = 80.0;
  const good = items.filter((i) => i.pct >= threshold).length;
  const bad = items.length - good;
  const grandTotal = +(items.reduce((s, i) => s + i.pct, 0) / items.length).toFixed(1);
  return { date: '20/06/2026', items, threshold, good, bad, grandTotal };
}

/** Chuỗi số liệu cho biểu đồ xu hướng (14 ngày) + Ontime theo tỉnh */
async function fetchTrends() {
  // TODO: thay bằng truy vấn lịch sử thật (time-series API)
  return {
    revenue14d: [1.32, 1.41, 1.38, 1.55, 1.62, 1.49, 1.58, 1.71, 1.66, 1.74, 1.69, 1.80, 1.77, 1.85],
    fd14d: [4.6, 4.4, 4.5, 4.1, 4.3, 3.9, 4.0, 3.7, 3.8, 4.2, 3.6, 3.5, 3.9, 3.8],
    gtc14d: [15820, 16140, 15980, 16620, 17110, 16840, 17280, 17560, 17320, 17810, 17640, 18120, 17980, 18450],
    salesByProvince: [
      { name: 'Cần Thơ', value: 8.7 },
      { name: 'Kiên Giang', value: 6.4 },
      { name: 'Cà Mau', value: 4.9 },
      { name: 'An Giang', value: 4.6 },
      { name: 'Sóc Trăng', value: 3.8 },
      { name: 'Đồng Tháp', value: 3.4 },
      { name: 'Hậu Giang', value: 2.7 },
      { name: 'Bạc Liêu', value: 2.3 },
      { name: 'Vĩnh Long', value: 1.8 },
    ],
    provinces: [
      { name: 'Cần Thơ', ontime: 97.1 },
      { name: 'Kiên Giang', ontime: 90.8 },
      { name: 'Cà Mau', ontime: 93.4 },
      { name: 'An Giang', ontime: 95.0 },
      { name: 'Hậu Giang', ontime: 96.6 },
      { name: 'Sóc Trăng', ontime: 97.8 },
      { name: 'Bạc Liêu', ontime: 94.9 },
      { name: 'Đồng Tháp', ontime: 91.7 },
      { name: 'Vĩnh Long', ontime: 96.2 },
    ],
  };
}

module.exports = {
  fetchBusinessKPI,
  fetchOperationsKPI,
  fetchPeopleKPI,
  fetchTopDropOffices,
  fetchOprRanking,
  fetchTrends,
};
