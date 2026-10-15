/**
 * Utility to resolve the application base URL for public links, OAuth redirect URIs and the
 * CSRF origin check (#340).
 *
 * BASE_URL is the only source in production and staging, where the server refuses to start
 * without it (validateBaseUrl). Proxy headers are never consulted: X-Forwarded-Host is client-
 * controllable, so a forged value would end up in share links and OAuth redirects. Development
 * without BASE_URL falls back to the request's own Host header.
 */

function requiresBaseUrl(env) {
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
}

// Returns the normalized BASE_URL, or null when unset. Throws if set but not an http(s) URL.
function parseBaseUrl(env = process.env) {
  const raw = (env.BASE_URL || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`BASE_URL must be an absolute http(s) URL, got "${raw}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`BASE_URL must be an absolute http(s) URL, got "${raw}".`);
  }
  // Paths are appended to it, so a query, fragment or credentials would corrupt every derived URL.
  if (url.search || url.hash || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    throw new Error(`BASE_URL must not contain credentials, a query or a fragment, got "${raw}".`);
  }
  return raw.replace(/\/+$/, '');
}

function validateBaseUrl(env = process.env) {
  const base = parseBaseUrl(env);
  if (!base && requiresBaseUrl(env)) {
    throw new Error('BASE_URL must be configured in production (public URL of the calendar, e.g. https://calendar.example.com).');
  }
}

function getBaseUrl(req) {
  const base = parseBaseUrl(process.env);
  if (base) return base;
  if (requiresBaseUrl(process.env)) {
    throw new Error('BASE_URL must be configured in production.');
  }
  if (!req || typeof req.get !== 'function' || !req.get('host')) {
    throw new Error('BASE_URL is not configured and the request carries no Host header.');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function getBaseOrigin(req) {
  return new URL(getBaseUrl(req)).origin;
}

function getPublicShareUrl(req, token) {
  const base = getBaseUrl(req);
  return `${base}/api/public/calendars/share/${token}.ics`;
}

module.exports = {
  getBaseUrl,
  getBaseOrigin,
  getPublicShareUrl,
  validateBaseUrl
};
