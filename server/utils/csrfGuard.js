'use strict';

/**
 * Issue #340 — CSRF defence by origin.
 *
 * SameSite cookies do not help on a shard: every app is a sibling subdomain of the same
 * registrable domain, i.e. same-site. A state-changing request (anything but GET/HEAD/OPTIONS)
 * is therefore accepted only if
 *   - its Origin equals the BASE_URL origin, or
 *   - it has no Origin and Sec-Fetch-Site is 'same-origin'.
 * Everything else, including requests that carry neither header, is refused with 403.
 *
 * Exempt are the server-to-server endpoints that do not rely on ambient browser credentials:
 * /internal/* (shared secret, see internalAuth.js) and the OIDC back-channel logout (token
 * signed by the identity provider).
 */

const { getBaseOrigin } = require('./baseUrl');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = ['/api/auth/backchannel-logout', '/api/auth/backchannel_logout'];

function isExempt(path) {
  return path.startsWith('/internal/') || EXEMPT_PATHS.includes(path);
}

function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method) || isExempt(req.path)) return next();

  const origin = req.get('origin');
  const allowed = origin !== undefined
    ? origin === getBaseOrigin(req)
    : req.get('sec-fetch-site') === 'same-origin';
  if (allowed) return next();

  return res.status(403).json({ error: 'Anfrage von fremder Herkunft abgelehnt.' });
}

module.exports = { csrfGuard };
