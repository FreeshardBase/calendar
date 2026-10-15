'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #65 — a calendar that could not be read must never look like an empty
// one. GET /api/events names every failed calendar in an `errors` array even
// when other calendars loaded (partial failure); a body that is not a complete
// DAV multistatus (proxy error page, JSON error, truncated 207) is a failure,
// not "0 events"; event resources are not dropped for their href spelling; and
// a server error on the share lookup is not "no shares". Runs with production
// semantics against a loopback CalDAV stub.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue65-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue65.db');
process.env.ENCRYPTION_KEY = 'issue65-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const { parseEventList, parseCalendarList } = require('../caldav/parser');

const OK_PATH = '/testuser/ok/';
const BAD_PATH = '/testuser/bad/';
const OK_ID = `acc::${OK_PATH}`;
const BAD_ID = `acc::${BAD_PATH}`;
const RANGE = 'start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z';
const RANGE_START = new Date('2026-08-01T00:00:00Z');
const RANGE_END = new Date('2026-09-01T00:00:00Z');
const HTML_502 = '<html><body>502 Bad Gateway';
const JSON_500 = '{"error":"internal"}';

function multistatus(inner) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
    `xmlns:cs="http://calendarserver.org/ns/">${inner}</d:multistatus>`;
}

function calendarResponse(href, name) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname>` +
    '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

const CAL_LIST = multistatus(calendarResponse(OK_PATH, 'Working') + calendarResponse(BAD_PATH, 'Broken'));

function eventResponse(href, uid = 'issue65-evt') {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, 'DTSTAMP:20260801T000000Z', 'DTSTART:20260815T100000Z', 'DTEND:20260815T110000Z',
    'SUMMARY:Visible event', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>` +
    `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const OK_EVENTS = multistatus(eventResponse(`${OK_PATH}e1.ics`));

// handler(req, body) -> { status, body, headers? }
async function withStack(handler, fn) {
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
  const davUrl = `http://127.0.0.1:${dav.address().port}/`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'testuser',
      accounts: [{ id: 'acc', authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
    };
    next();
  });
  app.use('/api/events', eventsRouter);
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origError = console.error;
  console.error = () => {};
  try {
    await fn(base);
  } finally {
    console.error = origError;
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

// One working calendar next to one whose REPORT answers with `badReply`.
function partialStub(badReply) {
  return (req) => {
    if (req.method === 'PROPFIND') return { status: 207, body: CAL_LIST };
    if (req.method === 'REPORT' && req.url === OK_PATH) return { status: 207, body: OK_EVENTS };
    if (req.method === 'REPORT' && req.url === BAD_PATH) return badReply;
    return { status: 405, body: '' };
  };
}

async function assertPartialFailure(base) {
  const res = await fetch(`${base}/api/events?${RANGE}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!Array.isArray(body), 'response must not be a bare array that cannot carry errors');
  assert.deepEqual(body.events.map(e => e.title), ['Visible event']);
  assert.equal(body.events[0].calendarId, OK_ID);
  assert.equal(body.errors.length, 1, `exactly the broken calendar is reported: ${JSON.stringify(body.errors)}`);
  assert.equal(body.errors[0].calendarId, BAD_ID);
  assert.equal(body.errors[0].accountId, 'acc');
  assert.equal(typeof body.errors[0].error, 'string');
  assert.ok(body.errors[0].error.length > 0);
}

test('Issue #65 — one calendar answering 500 next to a working one is named in errors, HTTP 200', async () => {
  await withStack(partialStub({ status: 500, body: 'Internal Server Error', headers: { 'Content-Type': 'text/plain' } }), assertPartialFailure);
});

test('Issue #65 — a proxy error page with status 200 is a failed calendar, not an empty one', async () => {
  await withStack(partialStub({ status: 200, body: HTML_502, headers: { 'Content-Type': 'text/html' } }), assertPartialFailure);
});

test('Issue #65 — a JSON error body with status 207 is a failed calendar, not an empty one', async () => {
  await withStack(partialStub({ status: 207, body: JSON_500, headers: { 'Content-Type': 'application/json' } }), assertPartialFailure);
});

test('Issue #65 — a truncated event REPORT is a failed calendar, not a short one', async () => {
  const truncated = OK_EVENTS.slice(0, OK_EVENTS.indexOf('</d:multistatus>') - 20);
  await withStack(partialStub({ status: 207, body: truncated }), assertPartialFailure);
});

test('Issue #65 — a truncated calendar list fails the account instead of showing no calendars', async () => {
  const truncated = CAL_LIST.slice(0, CAL_LIST.indexOf(BAD_PATH));
  await withStack(
    (req) => req.method === 'PROPFIND' ? { status: 207, body: truncated } : { status: 405, body: '' },
    async (base) => {
      const res = await fetch(`${base}/api/events?${RANGE}`);
      assert.notEqual(res.status, 200, 'a calendar list that could not be read must not render as an empty calendar');
      const body = await res.json();
      assert.equal(body.errors.length, 1);
      assert.equal(body.errors[0].accountId, 'acc');
    }
  );
});

test('Issue #65 — parsers reject bodies that are not a complete DAV multistatus', () => {
  for (const bad of [HTML_502, JSON_500, '', CAL_LIST.slice(0, CAL_LIST.length - 30)]) {
    assert.throws(() => parseCalendarList(bad, 'acc', 'http://127.0.0.1/', 'testuser'), /multistatus/, `calendar list: ${bad.slice(0, 30)}`);
    assert.throws(() => parseEventList(bad, OK_ID, 'acc', 'http://127.0.0.1/testuser/ok/', RANGE_START, RANGE_END), /multistatus/, `event list: ${bad.slice(0, 30)}`);
  }
  // Control: well-formed documents still parse.
  assert.equal(parseCalendarList(CAL_LIST, 'acc', 'http://127.0.0.1/', 'testuser').length, 2);
  assert.equal(parseEventList(OK_EVENTS, OK_ID, 'acc', 'http://127.0.0.1/testuser/ok/', RANGE_START, RANGE_END).length, 1);
  assert.equal(parseEventList(multistatus(''), OK_ID, 'acc', 'http://127.0.0.1/testuser/ok/', RANGE_START, RANGE_END).length, 0);
});

test('Issue #65 — an event resource is kept whatever its href looks like', () => {
  for (const href of ['/cal/e1.ics', '/cal/e1.ICS', '/cal/e1.ics?version=2', '/cal/e1', '/cal/e1%2Eics']) {
    const events = parseEventList(multistatus(eventResponse(href)), 'acc::/cal/', 'acc', 'http://127.0.0.1/cal/', RANGE_START, RANGE_END);
    assert.equal(events.length, 1, `href ${href}`);
    assert.equal(events[0].href, href);
  }
  // A response without calendar-data (e.g. the collection itself) is still skipped.
  const collectionOnly = multistatus('<d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:getetag>"c"</d:getetag></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
  assert.equal(parseEventList(collectionOnly, 'acc::/cal/', 'acc', 'http://127.0.0.1/cal/', RANGE_START, RANGE_END).length, 0);
});

test('Issue #65 — a server error on the share lookup is an error, not "no shares"', async () => {
  let shareStatus = 500;
  await withStack(
    (req, body) => {
      if (req.method === 'PROPFIND' && body.includes('invite')) {
        return shareStatus === 207
          ? { status: 207, body: multistatus(`<d:response><d:href>${OK_PATH}</d:href><d:propstat><d:prop><cs:invite/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`) }
          : { status: shareStatus, body: 'Internal Server Error', headers: { 'Content-Type': 'text/plain' } };
      }
      if (req.method === 'PROPFIND') return { status: 207, body: CAL_LIST };
      return { status: 405, body: '' };
    },
    async (base) => {
      const url = `${base}/api/calendars/${encodeURIComponent(OK_ID)}/shares`;
      const failed = await fetch(url);
      assert.ok(failed.status >= 500, `server error must surface, got ${failed.status}`);
      const body = await failed.json();
      assert.equal(body.shares, undefined, 'no shares list may be claimed');
      assert.equal(typeof body.error, 'string');

      // Control: a real 207 without invites is "no shares".
      shareStatus = 207;
      const empty = await fetch(url);
      assert.equal(empty.status, 200);
      assert.deepEqual((await empty.json()).shares, []);
    }
  );
});
