'use strict';
const log = require('./logger');

/**
 * Issue #160: the single error-code → German-message table of the server.
 *
 * Route handlers never send `err.message` to the client. They call
 * `sendError(res, err, tag)`, which logs the original (English, possibly
 * protocol-level) message and answers `{ error, code, params? }`: the code and its
 * parameters, which the UI shows in the user's language (#628,
 * public/js/messages/serverErrors.js), and the German text for logs and other API
 * clients. Anything that is not in the table gets the generic code — unmapped
 * English is never passed through.
 *
 * An error that is meant for the user carries a code of this table; see
 * `userError(code, status, params)`. A route that answers `{ error }` itself gets the
 * code of its HTTP status added (`ensureErrorCode`, installed for /api in index.js).
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
  // #628: the codes of answers that name only their HTTP status (see codeForStatus).
  BAD_REQUEST: 'Die Anfrage ist ungültig.',
  UNAUTHENTICATED: 'Bitte melde dich erneut an.',
  ACCESS_DENIED: 'Dir fehlt die Berechtigung für diese Aktion.',
  RESOURCE_NOT_FOUND: 'Der Eintrag wurde nicht gefunden.',
  REQUEST_CONFLICT: 'Die Aktion passt nicht zum aktuellen Stand. Bitte lade neu und versuche es erneut.',
  REQUEST_TOO_LARGE: 'Die Anfrage ist zu groß.',
  RATE_LIMITED: 'Zu viele Anfragen. Bitte warte einen Moment.',
  // Errors meant for the user, raised with userError().
  INVALID_PREFERENCE: 'Ungültiger Wert für die Einstellung {name}.',
  NO_PREFERENCE: 'Die Anfrage enthält keine Einstellung.',
  INVALID_CONFERENCE_URL: 'Der Jitsi-Server muss eine http(s)-Adresse ohne Zugangsdaten, Abfrage oder Fragment sein.',
  INVALID_TIME_ZONE: 'Unbekannte Zeitzone.',
  ACCOUNT_DISCONNECTED: 'Das Konto dieses Eintrags ist nicht mehr verbunden.',
  TRASH_RESTORE_DENIED: 'Dir fehlt die Berechtigung, diesen Eintrag wiederherzustellen.',
  TRASH_CALENDAR_GONE: 'Der Kalender dieses Eintrags existiert nicht mehr. Stelle zuerst den Kalender aus dem Papierkorb wieder her.',
  TRASH_ITEM_EXISTS: 'Unter dieser Adresse gibt es inzwischen einen neuen Eintrag. Der gelöschte bleibt im Papierkorb.',
  TRASH_CALENDAR_EXISTS: 'Unter dieser Adresse gibt es inzwischen einen anderen Kalender. Der gelöschte bleibt im Papierkorb.',
  PUBLIC_DETAIL_NOT_SAVED: 'Detailstufe konnte nicht gespeichert werden.',
  INVALID_FILE_PATH: 'Ungültiger Dateipfad.',
  INVALID_RRULE: 'Ungültige Wiederholungsregel: {detail}',
  RRULE_NO_NEXT: 'Wiederholungsregel ergibt kein weiteres Vorkommen: {detail}',
  TASK_START_AFTER_DUE: 'Aufgabe ungültig: DTSTART liegt nach DUE',
  INVALID_RECURRENCE_ID: 'Ungültige recurrenceId: „{detail}“ ist kein Termin dieser Serie.',
  BOOKING_PAGE_UNAVAILABLE: 'Diese Buchungsseite ist derzeit nicht verfügbar.',
  INVALID_ICS: 'Ungültige ICS-Datei. Die Datei konnte nicht gelesen werden.',
  TASK_LIST_REQUIRED: 'Dieser Kalender nimmt keine Aufgaben auf. Bitte wähle eine Aufgabenliste.',
  // #503 booking settings; `weekday` is 0 (Sunday) … 6, the UI names the day.
  BOOKING_WEEK_INCOMPLETE: 'Zeitfenster müssen für jeden der sieben Wochentage angegeben sein.',
  BOOKING_TOO_MANY_WINDOWS: 'Wochentag {weekday}: höchstens {max} Zeitfenster.',
  BOOKING_WINDOW_FORMAT: 'Wochentag {weekday}: Zeitfenster brauchen Beginn und Ende im Format HH:MM.',
  BOOKING_WINDOW_ORDER: 'Wochentag {weekday}: Ein Zeitfenster muss vor seinem Ende beginnen.',
  BOOKING_WINDOW_OVERLAP: 'Wochentag {weekday}: Zeitfenster dürfen sich nicht überschneiden.',
  BOOKING_NO_WINDOW: 'Mindestens ein Wochentag braucht ein Zeitfenster.',
  BOOKING_DURATION_RANGE: 'Die Dauer muss eine ganze Zahl von {min} bis {max} sein.',
  BOOKING_BUFFER_RANGE: 'Der Puffer muss eine ganze Zahl von {min} bis {max} sein.',
  BOOKING_MAX_PER_DAY_RANGE: 'Die Höchstzahl an Buchungen pro Tag muss eine ganze Zahl von {min} bis {max} sein.',
  BOOKING_NOTICE_RANGE: 'Der Mindestvorlauf muss eine ganze Zahl von {min} bis {max} sein.',
};

/** Every code the server answers; the UI has a translation for each (#628). */
const ERROR_CODES = Object.keys(MESSAGES);

function formatMessage(code, params) {
  return MESSAGES[code].replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Error code ${code} needs the parameter "${name}"`);
    return String(params[name]);
  });
}

/** The code of an answer that names only its HTTP status. */
function codeForStatus(status) {
  switch (status) {
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'ACCESS_DENIED';
    case 404: return 'RESOURCE_NOT_FOUND';
    case 409: return 'REQUEST_CONFLICT';
    case 413: return 'REQUEST_TOO_LARGE';
    case 429: return 'RATE_LIMITED';
  }
  return status >= 400 && status < 500 ? 'BAD_REQUEST' : 'GENERIC';
}

/** An error body `{ error }` answered without a code gets the code of its status. */
function ensureErrorCode(status, body) {
  if (status < 400 || !body || typeof body !== 'object' || typeof body.error !== 'string' || body.code) return body;
  return { ...body, code: codeForStatus(status) };
}

// Error codes thrown by name (server/caldav/client.js, outboundFetch.js, ical.js, …).
const CODE_TABLE = {
  ETAG_CONFLICT: { status: 409, code: 'CONFLICT' },
  UNAUTHORIZED: { status: 502, code: 'UPSTREAM_UNAUTHORIZED' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  FETCH_FAILED: { status: 502, code: 'CONNECTION' },
  SHARING_NOT_SUPPORTED: { status: 501, code: 'SHARING_UNSUPPORTED' },
  COULD_NOT_RESOLVE_CALDAV_ENDPOINT: { status: 400, code: 'ENDPOINT_UNRESOLVED' },
  NOT_CALDAV_RESPONSE: { status: 400, code: 'NOT_CALDAV' },
  OUTBOUND_URL_BLOCKED: { status: 400, code: 'URL_BLOCKED' },
  RESPONSE_TOO_LARGE: { status: 502, code: 'RESPONSE_TOO_LARGE' },
  NO_MASTER_EVENT: { status: 404, code: 'NO_MASTER_EVENT' },
  ECONNREFUSED: { status: 502, code: 'CONNECTION' },
  ENOTFOUND: { status: 502, code: 'CONNECTION' },
  ECONNRESET: { status: 502, code: 'CONNECTION' },
  ETIMEDOUT: { status: 504, code: 'CONNECTION' },
  UND_ERR_SOCKET: { status: 502, code: 'CONNECTION' },
  UND_ERR_CONNECT_TIMEOUT: { status: 504, code: 'CONNECTION' },
};

/**
 * Upstream HTTP status → our HTTP status + code. A permission
 * denial stays a 403 so the client can tell it from a server fault. An
 * upstream 401 is the linked account's credentials, not the user's session
 * with this app, so it is answered as 502 rather than 401.
 */
function fromUpstreamStatus(upstream) {
  switch (upstream) {
    case 401: return { status: 502, code: 'UPSTREAM_UNAUTHORIZED' };
    case 403: return { status: 403, code: 'FORBIDDEN' };
    case 404:
    case 410: return { status: 404, code: 'NOT_FOUND' };
    case 405: return { status: 405, code: 'NOT_ALLOWED' };
    // 412 is a failed If-Match: someone else changed the item, the client may reload
    // and retry (it reacts to our 409). WebDAV 409 is a server-side state conflict
    // (e.g. missing parent collection) that a reload does not fix.
    case 409: return { status: 502, code: 'UPSTREAM_CONFLICT' };
    case 412: return { status: 409, code: 'CONFLICT' };
    case 413: return { status: 413, code: 'TOO_LARGE' };
    case 501: return { status: 501, code: 'NOT_ALLOWED' };
    case 504: return { status: 504, code: 'UPSTREAM_DOWN' };
  }
  if (upstream >= 500) return { status: 502, code: 'UPSTREAM_DOWN' };
  return { status: 502, code: 'UPSTREAM_REJECTED' };
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

function classify(err) {
  if (err && typeof err === 'object' && typeof err.userCode === 'string') {
    return { status: Number.isInteger(err.status) ? err.status : 500, code: err.userCode, params: err.params };
  }
  const msg = typeof err === 'string' ? err : String(err?.message || '');
  const code = (err && typeof err === 'object' && (err.code || err.cause?.code)) || null;

  if (Object.hasOwn(CODE_TABLE, msg)) return CODE_TABLE[msg];
  if (typeof code === 'string' && Object.hasOwn(CODE_TABLE, code)) return CODE_TABLE[code];
  // AbortSignal.timeout() on a CalDAV request (server/caldav/client.js).
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { status: 504, code: 'CONNECTION' };
  }

  // Missing provider credentials are this server's configuration, not the upstream's fault.
  if (/OAuth credentials|GOOGLE_CLIENT_ID/.test(msg)) {
    return { status: 500, code: 'EXTERNAL_AUTH_UNCONFIGURED' };
  }
  // A failed provider token refresh is the linked account's sign-in, whatever its status.
  if (/token refresh failed/i.test(msg)) {
    return { status: 502, code: 'EXTERNAL_AUTH' };
  }

  const upstream = upstreamStatusOf(msg);
  if (upstream) return fromUpstreamStatus(upstream);

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg)) {
    return CODE_TABLE.FETCH_FAILED;
  }
  return { status: 500, code: 'GENERIC' };
}

/**
 * Classify an error into what the client may see.
 * @param {Error|string} err
 * @returns {{ status: number, code: string, params?: object, message: string }}
 */
function describeError(err) {
  const described = classify(err);
  return { ...described, message: formatMessage(described.code, described.params || {}) };
}

/** The German message for an error; never the error's own (English) text. */
function sanitizeErrorMessage(err) {
  return describeError(err).message;
}

/** The JSON body of an error answer: German text, code and the code's parameters. */
function errorBody({ code, params, message }) {
  return params ? { error: message, code, params } : { error: message, code };
}

/**
 * Log the original error and answer with its code and the mapped German message.
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {string} [tag] - log prefix, e.g. '[tasks PUT]'; defaults to the request line
 */
function sendError(res, err, tag) {
  const described = describeError(err);
  const prefix = tag || `[${res.req?.method} ${res.req?.originalUrl}]`;
  // Unmapped errors are usually programming errors: keep the stack for them.
  const detail = described.status === 500 && err?.stack ? err.stack : (err?.message ?? String(err));
  log.error(prefix, detail);
  return res.status(described.status).json(errorBody(described));
}

/** An error meant for the user: a code of the table, its HTTP status and the code's parameters. */
function userError(code, status = 500, params) {
  if (!Object.hasOwn(MESSAGES, code)) throw new Error(`Unknown error code: ${code}`);
  const err = new Error(formatMessage(code, params || {}));
  err.userCode = code;
  err.userMessage = err.message;
  err.status = status;
  if (params) err.params = params;
  return err;
}

module.exports = {
  MESSAGES,
  ERROR_CODES,
  codeForStatus,
  ensureErrorCode,
  errorBody,
  describeError,
  sanitizeErrorMessage,
  sendError,
  userError,
};
