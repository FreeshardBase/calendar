'use strict';

/**
 * Issue #340 — per-client-IP rate limiting for login/auth routes and public routes.
 *
 * Fixed window, in memory: the app runs as a single process per shard. The key is req.ip,
 * which honours the trust proxy setting (sessionConfig.getTrustProxySetting): behind the
 * shard's reverse proxy it is the address that proxy appended, not a client-supplied entry.
 */

const AUTH_RATE_LIMIT = { max: 30, windowMs: 60 * 1000 };
const PUBLIC_RATE_LIMIT = { max: 120, windowMs: 60 * 1000 };

function createRateLimiter({ max, windowMs }) {
  const hits = new Map();

  // Drop finished windows so rotating addresses cannot grow the map without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' });
    }
    next();
  };
}

module.exports = { createRateLimiter, AUTH_RATE_LIMIT, PUBLIC_RATE_LIMIT };
