'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #160 — what a mounted route handler actually sends when the upstream
// CalDAV server fails. The client must get a German message from the server's
// error table and an HTTP status derived from the upstream status; the English
// protocol message (`PUT 403: Forbidden`, `Failed to update shares: …`) stays
// in the log. Runs with production semantics against a loopback CalDAV stub.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue160-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue160.db');
process.env.ENCRYPTION_KEY = 'issue160-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');
const tasksRouter = require('../routes/tasks');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const accountsRouter = require('../routes/accounts');
const webcalRouter = require('../routes/webcal');
const Db = require('../db');
const { sanitizeErrorMessage, describeError } = require('../utils/errorSanitizer');

const CAL_PATH = '/testuser/cal/';
const CAL_ID = `acc::${CAL_PATH}`;
const DAV_ERROR_DOC = '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:need-privileges/></D:error>';
const HTML_502 = '<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>';

const MSG_FORBIDDEN = 'Der Kalenderserver hat den Zugriff verweigert. Dir fehlt die Berechtigung für diese Aktion.';
const MSG_UPSTREAM_DOWN = 'Der Kalenderserver ist gerade nicht erreichbar oder hat einen Fehler gemeldet. Bitte versuche es später erneut.';
const MSG_UPSTREAM_REJECTED = 'Der Kalenderserver hat die Anfrage abgelehnt.';
const MSG_SHARING_UNSUPPORTED = 'Dieser Kalenderserver unterstützt keine Freigaben.';
const MSG_CONNECTION = 'Verbindung zum Kalenderserver fehlgeschlagen. Bitte prüfe deine Netzwerkverbindung.';
const MSG_GENERIC = 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.';

// Words that only ever appear in the English protocol messages the issue quotes.
const ENGLISH_JARGON = /PROPFIND|REPORT|\bPUT\b|\bDELETE\b|Forbidden|Bad Gateway|Bad Request|Failed|Sharing|fetch|<|ECONNREFUSED/;

function assertGerman(msg, label) {
  assert.equal(typeof msg, 'string', `${label}: error must be a string`);
  assert.doesNotMatch(msg, ENGLISH_JARGON, `${label}: English protocol text reached the client: ${msg}`);
}

function multistatus(inner) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
    `xmlns:cs="http://calendarserver.org/ns/">${inner}</d:multistatus>`;
}

const CAL_LIST = multistatus(`<d:response><d:href>${CAL_PATH}</d:href><d:propstat><d:prop>` +
  '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Test</d:displayname>' +
  '<c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');

const SHARING_STANDARD = multistatus(`<d:response><d:href>${CAL_PATH}</d:href><d:propstat><d:prop>` +
  '<cs:invite/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
const SHARING_NONE = multistatus(`<d:response><d:href>${CAL_PATH}</d:href><d:propstat><d:prop>` +
  '<cs:invite/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>');

// handler(req, body) -> { status, body, headers? }
async function withStack(handler, fn, { davUrlOverride, accountLoadError } = {}) {
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const out = handler(req, body);
      res.writeHead(out.status, { 'Content-Type': 'application/xml', ...(out.headers || {}) });
      res.end(out.body || '');
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = davUrlOverride || `http://127.0.0.1:${dav.address().port}/`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'testuser',
      accounts: [{ id: 'acc', authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
    };
    // Set by server/index.js when loading the linked accounts throws.
    if (accountLoadError) req.accountLoadError = accountLoadError;
    next();
  });
  app.use('/api/accounts', accountsRouter);
  app.use('/api/webcal', webcalRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const origError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  try {
    await fn(base, errors);
  } finally {
    console.error = origError;
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

function json(method, url, body) {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('Issue #160 — events load with upstream PROPFIND 502 reports German text, no protocol jargon', async () => {
  await withStack(
    () => ({ status: 502, body: HTML_502, headers: { 'Content-Type': 'text/html' } }),
    async (base, logged) => {
      const res = await fetch(`${base}/api/events?start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z`);
      assert.equal(res.status, 502);
      const body = await res.json();
      // The client prefixes "Fehler beim Laden der Termine: "; the server sends the cause.
      assert.equal(body.error, MSG_UPSTREAM_DOWN);
      assert.ok(Array.isArray(body.errors) && body.errors.length === 1);
      assert.equal(body.errors[0].accountId, 'acc');
      assert.equal(body.errors[0].error, MSG_UPSTREAM_DOWN);
      const header = res.headers.get('x-caldav-error');
      assert.ok(header, 'X-CalDAV-Error is still set');
      for (const m of JSON.parse(header)) assertGerman(m, 'X-CalDAV-Error');
      // The English detail is kept for the operator.
      assert.ok(logged.some(l => l.includes('PROPFIND 502')), 'upstream message must be logged');
    }
  );
});

test('Issue #160 — a single calendar whose REPORT fails (503) is reported in German', async () => {
  await withStack(
    (req) => {
      if (req.method === 'PROPFIND') return { status: 207, body: CAL_LIST };
      if (req.method === 'REPORT') return { status: 503, body: HTML_502, headers: { 'Content-Type': 'text/html' } };
      return { status: 405, body: '' };
    },
    async (base) => {
      const res = await fetch(`${base}/api/events?start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z&calendarId=${encodeURIComponent(CAL_ID)}`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, MSG_UPSTREAM_DOWN);
      assert.deepEqual(body.errors, [{ accountId: 'acc', calendarId: CAL_ID, status: 502, error: MSG_UPSTREAM_DOWN }]);
      assert.deepEqual(JSON.parse(res.headers.get('x-caldav-error')), [MSG_UPSTREAM_DOWN]);
    }
  );
});

test('Issue #160 — events/tasks lists denied upstream (403) arrive as 403, not 502', async () => {
  await withStack(
    (req, body) => {
      if (req.method === 'PROPFIND') return { status: 207, body: CAL_LIST };
      if (req.method === 'REPORT') return { status: 403, body: DAV_ERROR_DOC };
      return { status: 405, body: '' };
    },
    async (base) => {
      const ev = await fetch(`${base}/api/events?start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z&calendarId=${encodeURIComponent(CAL_ID)}`);
      assert.equal(ev.status, 403);
      assert.equal((await ev.json()).error, MSG_FORBIDDEN);

      const tasks = await fetch(`${base}/api/tasks?calendarId=${encodeURIComponent(CAL_ID)}`);
      assert.equal(tasks.status, 403);
      assert.equal((await tasks.json()).error, MSG_FORBIDDEN);
    }
  );
});

test('Issue #160 — calendars list denied upstream (403) arrives as 403', async () => {
  await withStack(
    () => ({ status: 403, body: DAV_ERROR_DOC }),
    async (base) => {
      // DISABLE_INTERNAL_CALDAV=1 substitutes a local calendar for a failed
      // account; without it the failure is the response.
      process.env.DISABLE_INTERNAL_CALDAV = '0';
      try {
        const cals = await fetch(`${base}/api/calendars`);
        const body = await cals.json();
        assert.equal(cals.status, 403);
        assert.equal(body.error, MSG_FORBIDDEN);
        assert.deepEqual(body.errors, [{ accountId: 'acc', status: 403, error: MSG_FORBIDDEN }]);
      } finally {
        process.env.DISABLE_INTERNAL_CALDAV = '1';
      }
    }
  );
});

test('Issue #160 — tasks and calendars load failures are German', async () => {
  await withStack(
    () => ({ status: 502, body: HTML_502, headers: { 'Content-Type': 'text/html' } }),
    async (base) => {
      const tasks = await fetch(`${base}/api/tasks`);
      assert.equal(tasks.status, 502);
      const tbody = await tasks.json();
      assert.equal(tbody.error, MSG_UPSTREAM_DOWN);
      assert.deepEqual(tbody.errors, [{ accountId: 'acc', status: 502, error: MSG_UPSTREAM_DOWN }]);

      // With the internal CalDAV disabled the list falls back to a local
      // calendar (200), but the account failure is still reported.
      const cals = await fetch(`${base}/api/calendars`);
      const cbody = await cals.json();
      assert.deepEqual(cbody.errors, [{ accountId: 'acc', status: 502, error: MSG_UPSTREAM_DOWN }]);
      if (cals.status !== 200) assert.equal(cbody.error, MSG_UPSTREAM_DOWN);
      assert.deepEqual(JSON.parse(cals.headers.get('x-caldav-error')), [MSG_UPSTREAM_DOWN]);
    }
  );
});

test('Issue #160 — calendar export with the backend down is a German 502', async () => {
  await withStack(
    () => ({ status: 503, body: HTML_502, headers: { 'Content-Type': 'text/html' } }),
    async (base) => {
      const res = await fetch(`${base}/api/calendars/${encodeURIComponent(CAL_ID)}/export`);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error, MSG_UPSTREAM_DOWN);
    }
  );
});

test('Issue #160 — task PUT/DELETE denied upstream (403) arrive as 403 with German text', async () => {
  await withStack(
    (req) => {
      if (req.method === 'GET') return { status: 404, body: '' };
      if (req.method === 'PUT' || req.method === 'DELETE') return { status: 403, body: DAV_ERROR_DOC };
      return { status: 405, body: '' };
    },
    async (base, logged) => {
      const put = await json('PUT', `${base}/api/tasks/issue160`, {
        calendarId: CAL_ID, href: `${CAL_PATH}issue160.ics`, title: 'Test User task'
      });
      assert.equal(put.status, 403, 'an upstream permission denial must not become a 500');
      assert.equal((await put.json()).error, MSG_FORBIDDEN);

      const del = await json('DELETE', `${base}/api/tasks/issue160`, {
        calendarId: CAL_ID, href: `${CAL_PATH}issue160.ics`
      });
      assert.equal(del.status, 403);
      assert.equal((await del.json()).error, MSG_FORBIDDEN);
      assert.ok(logged.some(l => l.includes('PUT 403')) && logged.some(l => l.includes('DELETE 403')));
    }
  );
});

test('Issue #160 — event save rejected upstream (400) and event delete denied (403)', async () => {
  await withStack(
    (req) => {
      if (req.method === 'PUT') return { status: 400, body: '<html>bad</html>' };
      if (req.method === 'DELETE') return { status: 403, body: DAV_ERROR_DOC };
      return { status: 404, body: '' };
    },
    async (base) => {
      const post = await json('POST', `${base}/api/events`, {
        calendarId: CAL_ID, title: 'Test User meeting',
        start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z'
      });
      assert.equal(post.status, 502);
      assert.equal((await post.json()).error, MSG_UPSTREAM_REJECTED);

      const del = await json('DELETE', `${base}/api/events/issue160`, {
        calendarId: CAL_ID, href: `${CAL_PATH}issue160.ics`, etag: '"1"'
      });
      assert.equal(del.status, 403);
      assert.equal((await del.json()).error, MSG_FORBIDDEN);
    }
  );
});

test('Issue #160 — event edit (PUT) denied upstream arrives as 403 with German text', async () => {
  await withStack(
    (req) => {
      if (req.method === 'PUT') return { status: 403, body: DAV_ERROR_DOC };
      return { status: 404, body: '' };
    },
    async (base) => {
      const put = await json('PUT', `${base}/api/events/issue160`, {
        calendarId: CAL_ID, href: `${CAL_PATH}issue160.ics`, etag: '"1"', title: 'Test User meeting',
        start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z'
      });
      assert.equal(put.status, 403);
      assert.equal((await put.json()).error, MSG_FORBIDDEN);
    }
  );
});

test('Issue #160 — share invite denied upstream / unsupported is German, not a WebDAV error', async () => {
  let sharing = SHARING_STANDARD;
  await withStack(
    (req, body) => {
      if (req.method === 'PROPFIND' && body.includes('invite')) return { status: 207, body: sharing };
      if (req.method === 'PROPFIND') return { status: 207, body: CAL_LIST };
      if (req.method === 'POST') return { status: 403, body: DAV_ERROR_DOC };
      return { status: 405, body: '' };
    },
    async (base) => {
      const url = `${base}/api/calendars/${encodeURIComponent(CAL_ID)}/shares`;
      const denied = await json('POST', url, { sharee: 'mailto:testuser@example.com', readWrite: false });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, MSG_FORBIDDEN);

      const changed = await json('PUT', `${url}/testuser2`, { role: 'WRITE' });
      assert.equal(changed.status, 403);
      assert.equal((await changed.json()).error, MSG_FORBIDDEN);

      const removed = await json('DELETE', url, { sharee: 'mailto:testuser@example.com' });
      assert.equal(removed.status, 403);
      assert.equal((await removed.json()).error, MSG_FORBIDDEN);

      sharing = SHARING_NONE;
      const url2 = `${base}/api/calendars/${encodeURIComponent('acc::/testuser/other/')}/shares`;
      const unsupported = await json('POST', url2, { sharee: 'mailto:testuser@example.com', readWrite: false });
      assert.equal(unsupported.status, 501);
      assert.equal((await unsupported.json()).error, MSG_SHARING_UNSUPPORTED);
    }
  );
});

test('Issue #160 — an unreachable CalDAV server on save is reported in German', async () => {
  // Port 9 on loopback: nothing listens, the connection is refused.
  await withStack(() => ({ status: 500 }), async (base) => {
    const del = await json('DELETE', `${base}/api/tasks/issue160`, {
      calendarId: CAL_ID, href: `${CAL_PATH}issue160.ics`
    });
    assert.equal(del.status, 502);
    assert.equal((await del.json()).error, MSG_CONNECTION);
  }, { davUrlOverride: 'http://127.0.0.1:9/' });
});

test('Issue #160 — a failed account load is German without the underlying error', async () => {
  const cause = 'SQLITE_ERROR: no such table: linked_accounts';
  await withStack(() => ({ status: 500 }), async (base) => {
    const res = await fetch(`${base}/api/accounts`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'Fehler beim Laden der Kontodaten.');
  }, { accountLoadError: cause });
});

test('Issue #160 — webcal events with a failing feed report German, not the refresh error', async () => {
  await Db.upsertUser('testuser', 'testuser', 'testuser@example.com');
  const feed = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>Not Found</html>');
  });
  await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
  const sub = await Db.createWebcalSubscription({
    userId: 'testuser', name: 'Test User feed', url: `http://127.0.0.1:${feed.address().port}/feed.ics`
  });
  try {
    await withStack(() => ({ status: 500 }), async (base) => {
      const range = 'start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z';
      const res = await fetch(`${base}/api/webcal/subscriptions/${sub.id}/events?${range}`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'Der Kalender-Feed konnte nicht abgerufen werden.');
      assert.deepEqual(body.events, []);

      const sync = await fetch(`${base}/api/webcal/subscriptions/${sub.id}/sync`, { method: 'POST' });
      assert.equal(sync.status, 502);
      assert.equal((await sync.json()).error, 'Der Kalender-Feed konnte nicht abgerufen werden.');
    });
  } finally {
    await new Promise(resolve => feed.close(resolve));
  }
});

test('Issue #160 — unmapped English never passes through the sanitizer', () => {
  for (const raw of [
    'Failed to fetch events from CalDAV server',
    'Sharing is not supported by this CalDAV server',
    'SQLITE_ERROR: no such table: linked_accounts',
    'Cannot read properties of undefined (reading \'url\')'
  ]) {
    const out = sanitizeErrorMessage(new Error(raw));
    assert.notEqual(out, raw);
    assertGerman(out, raw);
  }
  assert.equal(sanitizeErrorMessage(new Error('SQLITE_ERROR: no such table')), MSG_GENERIC);
  assert.equal(sanitizeErrorMessage(new Error('DELETE 403: Forbidden')), MSG_FORBIDDEN);
});

test('Issue #160 — status mapping edge cases', () => {
  // AbortSignal.timeout() on a CalDAV request is a connection problem, not a server fault.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.deepEqual(describeError(timeout), { status: 504, message: MSG_CONNECTION });
  // Object.prototype names are not table entries.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(describeError(new Error(name)), { status: 500, message: MSG_GENERIC }, name);
  }
  // A failed If-Match is the reload-and-retry conflict the client reacts to (409);
  // a WebDAV state conflict is not.
  assert.equal(describeError(new Error('ETAG_CONFLICT')).status, 409);
  assert.equal(describeError(new Error('PUT 412: Precondition Failed')).status, 409);
  assert.equal(describeError(new Error('PUT 409: Conflict')).status, 502);
  // Upstream credentials rejected is not the user's session with this app.
  assert.equal(describeError(new Error('PROPFIND 401: Unauthorized')).status, 502);
  assert.equal(describeError(new Error('UNAUTHORIZED')).status, 502);
  // Upstream 5xx is a bad gateway, an upstream 404 stays a 404.
  assert.deepEqual(describeError(new Error('REPORT 503: Service Unavailable')), { status: 502, message: MSG_UPSTREAM_DOWN });
  assert.deepEqual(describeError(new Error('HTTP_500')), { status: 502, message: MSG_UPSTREAM_DOWN });
  assert.equal(describeError(new Error('GET 404: Not Found')).status, 404);
  assert.equal(describeError(new Error('Failed to push event to MS Graph (403): denied')).status, 403);
  // Network errors are recognised by their code, not only by message text.
  const refused = new TypeError('network error');
  refused.cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
  assert.deepEqual(describeError(refused), { status: 502, message: MSG_CONNECTION });
});
