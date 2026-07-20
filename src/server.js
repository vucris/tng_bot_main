/**
 * server.js
 * ------------------------------------------------------------------
 * Web server cho bộ TNB OPS:
 *   - Đăng nhập bằng GHN SSO v2 (OpenID Connect) — chỉ nhân viên GHN
 *     mới xem được dashboard.
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
const sso = require('./sso');
const { composeDailySummary, composeDropOfficesAlert, composeOprAlert } = require('./composeReport');
const { fetchBusinessKPI, fetchOperationsKPI, fetchPeopleKPI, fetchTopDropOffices, fetchOprRanking, fetchTrends } = require('./data');
const { start: startScheduler, runMorningAlert } = require('./scheduler');

const WEBHOOK_SECRET = process.env.GTALK_WEBHOOK_SECRET;
const TYPING_HEARTBEAT_INTERVAL_MS = 5000;
const TYPING_HEARTBEAT_MAX_TICKS = 10;

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

function destroySession(req) {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

function destroySsoSessions({ sub, sid }) {
  return new Promise((resolve, reject) => {
    sessionStore.all((allErr, sessions) => {
      if (allErr) return reject(allErr);
      const matchingIds = Object.entries(sessions || {})
        .filter(([, storedSession]) => (
          (sid && (storedSession.ssoSid === sid || storedSession.user?.sid === sid))
          || (sub && storedSession.user?.sub === sub)
        ))
        .map(([sessionId]) => sessionId);

      if (!matchingIds.length) return resolve(0);
      let remaining = matchingIds.length;
      let firstError;
      matchingIds.forEach((sessionId) => {
        sessionStore.destroy(sessionId, (destroyErr) => {
          if (destroyErr && !firstError) firstError = destroyErr;
          remaining -= 1;
          if (remaining === 0) return firstError ? reject(firstError) : resolve(matchingIds.length);
        });
      });
    });
  });
}

/* ===================== AUTH (GHN SSO v2 / OIDC) ===================== */

/** Chặn dashboard và API nếu chưa đăng nhập qua GHN SSO. */
function requireAuth(req, res, next) {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLoopbackRequest = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const localBypassEnabled = process.env.DEV_BYPASS_AUTH === 'true'
    && process.env.NODE_ENV !== 'production'
    && isLoopbackRequest;
  if (localBypassEnabled && !req.session.user) {
    req.session.user = {
      sub: 'local-preview',
      name: 'Danh TNB',
      preferred_username: 'local-preview',
      jobtitle_name: 'Chế độ xem thử local',
      team_name: 'Vùng Tây Nam Bộ',
    };
  }
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect('/auth/login');
}

app.get('/auth/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  try {
    const { url, state, nonce, codeVerifier } = sso.buildAuthorizeUrl();
    req.session.oauthState = state;
    req.session.oauthNonce = nonce;
    req.session.oauthCodeVerifier = codeVerifier;
    return req.session.save((err) => {
      if (err) return res.status(500).send('Không thể khởi tạo phiên đăng nhập SSO.');
      return res.redirect(url);
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(503).send(`Chưa thể đăng nhập GHN SSO: ${err.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errDesc } = req.query;
    if (!safeEqual(state, req.session.oauthState)) {
      throw new Error('State không khớp — từ chối đăng nhập (chống CSRF)');
    }

    const expectedNonce = req.session.oauthNonce;
    const codeVerifier = req.session.oauthCodeVerifier;
    delete req.session.oauthState;
    delete req.session.oauthNonce;
    delete req.session.oauthCodeVerifier;
    await new Promise((resolve, reject) => req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve())));

    if (error) throw new Error(errDesc || error);
    if (!code) throw new Error('SSO không trả về authorization code');

    const tokens = await sso.exchangeCode(code, codeVerifier);
    const claims = await sso.verifyIdToken(tokens.id_token, expectedNonce);
    const profile = await sso.getUserInfo(tokens.access_token, claims.sub);

    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) {
        console.error('[auth/callback]', regenerateErr.message);
        return res.status(500).send('Không thể tạo phiên đăng nhập.');
      }
      req.session.user = { ...claims, ...profile };
      req.session.idToken = tokens.id_token;
      req.session.ssoSid = claims.sid;
      return req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[auth/callback]', saveErr.message);
          return res.status(500).send('Không thể lưu phiên đăng nhập.');
        }
        return res.redirect('/');
      });
    });
  } catch (err) {
    console.error('[auth/callback]', err.message);
    return res.status(401).send(`Đăng nhập GHN SSO thất bại: ${err.message}`);
  }
});

app.get('/auth/logout', (req, res) => {
  const idToken = req.session.idToken;
  let logoutRequest;
  try {
    logoutRequest = sso.buildLogoutUrl(idToken);
  } catch (err) {
    console.error('[auth/logout]', err.message);
    return destroySession(req).then(() => {
      res.clearCookie('tnb_ops_sid');
      return res.redirect('/auth/logged-out');
    });
  }

  req.session.user = null;
  req.session.idToken = null;
  req.session.ssoSid = null;
  req.session.logoutState = logoutRequest.state;
  return req.session.save((saveErr) => {
    if (saveErr) {
      console.error('[auth/logout]', saveErr.message);
      return destroySession(req).then(() => res.redirect('/auth/logged-out'));
    }
    return res.redirect(logoutRequest.url);
  });
});

app.get('/auth/logout/callback', async (req, res) => {
  const stateMatches = safeEqual(req.query.state, req.session.logoutState);
  await destroySession(req);
  res.clearCookie('tnb_ops_sid');
  if (!stateMatches) return res.status(400).send('Logout state không hợp lệ. Phiên cục bộ đã được huỷ.');
  return res.redirect('/auth/logged-out');
});

app.get('/auth/logged-out', (req, res) => {
  res.status(200).send(`<!doctype html><html lang="vi"><meta charset="utf-8"><title>Đã đăng xuất</title>
    <body style="font-family:system-ui;background:#060b18;color:#e9eef8;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="text-align:center"><h1>Đã đăng xuất an toàn</h1><p style="color:#8c9bb5">Phiên GHN SSO và phiên dashboard đã kết thúc.</p>
    <a href="/auth/login" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:10px;background:#ff7a1a;color:white;text-decoration:none;font-weight:700">Đăng nhập lại</a></main></body></html>`);
});

app.post('/auth/backchannel-logout', async (req, res) => {
  try {
    const claims = await sso.verifyLogoutToken(req.body?.logout_token);
    const destroyed = await destroySsoSessions({ sub: claims.sub, sid: claims.sid });
    console.log(`[auth/backchannel-logout] Đã huỷ ${destroyed} session`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('[auth/backchannel-logout]', err.message);
    return res.status(400).json({ error: 'invalid_logout_token' });
  }
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

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
// luôn trả 200 mà không cần đăng nhập SSO.
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Toàn bộ dashboard (public/) yêu cầu đăng nhập GHN SSO trước khi xem.
app.use('/', requireAuth, express.static(path.join(__dirname, '..', 'public')));

// Error handler chung cho các route /api/*
app.use((err, req, res, next) => {
  console.error('[server] Lỗi:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[server] TNB OPS đang chạy tại http://localhost:${PORT}`);
  console.log(`[server] Đăng nhập GHN SSO tại http://localhost:${PORT}/auth/login`);
  if (process.env.DEV_BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  [server] DEV_BYPASS_AUTH=true — SSO chỉ đang được bỏ qua để xem thử local.');
  }
  startScheduler();
});
