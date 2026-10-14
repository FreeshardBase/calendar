'use strict';

/**
 * Issue #160: the single error-code → German-message table of the server.
 *
 * Route handlers never send `err.message` to the client. They call
 * `sendError(res, err, tag)`, which logs the original (English, possibly
 * protocol-level) message and answers with the German text and HTTP status
 * derived here. Anything that is not in the table gets the generic German
 * fallback — unmapped English is never passed through.
 *
 * An error that is meant for the user (already German, safe to show) carries
 * `err.userMessage` and optionally `err.status`; see `userError()`.
 */

const GENERIC_MESSAGE = 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.';

const MESSAGES = {
  FORBIDDEN: 'Der Kalenderserver hat den Zugriff verweigert. Dir fehlt die Berechtigung für diese Aktion.',
  UPSTREAM_UNAUTHORIZED: 'Der Kalenderserver hat die Zugangsdaten abgelehnt. Bitte prüfe das verknüpfte Konto.',
  NOT_FOUND: 'Der Eintrag wurde auf dem Kalenderserver nicht gefunden.',
  NOT_ALLOWED: 'Der Kalenderserver unterstützt diese Aktion nicht.',
  CONFLICT: 'Der Eintrag wurde zwischenzeitlich geändert. Bitte lade neu und versuche es erneut.',
  UPSTREAM_CONFLICT: 'Der Kalenderserver konnte die Änderung wegen eines Konflikts nicht übernehmen.',
  TOO_LARGE: 'Die Daten sind zu groß für den Kalenderserver.',
  UPSTREAM_REJECTED: 'Der Kalenderserver hat die Anfrage abgelehnt.',
  UPSTREAM_DOWN: 'Der Kalenderserver ist gerade nicht erreichbar oder hat einen Fehler gemeldet. Bitte versuche es später erneut.',
  CONNECTION: 'Verbindung zum Kalenderserver fehlgeschlagen. Bitte prüfe deine Netzwerkverbindung.',
  SHARING_UNSUPPORTED: 'Dieser Kalenderserver unterstützt keine Freigaben.',
  ENDPOINT_UNRESOLVED: 'CalDAV-Server konnte nicht automatisch ermittelt werden. Bitte prüfe die URL.',
  NOT_CALDAV: 'Der Server antwortet nicht wie ein CalDAV-Server. Bitte prüfe die URL.',
  URL_BLOCKED: 'Diese Adresse ist als Ziel nicht erlaubt.',
  RESPONSE_TOO_LARGE: 'Die Antwort des Servers ist zu groß.',
  EXTERNAL_AUTH: 'Fehler bei der Authentifizierung mit dem externen Anbieter. Bitte verknüpfe das Konto erneut.',
  EXTERNAL_AUTH_UNCONFIGURED: 'Die Anmeldung beim externen Anbieter ist auf diesem Server nicht eingerichtet.',
  NO_MASTER_EVENT: 'Die Terminserie wurde auf dem Kalenderserver nicht gefunden.',
  GENERIC: GENERIC_MESSAGE,
};

// Error codes thrown by name (server/caldav/client.js, outboundFetch.js, ical.js, …).
const CODE_TABLE = {
  ETAG_CONFLICT: { status: 409, message: MESSAGES.CONFLICT },
  UNAUTHORIZED: { status: 502, message: MESSAGES.UPSTREAM_UNAUTHORIZED },
  NOT_FOUND: { status: 404, message: MESSAGES.NOT_FOUND },
  FETCH_FAILED: { status: 502, message: MESSAGES.CONNECTION },
  SHARING_NOT_SUPPORTED: { status: 501, message: MESSAGES.SHARING_UNSUPPORTED },
  COULD_NOT_RESOLVE_CALDAV_ENDPOINT: { status: 400, message: MESSAGES.ENDPOINT_UNRESOLVED },
  NOT_CALDAV_RESPONSE: { status: 400, message: MESSAGES.NOT_CALDAV },
  OUTBOUND_URL_BLOCKED: { status: 400, message: MESSAGES.URL_BLOCKED },
  RESPONSE_TOO_LARGE: { status: 502, message: MESSAGES.RESPONSE_TOO_LARGE },
  NO_MASTER_EVENT: { status: 404, message: MESSAGES.NO_MASTER_EVENT },
  ECONNREFUSED: { status: 502, message: MESSAGES.CONNECTION },
  ENOTFOUND: { status: 502, message: MESSAGES.CONNECTION },
  ECONNRESET: { status: 502, message: MESSAGES.CONNECTION },
  ETIMEDOUT: { status: 504, message: MESSAGES.CONNECTION },
  UND_ERR_SOCKET: { status: 502, message: MESSAGES.CONNECTION },
  UND_ERR_CONNECT_TIMEOUT: { status: 504, message: MESSAGES.CONNECTION },
};

/**
 * Upstream HTTP status → our HTTP status + German message. A permission
 * denial stays a 403 so the client can tell it from a server fault. An
 * upstream 401 is the linked account's credentials, not the user's session
 * with this app, so it is answered as 502 rather than 401.
 */
function fromUpstreamStatus(upstream) {
  switch (upstream) {
    case 401: return { status: 502, message: MESSAGES.UPSTREAM_UNAUTHORIZED };
    case 403: return { status: 403, message: MESSAGES.FORBIDDEN };
    case 404:
    case 410: return { status: 404, message: MESSAGES.NOT_FOUND };
    case 405: return { status: 405, message: MESSAGES.NOT_ALLOWED };
    // 412 is a failed If-Match: someone else changed the item, the client may reload
    // and retry (it reacts to our 409). WebDAV 409 is a server-side state conflict
    // (e.g. missing parent collection) that a reload does not fix.
    case 409: return { status: 502, message: MESSAGES.UPSTREAM_CONFLICT };
    case 412: return { status: 409, message: MESSAGES.CONFLICT };
    case 413: return { status: 413, message: MESSAGES.TOO_LARGE };
    case 501: return { status: 501, message: MESSAGES.NOT_ALLOWED };
    case 504: return { status: 504, message: MESSAGES.UPSTREAM_DOWN };
  }
  if (upstream >= 500) return { status: 502, message: MESSAGES.UPSTREAM_DOWN };
  return { status: 502, message: MESSAGES.UPSTREAM_REJECTED };
}

// Shapes in which the CalDAV client and the provider helpers report an upstream status.
const UPSTREAM_STATUS_PATTERNS = [
  /^(?:PROPFIND|REPORT|MKCALENDAR|GET|PUT|DELETE|POST|PROPPATCH|MOVE|COPY)\s+(\d{3})\b/i,
  /^HTTP_(\d{3})\b/,
  /^Failed to update shares:\s*(\d{3})\b/,
  /MS Graph[^(]*\((\d{3})\)/,
];

function upstreamStatusOf(msg) {
  for (const re of UPSTREAM_STATUS_PATTERNS) {
    const m = msg.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Classify an error into what the client may see.
 * @param {Error|string} err
 * @returns {{ status: number, message: string }}
 */
function describeError(err) {
  if (err && typeof err === 'object' && typeof err.userMessage === 'string') {
    return { status: Number.isInteger(err.status) ? err.status : 500, message: err.userMessage };
  }
  const msg = typeof err === 'string' ? err : String(err?.message || '');
  const code = (err && typeof err === 'object' && (err.code || err.cause?.code)) || null;

  if (Object.hasOwn(CODE_TABLE, msg)) return CODE_TABLE[msg];
  if (typeof code === 'string' && Object.hasOwn(CODE_TABLE, code)) return CODE_TABLE[code];
  // AbortSignal.timeout() on a CalDAV request (server/caldav/client.js).
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { status: 504, message: MESSAGES.CONNECTION };
  }

  // Missing provider credentials are this server's configuration, not the upstream's fault.
  if (/OAuth credentials|GOOGLE_CLIENT_ID/.test(msg)) {
    return { status: 500, message: MESSAGES.EXTERNAL_AUTH_UNCONFIGURED };
  }
  // A failed provider token refresh is the linked account's sign-in, whatever its status.
  if (/token refresh failed/i.test(msg)) {
    return { status: 502, message: MESSAGES.EXTERNAL_AUTH };
  }

  const upstream = upstreamStatusOf(msg);
  if (upstream) return fromUpstreamStatus(upstream);

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg)) {
    return CODE_TABLE.FETCH_FAILED;
  }
  return { status: 500, message: GENERIC_MESSAGE };
}

/** The German message for an error; never the error's own (English) text. */
function sanitizeErrorMessage(err) {
  return describeError(err).message;
}

/**
 * Log the original error and answer with the mapped German message.
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {string} [tag] - log prefix, e.g. '[tasks PUT]'; defaults to the request line
 */
function sendError(res, err, tag) {
  const { status, message } = describeError(err);
  const prefix = tag || `[${res.req?.method} ${res.req?.originalUrl}]`;
  // Unmapped errors are usually programming errors: keep the stack for them.
  const detail = status === 500 && err?.stack ? err.stack : (err?.message ?? String(err));
  console.error(prefix, detail);
  return res.status(status).json({ error: message });
}

/** An error whose German message is meant for the user. */
function userError(message, status = 500) {
  const err = new Error(message);
  err.userMessage = message;
  err.status = status;
  return err;
}

module.exports = {
  MESSAGES,
  describeError,
  sanitizeErrorMessage,
  sendError,
  userError,
};
