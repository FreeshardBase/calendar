/**
 * Utility to resolve the application base URL for public links and external callbacks.
 * Respects process.env.BASE_URL when defined, and falls back to inspecting
 * X-Forwarded-Proto / X-Forwarded-Host proxy headers or Express request properties.
 */

function getBaseUrl(req) {
  if (process.env.BASE_URL && process.env.BASE_URL.trim() !== '') {
    return process.env.BASE_URL.trim().replace(/\/+$/, '');
  }

  let proto = 'http';
  if (req) {
    const rawProto = (typeof req.get === 'function' ? req.get('x-forwarded-proto') : null) || req.protocol;
    if (rawProto) {
      proto = String(rawProto).split(',')[0].trim();
    }
  }

  let host = 'localhost:3000';
  if (req) {
    const rawHost = (typeof req.get === 'function' ? req.get('x-forwarded-host') : null) || (typeof req.get === 'function' ? req.get('host') : null);
    if (rawHost) {
      host = String(rawHost).split(',')[0].trim();
    }
  }

  return `${proto}://${host}`;
}

function getPublicShareUrl(req, token) {
  const base = getBaseUrl(req);
  return `${base}/api/public/calendars/share/${token}.ics`;
}

module.exports = {
  getBaseUrl,
  getPublicShareUrl
};
