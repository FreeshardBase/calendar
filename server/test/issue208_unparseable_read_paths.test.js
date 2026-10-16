'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #208 — corruption that reaches the store by a route other than the
// app's own PUT (a lenient external server, an import, the sync worker) must
// not read as "the item simply does not exist" with a 200. Covers the read
// paths #128 left open: the task list and the delta sync. Production semantics.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue208-'));
// The DB opens asynchronously on require; remove its directory only at exit.
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue208.db');
process.env.ENCRYPTION_KEY = 'issue208-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { parseTaskList, parseSyncCollectionResponse } = require('../caldav/parser');
const tasksRouter = require('../routes/tasks');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const CAL_PATH = '/testuser/cal/';
const CAL_ID = `acc::${CAL_PATH}`;

const GOOD_TODO = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Issue208//EN',
  'BEGIN:VTODO', 'UID:issue208-good', 'DTSTAMP:20260801T000000Z', 'SUMMARY:Test User task',
  'END:VTODO', 'END:VCALENDAR'
].join('\r\n');
// What a lenient server may store verbatim: not iCalendar at all.
const BROKEN = 'MEETING WITH TEST USER -- not icalendar';

function resource(href, ics) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag>` +
    `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(inner, token) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    inner + (token ? `<d:sync-token>${token}</d:sync-token>` : '') + '</d:multistatus>';
}

const PROPFIND_BODY = multistatus(
  `<d:response><d:href>${CAL_PATH}</d:href><d:propstat><d:prop>` +
  '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Test</d:displayname>' +
  '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');

async function withStack(router, mountPath, reportBody, fn) {
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(req.method === 'PROPFIND' ? PROPFIND_BODY : reportBody);
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
  app.use(mountPath, router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

test('Issue #208 — parseTaskList hands every unreadable href to the caller', () => {
  const parseErrors = [];
  const xml = multistatus(resource(`${CAL_PATH}good.ics`, GOOD_TODO) + resource(`${CAL_PATH}broken.ics`, BROKEN));
  const tasks = parseTaskList(xml, CAL_ID, 'acc', `http://dav.example.com${CAL_PATH}`, parseErrors);
  assert.deepEqual(tasks.map(t => t.title), ['Test User task']);
  assert.deepEqual(parseErrors.map(e => e.href), [`${CAL_PATH}broken.ics`]);
  assert.ok(parseErrors[0].error, 'the parse error message is passed along');
});

test('Issue #208 — a task REPORT that is not a multistatus fails instead of reading as an empty list', () => {
  assert.throws(() => parseTaskList('<html>502 Bad Gateway</html>', CAL_ID, 'acc', CAL_PATH), /multistatus/);
});

test('Issue #208 — GET /api/tasks returns the readable tasks and names the unreadable one in X-CalDAV-Unparseable', async () => {
  const report = multistatus(resource(`${CAL_PATH}good.ics`, GOOD_TODO) + resource(`${CAL_PATH}broken.ics`, BROKEN));
  await withStack(tasksRouter, '/api/tasks', report, async (base) => {
    const res = await fetch(`${base}/api/tasks`);
    assert.equal(res.status, 200);
    const tasks = await res.json();
    assert.deepEqual(tasks.map(t => t.title), ['Test User task']);
    const header = res.headers.get('x-caldav-unparseable');
    assert.ok(header, 'the dropped task must be reported in X-CalDAV-Unparseable');
    assert.deepEqual(JSON.parse(decodeURIComponent(header)), {
      count: 1,
      resources: [{ calendarId: CAL_ID, href: `${CAL_PATH}broken.ics` }]
    });
  });
});

test('Issue #208 — parseSyncCollectionResponse lists a changed resource it could not parse', () => {
  const parsed = parseSyncCollectionResponse(multistatus(resource(`${CAL_PATH}broken.ics`, BROKEN), 'tok-2'),
    CAL_ID, 'acc', CAL_PATH);
  assert.deepEqual(parsed.updated, []);
  assert.deepEqual(parsed.unparseable, [`${CAL_PATH}broken.ics`]);
});

test('Issue #208 — a delta whose only change is unreadable still reports a change', async () => {
  await Db.upsertCalendarSyncCache(CAL_ID, null, null);
  const report = multistatus(resource(`${CAL_PATH}broken.ics`, BROKEN), 'tok-2');
  await withStack(calendarsRouter, '/api/calendars', report, async (base) => {
    const res = await fetch(`${base}/api/calendars/${encodeURIComponent(CAL_ID)}/delta-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncToken: 'tok-1' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.updated, []);
    assert.deepEqual(body.deleted, []);
    assert.deepEqual(body.unparseable, [`${CAL_PATH}broken.ics`]);
    assert.equal(body.ctagChanged, true);
  });
});

test('Issue #208 — the client does not serve its cached range when a delta names an unreadable resource', async () => {
  // Runs the shipped calendarsUnchanged() from public/js/app.js (as #170 does).
  const appJs = fs.readFileSync(path.resolve(__dirname, '../../public/js/app.js'), 'utf8');
  const source = appJs.match(/async function syncCalendarDelta\([\s\S]*?\nasync function calendarsUnchanged\(\)[\s\S]*?\n\}/);
  assert.ok(source, 'syncCalendarDelta and calendarsUnchanged must exist in app.js');
  const delta = { syncToken: 'tok-2', updated: [], deleted: [], unparseable: [`${CAL_PATH}broken.ics`], fallbackPerformed: false };
  const run = new Function(
    'store', 'CalendarsAPI', 'getCalendarSyncCache', 'setCalendarSyncCache', 'console',
    `${source[0]}\nreturn calendarsUnchanged();`
  );
  const unchanged = await run(
    { get: key => (key === 'calendars' ? [{ id: CAL_ID }] : undefined) },
    { deltaSync: async () => delta },
    () => ({ ctag: null, syncToken: 'tok-1' }),
    () => {},
    { warn: () => {} }
  );
  assert.equal(unchanged, false);
});
