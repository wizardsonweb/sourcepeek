'use strict';
// Production access. On a deployment the backend can read component source and spend AI credits, so it is closed
// unless SOURCEPEEK_ENABLE_PROD=1 AND SOURCEPEEK_TOKEN are set, and then only answers requests that carry a session:
//   • POST /__sourcepeek/auth { token } → checks the token (constant time, rate limited) and sets an HttpOnly,
//     SameSite=Strict session cookie signed with the token (HMAC-SHA256). Changing the token logs everyone out.
//   • or a header `Authorization: Bearer <token>` / `x-sourcepeek-token: <token>`, for scripts and CI.
// The dev server (vite dev, next dev, ng serve) is not affected: it already serves your source to the browser.

const crypto = require('crypto');

const COOKIE = 'sourcepeek_session';
const SESSION_HOURS = 12;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 10;
// Over this many failed attempts from everyone together, each address gets only MAX_PER_IP_BUSY tries and every
// failure waits longer. No hard global lockout: that would let one person keep everyone else from logging in.
const MAX_TOTAL = 200;
const MAX_PER_IP_BUSY = 3;

const attempts = new Map(); // ip → { n, reset }
let total = { n: 0, reset: 0 };

function header(headers, name) {
  if (!headers) return undefined;
  return typeof headers.get === 'function' ? headers.get(name) : headers[name];
}

function sign(token, exp) {
  return crypto.createHmac('sha256', token).update(`sourcepeek-session:${exp}`).digest('base64url');
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // Compare digests so the lengths always match and nothing leaks through timing.
  const hx = crypto.createHash('sha256').update(x).digest();
  const hy = crypto.createHash('sha256').update(y).digest();
  return crypto.timingSafeEqual(hx, hy) && x.length === y.length;
}

function cookies(headers) {
  const raw = String(header(headers, 'cookie') || '');
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(v);
    } catch {
      out[part.slice(0, i).trim()] = v; // a malformed %-sequence is just a value that won't validate
    }
  }
  return out;
}

function validSession(token, value) {
  const m = /^(\d{10,13})\.([\w-]{20,})$/.exec(String(value || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now())) return false;
  return sameText(sign(token, exp), m[2]);
}

/** Does this request carry a valid session cookie or the token itself? */
function authorized(token, headers) {
  if (!token) return false;
  const bearer = String(header(headers, 'authorization') || '').match(/^Bearer\s+(.+)$/i);
  const direct = header(headers, 'x-sourcepeek-token');
  if (bearer && sameText(bearer[1].trim(), token)) return true;
  if (direct && sameText(String(direct).trim(), token)) return true;
  return validSession(token, cookies(headers)[COOKIE]);
}

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127|10|192\.168)\.)/i;

/**
 * The address to rate-limit. A client can put anything at the front of X-Forwarded-For, so it is only used when the
 * connection comes from a proxy (a private address, or none known as in Next.js route handlers), and then only its
 * last entry: the one the nearest proxy added.
 */
function clientIp(remote, headers) {
  const direct = remote ? String(remote) : '';
  if (direct && !PRIVATE.test(direct)) return direct;
  const fwd = String(header(headers, 'x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fwd[fwd.length - 1] || String(header(headers, 'x-real-ip') || '').trim() || direct || 'unknown';
}

function bucket(map, key, now) {
  let a = map.get(key);
  if (!a || a.reset < now) {
    a = { n: 0, reset: now + WINDOW_MS };
    map.set(key, a);
  }
  return a;
}

/** false when this IP failed too often in the last 10 minutes (fewer tries while everyone together fails a lot). */
function allowAttempt(ip) {
  const now = Date.now();
  if (total.reset < now) total = { n: 0, reset: now + WINDOW_MS };
  if (attempts.size > 5000) attempts.clear();
  const a = bucket(attempts, ip, now);
  return a.n < (busy() ? MAX_PER_IP_BUSY : MAX_PER_IP);
}

const busy = () => total.n >= MAX_TOTAL;

function countFailure(ip) {
  const now = Date.now();
  bucket(attempts, ip, now).n++;
  total.n++;
}

function isHttps(headers, https) {
  if (https) return true;
  return /^https$/i.test(String(header(headers, 'x-forwarded-proto') || '').split(',')[0].trim());
}

function sessionCookie(token, headers, https) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const value = `${exp}.${sign(token, exp)}`;
  return `${COOKIE}=${value}; Path=/__sourcepeek; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${isHttps(headers, https) ? '; Secure' : ''}`;
}

function clearCookie(headers, https) {
  return `${COOKIE}=; Path=/__sourcepeek; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(headers, https) ? '; Secure' : ''}`;
}

/** POST /auth: returns [status, body, headers]. */
async function login(token, body, { remote, headers, https }) {
  const ip = clientIp(remote, headers);
  if (!allowAttempt(ip)) return [429, { error: 'Too many attempts. Try again in a few minutes.' }];
  const given = body && typeof body.token === 'string' ? body.token.trim() : '';
  if (!given || !sameText(given, token)) {
    countFailure(ip);
    await new Promise((r) => setTimeout(r, busy() ? 2000 : 400));
    return [401, { error: 'Wrong token.', locked: true }];
  }
  attempts.delete(ip);
  return [200, { ok: true, hours: SESSION_HOURS }, { 'Set-Cookie': sessionCookie(token, headers, https) }];
}

function logout(headers, https) {
  return [200, { ok: true }, { 'Set-Cookie': clearCookie(headers, https) }];
}

let warned = false;
/** One console line when production is opted in but can't be unlocked. */
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[sourcepeek] production backend is off: ${message}. Set SOURCEPEEK_TOKEN (16+ random characters) to use it.`);
}

module.exports = { authorized, login, logout, warnOnce, COOKIE, _sign: sign, _clientIp: clientIp, _cookies: cookies, _reset: () => (attempts.clear(), (total = { n: 0, reset: 0 })) };
