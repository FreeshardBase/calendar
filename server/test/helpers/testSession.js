'use strict';

/**
 * Issue #245 — the Node suite's multi-identity mechanism.
 *
 * A test becomes a user by holding a real session: a row in the server's
 * SQLite session store plus a cookie signed with the server's session secret.
 * Nothing here is reachable over HTTP, so no request can assert an identity by
 * sending something (#50). The server must share this process's DATABASE_PATH
 * and SESSION_SECRET (or session secret file) — in-process tests always do;
 * tests that spawn the server must pass the same env to the child.
 */

const crypto = require('crypto');
const Db = require('../../db');
const { resolveSessionSecret } = require('../../utils/sessionConfig');

const COOKIE_NAME = 'connect.sid';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same format as cookie-signature's sign(), which express-session verifies.
function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
  return `${value}.${mac}`;
}

/**
 * Create a session for userId and return the `cookie` header value carrying it.
 * @param {string} userId
 * @param {{ username?: string, email?: string }} [opts]
 * @returns {Promise<string>}
 */
async function loginAs(userId, { username, email } = {}) {
  if (!userId) throw new Error('loginAs: userId is required');
  await Db.ready;
  const sid = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + MAX_AGE);
  const sess = {
    cookie: { originalMaxAge: MAX_AGE, expires: expires.toISOString(), secure: false, httpOnly: true, path: '/', sameSite: 'strict' },
    userId
  };
  if (username) sess.username = username;
  const derivedEmail = email || (username && EMAIL_RE.test(username.trim()) ? username : null);
  if (derivedEmail) sess.userEmail = derivedEmail.trim().toLowerCase();
  await Db.saveSession(sid, userId, JSON.stringify(sess), expires.getTime());
  const secret = resolveSessionSecret(process.env);
  return `${COOKIE_NAME}=${encodeURIComponent('s:' + sign(sid, secret))}`;
}

module.exports = { loginAs };
