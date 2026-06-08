// HMAC-signed cookie session for the widget admin panel.
// Credentials come from env: ADMIN_USER + ADMIN_PASSWORD.
// SESSION_SECRET is optional — falls back to a hash of the password.
const crypto = require('crypto');

const ADMIN_USER = process.env.ADMIN_USER || 'Admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(ADMIN_PASS || 'fallback-' + Date.now()).digest('hex');

const COOKIE_NAME = 'wgsess';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days
const ON_VERCEL = !!process.env.VERCEL;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(user) {
  const payload = { u: user, exp: Date.now() + TTL_MS };
  const data = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const c of header.split(';')) {
    const idx = c.indexOf('=');
    if (idx > 0) {
      out[c.slice(0, idx).trim()] = decodeURIComponent(c.slice(idx + 1).trim());
    }
  }
  return out;
}

function getSession(req) {
  return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function checkCredentials(user, pass) {
  if (!ADMIN_PASS) return false;
  if (typeof user !== 'string' || typeof pass !== 'string') return false;
  const userOk = user.length === ADMIN_USER.length
    && crypto.timingSafeEqual(Buffer.from(user), Buffer.from(ADMIN_USER));
  const passOk = pass.length === ADMIN_PASS.length
    && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASS));
  return userOk && passOk;
}

function setSessionCookie(res, user) {
  const token = signSession(user);
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}` + (ON_VERCEL ? '; Secure' : '');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${flags}`);
}

function clearSessionCookie(res) {
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (ON_VERCEL ? '; Secure' : '');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${flags}`);
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — please sign in to the widget console' });
  }
  return res.redirect('/widget/login');
}

module.exports = {
  ADMIN_USER, requireAuth, getSession, checkCredentials,
  setSessionCookie, clearSessionCookie
};
