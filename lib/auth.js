'use strict';

/**
 * Auth: a leadership password (single shared, scrypt-hashed) and per-site
 * staff PINs.
 *
 * Sessions are **stateless signed cookies** (HMAC-SHA256), not server-side
 * memory — this is required for serverless hosts like Netlify, where each
 * request may hit a different function instance. A signing secret is kept in the
 * settings table (or REF_SESSION_SECRET) so every instance validates the same
 * tokens.
 */

const crypto = require('crypto');
const db = require('../db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (leadership)
const SITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (shared site device)

async function getSetting(key) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await db.run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

// --- Password hashing ---
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt] = stored.split(':');
  const candidate = hashPassword(password, salt);
  return candidate.length === stored.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

// --- Stateless signed tokens ---
let cachedSecret = null;
async function getSessionSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.REF_SESSION_SECRET) { cachedSecret = process.env.REF_SESSION_SECRET; return cachedSecret; }
  let s = await getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', s);
  }
  cachedSecret = s;
  return s;
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}
function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + b64url(hmac(body, secret));
}
function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(hmac(body, secret));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch (e) { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

// --- Leadership ---
async function isConfigured() {
  return !!(await getSetting('leadership_password'));
}
async function setPasswordRaw(password) {
  await setSetting('leadership_password', hashPassword(password));
}
async function ensureDefaultPassword() {
  if (!(await isConfigured())) {
    const initial = process.env.REF_LEADERSHIP_PASSWORD || 'changeme';
    await setPasswordRaw(initial);
    await setSetting('leadership_password_is_default', '1');
    return initial;
  }
  return null;
}
async function login(password) {
  const stored = await getSetting('leadership_password');
  if (!verifyPassword(password, stored)) return null;
  const secret = await getSessionSecret();
  return signToken({ r: 'admin', exp: Date.now() + SESSION_TTL_MS }, secret);
}
function logout() { /* stateless — the route clears the cookie */ }
async function isValidToken(token) {
  const secret = await getSessionSecret();
  const p = verifyToken(token, secret);
  return !!(p && p.r === 'admin');
}

// --- Per-site sign-in ---
async function setSitePin(siteId, pin) {
  const hash = pin ? hashPassword(String(pin)) : null;
  await db.run('UPDATE sites SET pin_hash = ? WHERE id = ?', [hash, siteId]);
}
async function siteHasPin(siteId) {
  const row = await db.get('SELECT pin_hash FROM sites WHERE id = ?', [siteId]);
  return !!(row && row.pin_hash);
}
async function siteLogin(siteId, pin) {
  const row = await db.get('SELECT pin_hash FROM sites WHERE id = ? AND active = 1', [siteId]);
  if (!row || !row.pin_hash) return null;
  if (!verifyPassword(String(pin || ''), row.pin_hash)) return null;
  const secret = await getSessionSecret();
  return signToken({ loc: Number(siteId), exp: Date.now() + SITE_TTL_MS }, secret);
}
function siteLogout() { /* stateless — the route clears the cookie */ }
async function siteFromToken(token) {
  const secret = await getSessionSecret();
  const p = verifyToken(token, secret);
  return p && typeof p.loc === 'number' ? p.loc : null;
}

// --- Middleware (async: token verification reads the signing secret) ---
async function requireLeadership(req, res, next) {
  try {
    const token = parseCookies(req).ref_session;
    if (token && await isValidToken(token)) { req.leadershipToken = token; return next(); }
  } catch (e) { console.error('requireLeadership:', e.message); }
  return res.status(401).json({ error: 'Not authorized' });
}
async function requireSite(req, res, next) {
  try {
    const token = parseCookies(req).ref_site;
    const loc = token ? await siteFromToken(token) : null;
    if (loc != null) { req.siteId = loc; return next(); }
  } catch (e) { console.error('requireSite:', e.message); }
  return res.status(401).json({ error: 'Please sign in to your site' });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

module.exports = {
  getSetting,
  setSetting,
  isConfigured,
  isDefaultPassword: async () => (await getSetting('leadership_password_is_default')) === '1',
  setPassword: async (pw) => {
    await setPasswordRaw(pw);
    await setSetting('leadership_password_is_default', '0');
  },
  ensureDefaultPassword,
  login,
  logout,
  isValidToken,
  requireLeadership,
  parseCookies,
  setSitePin,
  siteHasPin,
  siteLogin,
  siteLogout,
  siteFromToken,
  requireSite,
};
