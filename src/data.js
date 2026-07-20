/**
 * data.js
 * ------------------------------------------------------------------
 * Lớp dữ liệu KPI cho vùng Tây Nam Bộ (TNB) — đọc trực tiếp từ
 * Google Sheet công khai (Anyone with link — Viewer), qua src/googleSheets.js.
 *
 * 2 sheet nguồn:
 *   OPS_SHEET_ID — "TNB - CHỈ SỐ VẬN HÀNH": doanh thu, GTC/Ontime, OPR,
 *                   FD, tồn Aging, bưu cục bất ổn.
 *   HR_SHEET_ID  — nhân sự đang làm việc / nghỉ việc / top BC thiếu NV.
 *
 * Một số chỉ số KHÔNG có trong 2 sheet trên (không đoán/bịa số liệu):
 *   - Kế hoạch doanh thu tháng, khách hàng SME mới/đang hoạt động
 *   - Tỷ lệ chấm công, nghỉ phép/vắng mặt hôm nay, ngoại lệ chấm công
 *   - Vị trí đang tuyển, tỷ lệ giao thành công (deliverySuccessPct)
 *   - Doanh thu theo tỉnh (sheet doanh thu chỉ có tổng vùng, không tách tỉnh)
 * Các trường này trả về null/[] — public/index.html đã được ẩn card/panel
 * tương ứng, không hiển thị số liệu giả.
 * ------------------------------------------------------------------
 */

const {
  fetchSheetObjects, toNumber, parseYmdSlash, parseMdySlash, parseDmySlash, parseDdMonYy, fmtDateVN,
} = require('./googleSheets');

const OPS_SHEET_ID = '1l8aOUH7S5t2-l8hJF4a5rjve7tA6T7M1032HyPwbxjs';
const HR_SHEET_ID = '1gczNtdEGmeSjAHXJxc3EEVUb_TO2rUdO099SBUs8xlw';

const GID = {
  revenue: '549345790', // Doanh thu GTTC: Vung, Ngay(DD-Mon-YY), DoanhThu, Volume
  gtcOntime: '567744215', // Gán/GTC: Quản lý, Chi tiết, Time, GTC, %Ontime, Ontime Volume, AM, Ngay(YYYY/MM/DD), Tỉnh, Week
  opr: '674321180', // OPR: cùng cấu trúc gtcOntime nhưng có Vol LTC, %OPR
  fd: '1696138109', // FD: Quản lý, Chi tiết, Time, %vol, % Return, Ngay(M/D/YYYY), Tỉnh, Week
  aging: '86218480', // Aging>5 ngày: 1 dòng = 1 đơn tồn, snapshot hiện tại (không có lịch sử)
  unstableOffices: '1265218209', // BC bất ổn: ngay(D/M/YYYY), kho_giao_name, bl lm, bl lm >5 ngay, %bl lm >5 ngay...
};

const HR_GID = {
  active: '0', // Nhân sự còn làm việc: ID, Tên nhân viên, Chức vụ, Ngày vào làm, Trạng thái, Bưu cục, Zone, AM, Loại HĐ, Tỉnh, Vùng, Thâm niên
};

// Ngưỡng KPI vùng — do nghiệp vụ GHN quy định, không có trong sheet.
const ONTIME_TARGET_PCT = 96;
const FD_WARN_THRESHOLD_PCT = 5;
const OPR_THRESHOLD_PCT = 80;

function todayVN() {
  return new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
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

/** Trả về [{date, ...row}] đã parse ngày + sort tăng dần, bỏ dòng không parse được ngày. */
function withParsedDate(rows, dateField, parseFn) {
  return rows
    .map((r) => ({ ...r, __date: parseFn(r[dateField]) }))
    .filter((r) => r.__date)
    .sort((a, b) => a.__date - b.__date);
}

function isSameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* ======================== Doanh thu SME (Business KPI) ======================== */

async function fetchBusinessKPI() {
  const rows = await fetchSheetObjects(OPS_SHEET_ID, GID.revenue);
  const parsed = withParsedDate(rows, 'Ngay', parseDdMonYy)
    .map((r) => ({ date: r.__date, doanhThu: toNumber(r.DoanhThu) }))
    .filter((r) => r.doanhThu !== null);

  if (!parsed.length) {
    return {
      date: todayVN(), revenueToday: null, revenueDeltaDayPct: null, revenueMTD: null, growthMoMPct: null,
      revenueTargetMTD: null, revenueTargetPct: null, newCustomersToday: null, activeCustomers: null,
    };
  }

  const latest = parsed[parsed.length - 1];
  const prevDayIndex = parsed.length - 2;
  const prevDay = prevDayIndex >= 0 ? parsed[prevDayIndex] : null;

  const revenueToday = latest.doanhThu / 1e9;
  const revenueDeltaDayPct = prevDay && prevDay.doanhThu > 0
    ? ((latest.doanhThu - prevDay.doanhThu) / prevDay.doanhThu) * 100
    : null;

  const mtdRows = parsed.filter((r) => r.date.getFullYear() === latest.date.getFullYear() && r.date.getMonth() === latest.date.getMonth());
  const revenueMTDRaw = mtdRows.reduce((s, r) => s + r.doanhThu, 0);
  const revenueMTD = revenueMTDRaw / 1e9;

  const dayOfMonth = latest.date.getDate();
  const prevMonthDate = new Date(latest.date.getFullYear(), latest.date.getMonth() - 1, 1);
  const prevMonthSamePeriod = parsed.filter((r) => (
    r.date.getFullYear() === prevMonthDate.getFullYear()
    && r.date.getMonth() === prevMonthDate.getMonth()
    && r.date.getDate() <= dayOfMonth
  )).reduce((s, r) => s + r.doanhThu, 0);
  const growthMoMPct = prevMonthSamePeriod > 0
    ? ((revenueMTDRaw - prevMonthSamePeriod) / prevMonthSamePeriod) * 100
    : null;

  return {
    date: fmtDateVN(latest.date),
    revenueToday,
    revenueDeltaDayPct,
    revenueMTD,
    growthMoMPct,
    // Không có nguồn thật — dashboard đã ẩn card liên quan.
    revenueTargetMTD: null,
    revenueTargetPct: null,
    newCustomersToday: null,
    activeCustomers: null,
  };
}

/* ======================== Vận hành: GTC/Ontime + FD + Backlog ======================== */

async function fetchOperationsKPI() {
  const [gtcRows, fdRows, agingRows] = await Promise.all([
    fetchSheetObjects(OPS_SHEET_ID, GID.gtcOntime),
    fetchSheetObjects(OPS_SHEET_ID, GID.fd),
    fetchSheetObjects(OPS_SHEET_ID, GID.aging),
  ]);

  const gtcGrandTotals = withParsedDate(
    gtcRows.filter((r) => r['Chi tiết'] === 'Grand Total'),
    'Ngay',
    parseYmdSlash,
  );
  const fdGrandTotals = withParsedDate(
    fdRows.filter((r) => r['Chi tiết'] === 'Grand Total'),
    'Ngay',
    parseMdySlash,
  );

  const latestGtc = gtcGrandTotals[gtcGrandTotals.length - 1] || null;
  const prevGtc = gtcGrandTotals.length >= 2 ? gtcGrandTotals[gtcGrandTotals.length - 2] : null;
  const latestFd = fdGrandTotals[fdGrandTotals.length - 1] || null;

  const gtcTTS = latestGtc ? toNumber(latestGtc.GTC) : null;
  const prevGtcValue = prevGtc ? toNumber(prevGtc.GTC) : null;
  const gtcDeltaDayPct = gtcTTS !== null && prevGtcValue ? ((gtcTTS - prevGtcValue) / prevGtcValue) * 100 : null;
  const ontimeGtcTTSPct = latestGtc ? toNumber(latestGtc['%Ontime']) : null;
  const fdTTSPct = latestFd ? toNumber(latestFd['% Return']) : null;

  return {
    gtcTTS,
    gtcDeltaDayPct,
    ontimeGtcTTSPct,
    ontimeTargetPct: ONTIME_TARGET_PCT,
    fdTTSPct,
    fdWarnThresholdPct: FD_WARN_THRESHOLD_PCT,
    // Không có nguồn thật cho tỷ lệ giao thành công tổng — dashboard đã ẩn card này.
    deliverySuccessPct: null,
    backlogOrders: agingRows.length, // snapshot hiện tại, tab Aging chỉ có 1 mốc thời gian
    backlogDeltaDayPct: null, // không có lịch sử để so sánh
  };
}

/* ======================== Nhân sự ======================== */

async function fetchPeopleKPI() {
  const rows = await fetchSheetObjects(HR_SHEET_ID, HR_GID.active);
  const employees = rows.map((r) => ({
    employeeId: r.ID,
    name: r['Tên nhân viên'],
    jobTitle: r['Chức vụ'],
    startDate: r['Ngày vào làm'],
    endDate: r['Ngày nghỉ việc'] || '',
    status: r['Trạng thái'],
    office: r['Bưu cục'],
    zone: r.Zone,
    manager: r.AM,
    contractType: r['Loại HĐ'],
    province: r['Tỉnh'],
    region: r['Vùng'],
    tenureGroup: r['Thâm niên'],
  }));

  const activeEmployees = employees.filter((e) => e.status === 'Đang làm việc').length;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const newHiresMTD = employees.filter((e) => {
    const date = parseVietnameseDate(e.startDate);
    return date?.year === currentYear && date?.month === currentMonth;
  }).length;

  return {
    date: todayVN(),
    totalEmployees: employees.length,
    activeEmployees,
    newHiresMTD,
    headcountByProvince: summarizeBy(employees, 'province'),
    jobTitleSummary: summarizeBy(employees, 'jobTitle'),
    tenureSummary: summarizeBy(employees, 'tenureGroup'),
    employees,
    // Không có nguồn dữ liệu chấm công/nghỉ phép/tuyển dụng — dashboard đã ẩn các card/panel liên quan.
    attendanceRatePct: null,
    attendanceTargetPct: null,
    onLeaveToday: null,
    absentToday: null,
    openPositions: null,
    attendance7d: [],
    attendanceExceptions: [],
  };
}

/* ======================== Top 10 bưu cục bất ổn (rớt luân chuyển) ======================== */

async function fetchTopDropOffices() {
  const rows = await fetchSheetObjects(OPS_SHEET_ID, GID.unstableOffices);
  const parsed = rows
    .map((r) => ({
      name: r.ten_kho_cu || r.kho_giao_name,
      orders: toNumber(r['bl lm >5 ngay']),
      rate: toNumber(r['%bl lm >5 ngay']),
      blLm: toNumber(r['bl lm']),
      ngay: parseDmySlash(r.ngay),
    }))
    .filter((r) => r.name && r.orders !== null);

  const items = [...parsed].sort((a, b) => b.orders - a.orders).slice(0, 10);
  const totalOrders = parsed.reduce((s, r) => s + (r.orders || 0), 0);
  const totalBlLm = parsed.reduce((s, r) => s + (r.blLm || 0), 0);
  const grandTotalRate = totalBlLm > 0 ? +((totalOrders / totalBlLm) * 100).toFixed(1) : null;

  const latestDate = parsed.find((r) => r.ngay)?.ngay || null;

  return {
    date: fmtDateVN(latestDate) || todayVN(),
    items: items.map((it) => ({ name: it.name, orders: it.orders, rate: it.rate })),
    grandTotal: { orders: totalOrders, rate: grandTotalRate },
  };
}

/* ======================== %OPR TTS AM theo nhân viên ======================== */

async function fetchOprRanking() {
  const rows = await fetchSheetObjects(OPS_SHEET_ID, GID.opr);
  const withDate = rows
    .map((r) => ({ ...r, __date: parseYmdSlash(r.Ngay) }))
    .filter((r) => r.__date);
  if (!withDate.length) {
    return { date: todayVN(), items: [], threshold: OPR_THRESHOLD_PCT, good: 0, bad: 0, grandTotal: null };
  }

  const latestDate = withDate.reduce((max, r) => (r.__date > max ? r.__date : max), withDate[0].__date);
  const todayRows = withDate.filter((r) => isSameYMD(r.__date, latestDate));

  const grandTotalRow = todayRows.find((r) => r['Chi tiết'] === 'Grand Total');
  const grandTotal = grandTotalRow ? toNumber(grandTotalRow['%OPR']) : null;

  const perAM = new Map();
  todayRows.forEach((r) => {
    if (r['Chi tiết'] === 'Grand Total' || !r.AM) return;
    const vol = toNumber(r['Vol LTC']) || 0;
    const ontimeVol = toNumber(r['Ontime Volume']) || 0;
    const acc = perAM.get(r.AM) || { vol: 0, ontimeVol: 0 };
    acc.vol += vol;
    acc.ontimeVol += ontimeVol;
    perAM.set(r.AM, acc);
  });

  const items = [...perAM.entries()]
    .map(([name, acc]) => ({ name, pct: acc.vol > 0 ? +((acc.ontimeVol / acc.vol) * 100).toFixed(1) : null }))
    .filter((it) => it.pct !== null)
    .sort((a, b) => a.pct - b.pct);

  const good = items.filter((i) => i.pct >= OPR_THRESHOLD_PCT).length;
  const bad = items.length - good;

  return {
    date: fmtDateVN(latestDate),
    items,
    threshold: OPR_THRESHOLD_PCT,
    good,
    bad,
    grandTotal,
  };
}

/* ======================== Xu hướng 14 ngày + Ontime theo tỉnh ======================== */

async function fetchTrends() {
  const [revenueRows, gtcRows, fdRows] = await Promise.all([
    fetchSheetObjects(OPS_SHEET_ID, GID.revenue),
    fetchSheetObjects(OPS_SHEET_ID, GID.gtcOntime),
    fetchSheetObjects(OPS_SHEET_ID, GID.fd),
  ]);

  const revenueParsed = withParsedDate(revenueRows, 'Ngay', parseDdMonYy)
    .map((r) => toNumber(r.DoanhThu)).filter((v) => v !== null).map((v) => v / 1e9);
  const revenue14d = revenueParsed.slice(-14);

  const gtcGrandTotals = withParsedDate(gtcRows.filter((r) => r['Chi tiết'] === 'Grand Total'), 'Ngay', parseYmdSlash);
  const gtc14d = gtcGrandTotals.slice(-14).map((r) => toNumber(r.GTC)).filter((v) => v !== null);

  const fdGrandTotals = withParsedDate(fdRows.filter((r) => r['Chi tiết'] === 'Grand Total'), 'Ngay', parseMdySlash);
  const fd14d = fdGrandTotals.slice(-14).map((r) => toNumber(r['% Return'])).filter((v) => v !== null);

  // Ontime theo tỉnh — ngày gần nhất có dữ liệu, gộp theo Tỉnh (loại dòng Grand Total).
  const gtcWithDate = gtcRows.map((r) => ({ ...r, __date: parseYmdSlash(r.Ngay) })).filter((r) => r.__date);
  let provinces = [];
  if (gtcWithDate.length) {
    const latestDate = gtcWithDate.reduce((max, r) => (r.__date > max ? r.__date : max), gtcWithDate[0].__date);
    const todayRows = gtcWithDate.filter((r) => isSameYMD(r.__date, latestDate) && r['Chi tiết'] !== 'Grand Total' && r['Tỉnh']);
    const perProvince = new Map();
    todayRows.forEach((r) => {
      const gtc = toNumber(r.GTC) || 0;
      const ontimeVol = toNumber(r['Ontime Volume']) || 0;
      const acc = perProvince.get(r['Tỉnh']) || { gtc: 0, ontimeVol: 0 };
      acc.gtc += gtc;
      acc.ontimeVol += ontimeVol;
      perProvince.set(r['Tỉnh'], acc);
    });
    provinces = [...perProvince.entries()]
      .map(([name, acc]) => ({ name, ontime: acc.gtc > 0 ? +((acc.ontimeVol / acc.gtc) * 100).toFixed(1) : null }))
      .filter((p) => p.ontime !== null)
      .sort((a, b) => b.ontime - a.ontime);
  }

  return {
    revenue14d,
    fd14d,
    gtc14d,
    // Sheet doanh thu chỉ có tổng vùng, không tách theo tỉnh — dashboard đã ẩn chart này.
    salesByProvince: [],
    provinces,
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
