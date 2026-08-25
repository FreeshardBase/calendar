'use strict';

/**
 * internalAuth.js — Issue #59 fix
 *
 * Provides createRequireInternalMiddleware(env) factory for the internal
 * webhook guard, with the following security contract:
 *
 * When INTERNAL_WEBHOOK_SECRET is configured:
 *   ─ Access is granted ONLY if the x-freeshard-secret header exactly matches.
 *   ─ req.ip / X-Forwarded-For is NOT consulted. IP check is meaningless when
 *     trust proxy is on because X-Forwarded-For is attacker-controlled.
 *
 * When INTERNAL_WEBHOOK_SECRET is NOT configured:
 *   ─ If trust proxy is disabled (TRUST_PROXY is falsy), req.ip reflects the
 *     real socket address, which is unforgeable. Loopback IPs (127.0.0.1 / ::1)
 *     are allowed as a dev/CI convenience.
 *   ─ If trust proxy is enabled, req.ip is spoofable → block all callers.
 *     (Operators MUST set INTERNAL_WEBHOOK_SECRET in this configuration.)
 *
 * NODE_ENV=test always bypasses the check (existing test-suite contract).
 */

/**
 * @param {object} env  - Object with env-like keys (default: process.env)
 * @returns {function}  - Express middleware (req, res, next)
 */
function createRequireInternalMiddleware(env = process.env) {
  return function requireInternal(req, res, next) {
    // Always pass in test mode (unit/integration suite contract)
    if (env.NODE_ENV === 'test') return next();

    const expectedSecret = env.INTERNAL_WEBHOOK_SECRET;

    if (expectedSecret) {
      // Secret-based auth: IP is irrelevant (spoofable via X-Forwarded-For when trust proxy on)
      const provided = req.headers['x-freeshard-secret'];
      if (provided === expectedSecret) return next();
      return res.status(403).json({ error: 'Access denied: Internal only' });
    }

    // No secret configured: fall back to IP-based check ONLY when trust proxy is off
    const trustProxy = env.TRUST_PROXY;
    const trustProxyEnabled = trustProxy === 'true' || trustProxy === '1' || trustProxy === true;

    if (trustProxyEnabled) {
      // req.ip is spoofable — refuse to use it as a security gate
      return res.status(403).json({ error: 'Access denied: Set INTERNAL_WEBHOOK_SECRET when trust proxy is enabled' });
    }

    // Trust proxy off → req.ip is the actual socket address (unforgeable)
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLoopback) return next();

    return res.status(403).json({ error: 'Access denied: Internal only' });
  };
}

module.exports = { createRequireInternalMiddleware };
