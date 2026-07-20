/**
 * server.js
 * ------------------------------------------------------------------
 * Web server cho bộ TNB OPS:
 *   - Đăng nhập bằng mật khẩu truy cập chung (không dùng GHN SSO nữa).
 *   - Phục vụ dashboard tại "/" (public/index.html), dashboard gọi
 *     các API /api/kpi/* bên dưới để lấy dữ liệu — đây chính là phần
 *     "kết nối HTML với bot": dashboard không còn dùng số liệu cứng
 *     trong JS nữa, mà luôn lấy từ cùng một nguồn dữ liệu (src/data.js)
 *     với bot cảnh báo GTalk.
 *   - Webhook nhận tin nhắn inbound từ GTalk + tự động trả lời.
 *   - Cron gửi cảnh báo KPI trước 9h00 (xem scheduler.js).
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const gtalk = require('./gtalkClient');
const { composeDailySummary, composeDropOfficesAlert, composeOprAlert } = require('./composeReport');
const { fetchBusinessKPI, fetchOperationsKPI, fetchPeopleKPI, fetchTopDropOffices, fetchOprRanking, fetchTrends } = require('./data');
const { start: startScheduler, runMorningAlert } = require('./scheduler');

const WEBHOOK_SECRET = process.env.GTALK_WEBHOOK_SECRET;
const TYPING_HEARTBEAT_INTERVAL_MS = 5000;
const TYPING_HEARTBEAT_MAX_TICKS = 10;
// Mật khẩu truy cập dashboard dùng chung — nên override qua env ACCESS_PASSWORD trên Render
// thay vì dùng giá trị mặc định này, nhất là nếu repo public.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'danhtng2026';

const app = express();

app.use('/webhooks/gtalk', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.set('trust proxy', 1);
const sessionStore = new session.MemoryStore();
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-env';
if (process.env.NODE_ENV === 'production' && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET phải có ít nhất 32 ký tự trong production');
}
app.use(
  session({
    name: 'tnb_ops_sid',
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // bật true khi chạy HTTPS thật
      maxAge: 8 * 60 * 60 * 1000, // 8 giờ
    },
  })
);

const PORT = process.env.PORT || 3000;

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/* ===================== AUTH (mật khẩu truy cập chung) ===================== */

/** Chặn dashboard và API nếu chưa đăng nhập bằng mật khẩu truy cập. */
function requireAuth(req, res, next) {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLoopbackRequest = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const localBypassEnabled = process.env.DEV_BYPASS_AUTH === 'true'
    && process.env.NODE_ENV !== 'production'
    && isLoopbackRequest;
  if (localBypassEnabled) req.session.authenticated = true;

  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect('/auth/login');
}

// Trang nhập mật khẩu — phải đứng trước middleware static+requireAuth bên dưới
// để truy cập được khi chưa đăng nhập.
app.get('/auth/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/auth/login', (req, res) => {
  const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!safeEqual(submitted, ACCESS_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'Mật khẩu truy cập không chính xác' });
  }
  return req.session.regenerate((regenerateErr) => {
    if (regenerateErr) {
      console.error('[auth/login]', regenerateErr.message);
      return res.status(500).json({ ok: false, error: 'Không thể tạo phiên đăng nhập.' });
    }
    req.session.authenticated = true;
    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[auth/login]', saveErr.message);
        return res.status(500).json({ ok: false, error: 'Không thể lưu phiên đăng nhập.' });
      }
      return res.json({ ok: true });
    });
  });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tnb_ops_sid');
    res.redirect('/auth/login');
  });
});

app.get('/api/me', requireAuth, (req, res) => res.json({
  name: 'Quản trị viên TNB',
  jobtitle_name: 'Vận hành vùng Tây Nam Bộ',
}));

/* ===================== DASHBOARD (KPI API) =====================
 * Dùng chung data.js với bot GTalk — sửa số liệu ở src/data.js
 * là cả dashboard lẫn cảnh báo GTalk đều tự cập nhật theo. */

app.get('/api/kpi/summary', requireAuth, async (req, res, next) => {
  try {
    const [biz, ops] = await Promise.all([fetchBusinessKPI(), fetchOperationsKPI()]);
    res.json({ ...biz, ...ops });
  } catch (err) {
    next(err);
  }
});

app.get('/api/kpi/drop-offices', requireAuth, async (req, res, next) => {
  try {
    res.json(await fetchTopDropOffices());
  } catch (err) {
    next(err);
  }
});

app.get('/api/kpi/opr', requireAuth, async (req, res, next) => {
  try {
    res.json(await fetchOprRanking());
  } catch (err) {
    next(err);
  }
});

app.get('/api/kpi/trends', requireAuth, async (req, res, next) => {
  try {
    res.json(await fetchTrends());
  } catch (err) {
    next(err);
  }
});

app.get('/api/kpi/people', requireAuth, async (req, res, next) => {
  try {
    res.json(await fetchPeopleKPI());
  } catch (err) {
    next(err);
  }
});

/** Nút "Gửi thử cảnh báo" trên dashboard gọi endpoint này — bắn cảnh báo thật vào GTalk */
app.post('/test/send-morning-alert', requireAuth, async (req, res) => {
  try {
    await runMorningAlert();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ===================== GTALK WEBHOOK (auto-reply) ===================== */

const INTENTS = [
  { keywords: ['doanh thu', 'sme', 'kinh doanh', 'ontime', 'on time', 'gtc'], handler: composeDailySummary },
  { keywords: ['top rớt', 'rớt luân chuyển', 'top 10', 'bưu cục rớt'], handler: composeDropOfficesAlert },
  { keywords: ['opr', 'tỉ lệ opr', 'tỷ lệ opr'], handler: composeOprAlert },
];
const DEFAULT_HELP = [
  'Xin chào 👋 Tôi là Bot vận hành Vùng TNB. Bạn có thể hỏi tôi:',
  '• "doanh thu hôm nay" — tổng quan kinh doanh & vận hành',
  '• "top rớt luân chuyển" — Top 10 bưu cục rớt luân chuyển TTS',
  '• "tỷ lệ OPR" — xếp hạng %OPR TTS AM theo nhân viên',
].join('\n');

function matchIntent(text) {
  const lower = text.toLowerCase();
  const found = INTENTS.find((i) => i.keywords.some((k) => lower.includes(k)));
  return found ? found.handler : null;
}

app.post('/webhooks/gtalk', async (req, res) => {
  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-gtalk-event-signature'] || '';
    if (!gtalk.verifyWebhookSignature(req.rawBody, sig, WEBHOOK_SECRET)) {
      console.warn('[webhook] Chữ ký không hợp lệ — từ chối request');
      return res.status(401).send('invalid signature');
    }
  }

  res.status(200).send('ok');

  const { channelId, globalMsgId, content, contentType, senderId } = req.body || {};

  if (!channelId) return;

  // contentType: 0 = text, 3 = attachment
  const text = typeof content === 'string' ? content : '';
  const isAttachment = contentType === 3;

  if (!text && !isAttachment) return;

  let typingInterval;
  try {
    if (globalMsgId) {
      await gtalk.sendReceipt(channelId, globalMsgId).catch((e) => console.error('[receipt]', e.message));
    }

    let ticks = 0;
    typingInterval = setInterval(() => {
      ticks += 1;
      if (ticks >= TYPING_HEARTBEAT_MAX_TICKS) {
        clearInterval(typingInterval);
        typingInterval = null;
        return;
      }
      gtalk.sendReceipt(channelId, globalMsgId, [3]).catch(() => {});
    }, TYPING_HEARTBEAT_INTERVAL_MS);

    if (isAttachment) {
      await gtalk.sendText(channelId, 'Tôi đã nhận được file/ảnh của bạn. Hiện tại tôi chỉ hỗ trợ trả lời tin nhắn văn bản.');
    } else {
      const handler = matchIntent(text);
      const reply = handler ? await handler() : DEFAULT_HELP;
      await gtalk.sendText(channelId, reply);
    }
  } catch (err) {
    console.error('[webhook] Lỗi xử lý tin nhắn inbound:', err.message);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
});

/* ===================== STATIC DASHBOARD ===================== */

// Đặt trước middleware requireAuth bên dưới để healthcheck (Render, v.v.)
// luôn trả 200 mà không cần đăng nhập.
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Toàn bộ dashboard (public/) yêu cầu nhập mật khẩu truy cập trước khi xem.
app.use('/', requireAuth, express.static(path.join(__dirname, '..', 'public')));

// Error handler chung cho các route /api/*
app.use((err, req, res, next) => {
  console.error('[server] Lỗi:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[server] TNB OPS đang chạy tại http://localhost:${PORT}`);
  console.log(`[server] Đăng nhập tại http://localhost:${PORT}/auth/login`);
  if (process.env.DEV_BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  [server] DEV_BYPASS_AUTH=true — đăng nhập chỉ đang được bỏ qua để xem thử local.');
  }
  startScheduler();
});
