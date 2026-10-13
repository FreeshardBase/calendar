'use strict';

/**
 * internalAuth.js — Issue #59 fix
 *
 * Provides createRequireInternalMiddleware(env) factory for the internal
 * webhook guard, with the following security contract:
 *
 * When INTERNAL_WEBHOOK_SECRET is configured:
 *   ─ Access is granted ONLY if the x-freeshard-secret or x-internal-secret header matches.
 *   ─ Compared in constant time via crypto.timingSafeEqual.
 *   ─ req.ip / X-Forwarded-For is NOT consulted. IP check is meaningless when
 *     trust proxy is on because X-Forwarded-For is attacker-controlled.
 *
 * When INTERNAL_WEBHOOK_SECRET is NOT configured:
 *   ─ Every caller is refused, loopback included, regardless of trust proxy.
 *     A reverse proxy that connects over loopback would otherwise make every
 *     external request look "internal".
 *
 * NODE_ENV=test always bypasses the check (existing test-suite contract).
 */

const crypto = require('crypto');

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === 0 || bufB.length === 0) return false;
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {object} env  - Object with env-like keys (default: process.env)
 * @returns {function}  - Express middleware (req, res, next)
 */
function createRequireInternalMiddleware(env = process.env) {
  return function requireInternal(req, res, next) {
    // Always pass in test mode (unit/integration suite contract)
    if (env.NODE_ENV === 'test') return next();

    const expectedSecret = env.INTERNAL_WEBHOOK_SECRET;

    if (expectedSecret && typeof expectedSecret === 'string' && expectedSecret.trim() !== '') {
      // Secret-based auth: IP is irrelevant (spoofable via X-Forwarded-For when trust proxy on)
      const provided = req.headers['x-freeshard-secret'] || req.headers['x-internal-secret'];
      if (provided && safeCompare(provided, expectedSecret)) return next();
      return res.status(403).json({ error: 'Access denied: Internal only' });
    }

    // No secret configured: the routes are closed. There is no IP allow-list —
    // with trust proxy on req.ip comes from X-Forwarded-For, and with it off a
    // reverse proxy on loopback makes every forwarded caller a loopback peer.
    return res.status(403).json({ error: 'Access denied: Set INTERNAL_WEBHOOK_SECRET to enable internal endpoints' });
  };
}

module.exports = { createRequireInternalMiddleware, safeCompare };
