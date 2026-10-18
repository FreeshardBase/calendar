'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #498 (CI failure of PR #563) — GET /api/tasks and GET /api/events sent one REPORT per
// collection, all at once. Radicale drops connections when ~60-100 arrive together ("fetch failed"),
// and the routes then answered 200 without those lists, so the task list lacked whole lists of a user
// with many collections. The routes keep at most CALDAV_REPORT_CONCURRENCY REPORTs in flight per
// account and still return every collection's items. Runs with production semantics against a
// loopback CalDAV stub that counts the REPORTs it is serving at once.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue498-fanout-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue498.db');
process.env.ENCRYPTION_KEY = 'issue498-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');
const tasksRouter = require('../routes/tasks');
const { CALDAV_REPORT_CONCURRENCY } = require('../utils/caldavFanout');

const COLLECTIONS = 30;
const paths = Array.from({ length: COLLECTIONS }, (_, i) => `/testuser/list${i}/`);

function multistatus(inner) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `${inner}</d:multistatus>`;
}

const CAL_LIST = multistatus(paths.map((href, i) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>List ${i}</d:displayname>` +
  '<c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join(''));

function item(href, i, isTask) {
  const comp = isTask
    ? ['BEGIN:VTODO', `UID:task-${i}`, 'DTSTAMP:20360301T000000Z', `SUMMARY:Task ${i}`, 'STATUS:NEEDS-ACTION', 'END:VTODO']
    : ['BEGIN:VEVENT', `UID:event-${i}`, 'DTSTAMP:20360301T000000Z', 'DTSTART:20360305T100000Z',
      'DTEND:20360305T110000Z', `SUMMARY:Event ${i}`, 'END:VEVENT'];
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...comp, 'END:VCALENDAR'].join('\r\n');
  return multistatus(`<d:response><d:href>${href}item${i}.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>` +
    `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
}

async function withStack(fn) {
  const stats = { inFlight: 0, maxInFlight: 0, reports: 0 };
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(CAL_LIST);
        return;
      }
      const index = paths.indexOf(req.url);
      if (req.method !== 'REPORT' || index === -1) {
        res.writeHead(405);
        res.end();
        return;
      }
      stats.reports++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      // Long enough that requests sent together overlap here.
      setTimeout(() => {
        stats.inFlight--;
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(item(req.url, index, body.includes('VTODO')));
      }, 20);
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.address().port}/testuser/`;

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
  app.use('/api/tasks', tasksRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, stats);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

test('the limit is a small number that still overlaps requests', () => {
  assert.ok(Number.isInteger(CALDAV_REPORT_CONCURRENCY));
  assert.ok(CALDAV_REPORT_CONCURRENCY >= 2 && CALDAV_REPORT_CONCURRENCY <= 8, String(CALDAV_REPORT_CONCURRENCY));
});

test('GET /api/tasks reads every collection with a bounded number of REPORTs in flight', async () => {
  await withStack(async (base, stats) => {
    const res = await fetch(`${base}/api/tasks`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-caldav-error'), null);
    const tasks = await res.json();
    assert.deepEqual(tasks.map(t => t.title).sort(), paths.map((_, i) => `Task ${i}`).sort());
    assert.equal(stats.reports, COLLECTIONS);
    assert.ok(stats.maxInFlight <= CALDAV_REPORT_CONCURRENCY,
      `at most ${CALDAV_REPORT_CONCURRENCY} REPORTs at once, saw ${stats.maxInFlight}`);
  });
});

test('GET /api/events reads every collection with a bounded number of REPORTs in flight', async () => {
  await withStack(async (base, stats) => {
    const res = await fetch(`${base}/api/events?start=2036-03-01T00:00:00Z&end=2036-04-01T00:00:00Z`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.events.map(e => e.title).sort(), paths.map((_, i) => `Event ${i}`).sort());
    assert.equal(stats.reports, COLLECTIONS);
    assert.ok(stats.maxInFlight <= CALDAV_REPORT_CONCURRENCY,
      `at most ${CALDAV_REPORT_CONCURRENCY} REPORTs at once, saw ${stats.maxInFlight}`);
  });
});

test('GET /api/events/invitations scans every collection with a bounded number of REPORTs in flight', async () => {
  await withStack(async (base, stats) => {
    const res = await fetch(`${base}/api/events/invitations`);
    assert.equal(res.status, 200);
    assert.equal(stats.reports, COLLECTIONS);
    assert.ok(stats.maxInFlight <= CALDAV_REPORT_CONCURRENCY,
      `at most ${CALDAV_REPORT_CONCURRENCY} REPORTs at once, saw ${stats.maxInFlight}`);
  });
});
