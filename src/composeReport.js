/**
 * composeReport.js
 * ------------------------------------------------------------------
 * Ghép dữ liệu KPI thành nội dung tin nhắn GTalk, đúng định dạng
 * mẫu báo cáo đã cung cấp (icon 📅 🏤 🔴 🟢 📌, dòng kẻ ngang).
 * ------------------------------------------------------------------
 */

const { fetchBusinessKPI, fetchOperationsKPI, fetchTopDropOffices, fetchOprRanking } = require('./data');

function fmt(n, d = 1) {
  return Number(n).toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Báo cáo tổng quan KD & VH hằng ngày (gửi trước 9h) */
async function composeDailySummary() {
  const biz = await fetchBusinessKPI();
  const ops = await fetchOperationsKPI();
  const onTimeFlag = ops.ontimeGtcTTSPct >= ops.ontimeTargetPct ? '🟢' : '🔴';

  return [
    `📅 Ngày: ${biz.date}`,
    `📊 TỔNG QUAN KINH DOANH & VẬN HÀNH - Vùng TÂY NAM BỘ`,
    `━━━━━━━━━━`,
    `💰 Doanh thu SME hôm nay: ${fmt(biz.revenueToday)} tỷ đ (${biz.revenueDeltaDayPct >= 0 ? '▲' : '▼'}${fmt(Math.abs(biz.revenueDeltaDayPct))}%)`,
    `💰 Lũy kế tháng: ${fmt(biz.revenueMTD)} tỷ đ (${biz.growthMoMPct >= 0 ? '▲' : '▼'}${fmt(Math.abs(biz.growthMoMPct))}% so tháng trước)`,
    `📦 GTC TikTok Shop: ${ops.gtcTTS.toLocaleString('vi-VN')} đơn`,
    `${onTimeFlag} Ontime GTC TTS: ${fmt(ops.ontimeGtcTTSPct)}% (KPI ${ops.ontimeTargetPct}%)`,
    `↩️ Tỷ lệ trả hàng (FD) TTS: ${fmt(ops.fdTTSPct)}%`,
  ].join('\n');
}

/** Cảnh báo Top 10 bưu cục rớt luân chuyển TTS — đúng format mẫu gốc */
async function composeDropOfficesAlert() {
  const d = await fetchTopDropOffices();
  const lines = [
    `📅 Ngày: ${d.date}`,
    `🏤 TOP 10 BC RỚT LUÂN CHUYỂN TTS - Vùng TÂY NAM BỘ`,
  ];
  d.items.forEach((it) => lines.push(`🔴 Bưu Cục ${it.name}: ${it.orders} đơn (${fmt(it.rate)}%)`));
  lines.push(`━━━━━━━━━━`);
  lines.push(`📌 Grand Total: ${d.grandTotal.orders} đơn (${fmt(d.grandTotal.rate)}%)`);
  return lines.join('\n');
}

/** Cảnh báo tỉ lệ %OPR TTS AM theo nhân viên — đúng format mẫu gốc */
async function composeOprAlert() {
  const d = await fetchOprRanking();
  const lines = [
    `📅 Ngày: ${d.date}`,
    `🏤 TỈ LỆ %OPR TTS AM - Vùng TÂY NAM BỘ`,
  ];
  d.items.forEach((it) => {
    const flag = it.pct >= d.threshold ? '🟢' : '🔴';
    lines.push(`${flag} ${it.name}: ${fmt(it.pct)}%`);
  });
  lines.push(`Tổng: ${d.items.length} NV | 🟢 ${d.good} | 🔴 ${d.bad}`);
  lines.push(`📌 Grand Total: ${fmt(d.grandTotal)}%`);
  return lines.join('\n');
}

/** Gộp cả 3 phần thành gói cảnh báo sáng (gửi trước 9h00) */
async function composeMorningAlertBundle() {
  const [summary, dropOffices, opr] = await Promise.all([
    composeDailySummary(),
    composeDropOfficesAlert(),
    composeOprAlert(),
  ]);
  return { summary, dropOffices, opr };
}

module.exports = {
  composeDailySummary,
  composeDropOfficesAlert,
  composeOprAlert,
  composeMorningAlertBundle,
};
