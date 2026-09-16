const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');

const COOKIE = 'gp_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s === 'change-me') throw new Error('SESSION_SECRET is not set');
  return s;
};

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

const sign = (data) =>
  crypto.createHmac('sha256', secret()).update(data).digest('base64url');

// Stateless session: "<userId>.<expiryMs>.<hmac>". No session store needed, which is
// what makes this work on serverless where memory doesn't survive between requests.
function makeToken(userId) {
  const data = `${userId}.${Date.now() + MAX_AGE_MS}`;
  return `${data}.${sign(data)}`;
}

function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expiry, mac] = parts;
  const expected = sign(`${id}.${expiry}`);
  // Length check first: timingSafeEqual throws on mismatched buffer lengths.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (!Number(expiry) || Number(expiry) < Date.now()) return null;
  return Number(id) || null;
}

function setSession(res, userId) {
  res.cookie(COOKIE, makeToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

// Attaches req.user (never including password_hash) or 401s.
async function requireAuth(req, res, next) {
  try {
    const userId = readToken(req.cookies?.[COOKIE]);
    if (!userId) return res.status(401).json({ error: 'Not logged in' });
    const { rows } = await query(
      'SELECT id, username, display_name, avatar_emoji, is_admin FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Not logged in' });
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, setSession, clearSession,
  requireAuth, requireAdmin, readToken,
};
