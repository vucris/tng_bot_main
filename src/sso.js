/**
 * sso.js
 * ------------------------------------------------------------------
 * Client OpenID Connect cho GHN SSO v2, theo đúng flow trong
 * "GHN SSO v2 — OpenID Connect Integration Guide" (file bạn đã gửi):
 *   1. buildAuthorizeUrl()  -> /oauth2/authorize (kèm state + nonce chống CSRF/replay)
 *   2. exchangeCode()       -> /oauth2/token     (client_secret_basic)
 *   3. verifyIdToken()      -> verify chữ ký qua /oauth2/jwks + check iss/aud/exp/nonce
 *   4. getUserInfo()        -> /oauth2/userinfo  (Bearer access_token)
 *   5. buildLogoutUrl()     -> /oauth2/logout    (RP-Initiated Logout)
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// .trim() vì các giá trị này thường được copy/paste vào Render dashboard,
// dễ dính khoảng trắng/newline thừa làm so sánh chuỗi (vd. audience JWT) fail âm thầm.
const SSO_BASE = (process.env.SSO_BASE_URL || 'https://dev-online-gateway.ghn.vn/sso-v2/public-api').trim();
const CLIENT_ID = (process.env.SSO_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.SSO_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.SSO_REDIRECT_URI || '').trim();
const POST_LOGOUT_REDIRECT_URI = (process.env.SSO_POST_LOGOUT_REDIRECT_URI || '').trim();
const REQUEST_TIMEOUT_MS = Number(process.env.SSO_REQUEST_TIMEOUT_MS || 10000);
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const jwks = jwksClient({
  jwksUri: `${SSO_BASE}/oauth2/jwks`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
  timeout: REQUEST_TIMEOUT_MS,
});

function assertConfigured() {
  const required = {
    SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: CLIENT_SECRET,
    SSO_REDIRECT_URI: REDIRECT_URI,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Thiếu cấu hình: ${missing.join(', ')}`);
  }

  for (const [name, value] of Object.entries({ SSO_BASE_URL: SSO_BASE, SSO_REDIRECT_URI: REDIRECT_URI })) {
    try {
      const url = new URL(value);
      if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
        throw new Error(`${name} phải dùng HTTPS trong production`);
      }
    } catch (err) {
      if (err.message.includes('phải dùng HTTPS')) throw err;
      throw new Error(`${name} không phải URL hợp lệ`);
    }
  }
}

async function fetchJson(url, options, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${context} trả về dữ liệu không hợp lệ (HTTP ${res.status})`);
      }
    }
    if (!res.ok) {
      throw new Error(json.error_description || json.error || `${context} thất bại (HTTP ${res.status})`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${context} quá thời gian chờ`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function getSigningKey(header) {
  return new Promise((resolve, reject) => {
    if (!header?.kid) return reject(new Error('Token không có kid trong header'));
    jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      const publicKey = key.getPublicKey ? key.getPublicKey() : key.publicKey || key.rsaPublicKey;
      if (!publicKey) return reject(new Error('Không lấy được public key từ JWKS'));
      return resolve(publicKey);
    });
  });
}

/** Bước 1: tạo URL đăng nhập + state/nonce random (lưu vào session, không lưu cookie thường) */
function buildAuthorizeUrl() {
  assertConfigured();
  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: `${SSO_BASE}/oauth2/authorize?${params.toString()}`, state, nonce, codeVerifier };
}

/** Bước 3: đổi authorization code lấy access_token + id_token (client_secret_basic) */
async function exchangeCode(code, codeVerifier) {
  assertConfigured();
  if (!code || !codeVerifier) throw new Error('Thiếu authorization code hoặc PKCE code_verifier');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const json = await fetchJson(`${SSO_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basic}`,
    },
    body,
  }, 'Đổi authorization code');
  if (!json.access_token || !json.id_token) throw new Error('Token response thiếu access_token hoặc id_token');
  return json; // { access_token, id_token, token_type, expires_in }
}

/** Bước 4: verify chữ ký + iss/aud/exp/nonce theo checklist trong tài liệu */
async function verifyIdToken(idToken, expectedNonce) {
  assertConfigured();
  if (!idToken || !expectedNonce) throw new Error('Thiếu ID token hoặc nonce đã lưu');
  const decodedHeader = jwt.decode(idToken, { complete: true });
  if (!decodedHeader) throw new Error('ID token không hợp lệ (không decode được)');

  const publicKey = await getSigningKey(decodedHeader.header);
  let claims;
  try {
    claims = jwt.verify(idToken, publicKey, {
      issuer: SSO_BASE,
      audience: CLIENT_ID,
      algorithms: ['RS256'],
    });
  } catch (err) {
    console.error('[sso] Verify id_token thất bại:', err.message, '— thực tế iss/aud trong token:', decodedHeader.payload?.iss, decodedHeader.payload?.aud);
    throw err;
  }

  if (typeof claims.exp !== 'number') throw new Error('ID token không có exp');
  if (!claims.sub) throw new Error('ID token không có sub');
  if (claims.nonce !== expectedNonce) {
    throw new Error('Nonce không khớp — nghi ngờ replay attack, từ chối đăng nhập');
  }
  return claims;
}

/** Bước 5: lấy thông tin nhân viên (tên, chức danh, team...) */
async function getUserInfo(accessToken, expectedSub) {
  if (!accessToken) throw new Error('Thiếu access token để gọi userinfo');
  const profile = await fetchJson(`${SSO_BASE}/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, 'Lấy thông tin người dùng');
  if (!profile.sub || (expectedSub && profile.sub !== expectedSub)) {
    throw new Error('sub trong userinfo không khớp ID token');
  }
  return profile;
}

/** Bước 6: RP-Initiated Logout — kết thúc session SSO cùng lúc với app */
function buildLogoutUrl(idToken) {
  assertConfigured();
  const state = crypto.randomBytes(32).toString('hex');
  const postLogoutRedirectUri = POST_LOGOUT_REDIRECT_URI
    || new URL('/auth/logout/callback', REDIRECT_URI).toString();
  let parsedPostLogoutUri;
  try {
    parsedPostLogoutUri = new URL(postLogoutRedirectUri);
  } catch {
    throw new Error('SSO_POST_LOGOUT_REDIRECT_URI không phải URL hợp lệ');
  }
  if (process.env.NODE_ENV === 'production' && parsedPostLogoutUri.protocol !== 'https:') {
    throw new Error('SSO_POST_LOGOUT_REDIRECT_URI phải dùng HTTPS trong production');
  }
  const params = new URLSearchParams({
    post_logout_redirect_uri: postLogoutRedirectUri,
    state,
  });
  if (idToken) params.set('id_token_hint', idToken);
  return { url: `${SSO_BASE}/oauth2/logout?${params.toString()}`, state };
}

/** Validate logout_token cho Back-Channel Logout theo OIDC. */
async function verifyLogoutToken(logoutToken) {
  assertConfigured();
  if (!logoutToken) throw new Error('Thiếu logout_token');
  const decodedHeader = jwt.decode(logoutToken, { complete: true });
  if (!decodedHeader) throw new Error('logout_token không decode được');

  const publicKey = await getSigningKey(decodedHeader.header);
  const claims = jwt.verify(logoutToken, publicKey, {
    issuer: SSO_BASE,
    audience: CLIENT_ID,
    algorithms: ['RS256'],
  });
  if (typeof claims.exp !== 'number') throw new Error('logout_token không có exp');
  if (!claims.events?.[BACKCHANNEL_LOGOUT_EVENT]) throw new Error('logout_token thiếu back-channel logout event');
  if (claims.nonce !== undefined) throw new Error('logout_token không được chứa nonce');
  if (!claims.sub && !claims.sid) throw new Error('logout_token thiếu sub và sid');
  return claims;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCode,
  verifyIdToken,
  getUserInfo,
  buildLogoutUrl,
  verifyLogoutToken,
};
