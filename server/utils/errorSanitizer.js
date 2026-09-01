'use strict';

/**
 * Sanitize error messages returned to clients/users.
 * Removes raw English protocol jargon (e.g. PROPFIND 500: Internal Server Error)
 * and strips upstream HTML/XML response body fragments.
 *
 * @param {Error|string} err - Error object or error string
 * @param {string} [fallback] - Fallback message if error is empty
 * @returns {string} Clean, human-readable error message
 */
function sanitizeErrorMessage(err, fallback = 'Ein Fehler ist aufgetreten.') {
  let msg = typeof err === 'string' ? err : err?.message || String(err || '');
  if (!msg || msg === '[object Object]') {
    return fallback;
  }

  // Strip HTML / XML tags if present
  msg = msg.replace(/<[^>]*>/g, '').trim();

  // Strip trailing response body fragments starting with '—' or raw XML/HTML declarations
  msg = msg.replace(/\s*—\s*[\s\S]*/g, '').trim();
  msg = msg.replace(/<\?xml[\s\S]*/gi, '').trim();

  // Check for common HTTP status patterns or protocol jargon
  if (/^PROPFIND\s+(\d+)/i.test(msg) || /^REPORT\s+(\d+)/i.test(msg) || /^MKCALENDAR\s+(\d+)/i.test(msg) || /^GET\s+(\d+)/i.test(msg) || /^PUT\s+(\d+)/i.test(msg) || /^DELETE\s+(\d+)/i.test(msg)) {
    const match = msg.match(/(?:PROPFIND|REPORT|MKCALENDAR|GET|PUT|DELETE)\s+(\d+)/i);
    const statusCode = match ? parseInt(match[1], 10) : 500;
    if (statusCode === 401) return 'Ungültige Zugangsdaten oder Sitzung abgelaufen.';
    if (statusCode === 403) return 'Zugriff verweigert.';
    if (statusCode === 404) return 'Ressource nicht gefunden.';
    if (statusCode === 409) return 'Konflikt bei der Aktualisierung.';
    if (statusCode === 412) return 'Die Ressource wurde zwischenzeitlich verändert.';
    return 'Fehler bei der Kommunikation mit dem Kalenderserver.';
  }

  if (msg.includes('Failed to update shares')) {
    return 'Fehler beim Aktualisieren der Freigaben.';
  }

  if (msg === 'FETCH_FAILED' || msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return 'Verbindung zum Kalenderserver fehlgeschlagen.';
  }

  if (msg.includes('OAuth credentials') || msg.includes('GOOGLE_CLIENT_ID') || msg.includes('missing in .env')) {
    return 'Fehler bei der Authentifizierung mit dem externen Anbieter.';
  }

  // Generic cleanup of remaining HTTP_xxx codes
  msg = msg.replace(/^HTTP_\d+:\s*/i, '');

  return msg || fallback;
}

module.exports = {
  sanitizeErrorMessage
};
