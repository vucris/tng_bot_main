/**
 * scheduler.js
 * ------------------------------------------------------------------
 * Lên lịch gửi cảnh báo KPI vùng TNB vào kênh GTalk mỗi sáng,
 * trước 9h00 (mặc định 08:30, giờ Việt Nam).
 *
 * Chạy độc lập:  node src/scheduler.js
 * Hoặc import vào server.js để chạy chung 1 process.
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const cron = require('node-cron');
const gtalk = require('./gtalkClient');
const { composeMorningAlertBundle } = require('./composeReport');
const { fetchOperationsKPI } = require('./data');

const CHANNEL_ID = process.env.GTALK_CHANNEL_ID;
const CRON_EXPR = process.env.ALERT_CRON || '30 8 * * *'; // 08:30 mỗi ngày
const TIMEZONE = 'Asia/Ho_Chi_Minh';

async function runMorningAlert() {
  if (!CHANNEL_ID) {
    console.error('[scheduler] Thiếu GTALK_CHANNEL_ID trong .env — bỏ qua gửi cảnh báo.');
    return;
  }

  try {
    const { summary, dropOffices, opr } = await composeMorningAlertBundle();

    // 1) Báo cáo tổng quan KD & VH
    await gtalk.sendText(CHANNEL_ID, summary);

    // 2) Cảnh báo Top 10 BC rớt luân chuyển TTS
    await gtalk.sendText(CHANNEL_ID, dropOffices);

    // 3) Cảnh báo %OPR TTS AM
    await gtalk.sendText(CHANNEL_ID, opr);

    // 4) Nếu Ontime GTC TTS dưới KPI, gửi thêm cảnh báo template có nút xem dashboard
    const ops = await fetchOperationsKPI();
    if (ops.ontimeGtcTTSPct < ops.ontimeTargetPct) {
      await gtalk.sendTemplate(CHANNEL_ID, {
        shortMessage: `⚠️ Ontime GTC TTS dưới KPI: ${ops.ontimeGtcTTSPct}%`,
        title: 'Cảnh báo KPI Ontime GTC TTS',
        content: `Ontime GTC TTS vùng TNB đang ở ${ops.ontimeGtcTTSPct}%, dưới mục tiêu ${ops.ontimeTargetPct}%.<br/>Vui lòng kiểm tra các bưu cục rớt luân chuyển ở tin nhắn phía trên.`,
        actions: [
          { text: 'Xem dashboard chi tiết', style: 'primary', type: 'browser_external', url: process.env.DASHBOARD_URL || 'https://example.com/tnb-dashboard' },
        ],
      });
    }

    console.log(`[scheduler] Đã gửi cảnh báo sáng lúc ${new Date().toLocaleString('vi-VN', { timeZone: TIMEZONE })}`);
  } catch (err) {
    console.error('[scheduler] Lỗi khi gửi cảnh báo:', err.message);
  }
}

function start() {
  console.log(`[scheduler] Đã lên lịch cảnh báo hằng ngày: "${CRON_EXPR}" (${TIMEZONE})`);
  cron.schedule(CRON_EXPR, runMorningAlert, { timezone: TIMEZONE });
}

module.exports = { start, runMorningAlert };

// Cho phép chạy trực tiếp: node src/scheduler.js
if (require.main === module) {
  start();
  // Bỏ comment dòng dưới để gửi thử ngay khi khởi động (test nhanh, không cần đợi lịch):
  // runMorningAlert();
}
