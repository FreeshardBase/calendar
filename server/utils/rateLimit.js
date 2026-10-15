'use strict';

/**
 * Issue #340 — per-client-IP rate limiting for login/auth routes and public routes.
 *
 * Fixed window, in memory: the app runs as a single process per shard. The default key is req.ip,
 * which honours the trust proxy setting (sessionConfig.getTrustProxySetting): behind the
 * shard's reverse proxy it is the address that proxy appended, not a client-supplied entry.
 */

const AUTH_RATE_LIMIT = { max: 30, windowMs: 60 * 1000 };
const PUBLIC_RATE_LIMIT = { max: 120, windowMs: 60 * 1000 };
// Issue #345: the public booking endpoint writes into the owner's calendar, so it gets a much
// tighter budget, counted both per client IP and per booking page (across all clients).
const BOOKING_IP_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
const BOOKING_PAGE_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000, key: (req) => `page:${req.params.slug}` };

function createRateLimiter({ max, windowMs, key = (req) => req.ip }) {
  const hits = new Map();

  // Drop finished windows so rotating addresses cannot grow the map without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }, windowMs);
  sweeper.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' });
    }
    next();
  };
}

module.exports = { createRateLimiter, AUTH_RATE_LIMIT, PUBLIC_RATE_LIMIT, BOOKING_IP_RATE_LIMIT, BOOKING_PAGE_RATE_LIMIT };
