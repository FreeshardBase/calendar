'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #349 — the toolbar search looked only through the events already loaded for the visible
// range. GET /api/events/search searches every calendar on SUMMARY, LOCATION and DESCRIPTION over
// years before and after today, so last month's appointment and next year's birthday are found.
// Runs with production semantics against a loopback CalDAV stub.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue349-search-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue349.db');
process.env.ENCRYPTION_KEY = 'issue349-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');

function multistatus(inner) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `${inner}</d:multistatus>`;
}

const CAL_LIST = multistatus(['/testuser/work/', '/testuser/home/'].map(href =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${href}</d:displayname>` +
  '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join(''));

function icsDate(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '') + 'T100000Z';
}

// uid, days from today, summary, location, description, calendar
const EVENTS = [
  ['dentist', -35, 'Zahnarzt', 'Praxis Mitte', '', '/testuser/work/'],
  ['birthday', 330, 'Geburtstag Test User', '', '', '/testuser/home/'],
  ['checkup', 60, 'Kontrolle', '', 'Termin beim ZAHNARZT bestätigen', '/testuser/home/'],
  ['ortho', 10, 'Besprechung', 'Zahnarzt-Zentrum', '', '/testuser/work/'],
  ['unrelated', 2, 'Team Meeting', 'Raum A', 'Agenda', '/testuser/work/'],
];

function report(href) {
  return multistatus(EVENTS.filter(e => e[5] === href).map(([uid, days, summary, loc, desc]) => {
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${uid}`,
      'DTSTAMP:20260101T000000Z', `DTSTART:${icsDate(days)}`, `DTEND:${icsDate(days).replace('T10', 'T11')}`,
      `SUMMARY:${summary}`, ...(loc ? [`LOCATION:${loc}`] : []), ...(desc ? [`DESCRIPTION:${desc}`] : []),
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return `<d:response><d:href>${href}${uid}.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>` +
      `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }).join(''));
}

async function withStack(fn, { failReports = false } = {}) {
  const reports = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'REPORT') {
        reports.push(body);
        if (failReports) {
          res.writeHead(503);
          res.end('down');
          return;
        }
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(req.method === 'PROPFIND' ? CAL_LIST : report(req.url));
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
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, reports);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

async function search(base, q) {
  const res = await fetch(`${base}/api/events/search?q=${encodeURIComponent(q)}`);
  return { status: res.status, body: await res.json() };
}

test('#349 search finds past and future events in every calendar on title, location and description', async () => {
  await withStack(async (base, reports) => {
    const { status, body } = await search(base, 'zahnarzt');
    assert.equal(status, 200);
    // Date order, across both calendars.
    assert.deepEqual(body.events.map(e => e.uid), ['dentist', 'ortho', 'checkup']);
    assert.equal(body.total, 3);
    assert.deepEqual(body.errors, []);
    // Both calendars were asked, over a window reaching years into the past and the future.
    assert.equal(reports.length, 2);
    const window = reports[0].match(/time-range start="(\d{4})\d{4}T\d{6}Z" end="(\d{4})\d{4}T\d{6}Z"/);
    assert.ok(window, reports[0]);
    const year = new Date().getUTCFullYear();
    assert.ok(Number(window[1]) <= year - 2 && Number(window[2]) >= year + 2, window[0]);
    const yearsAway = iso => Math.abs(new Date(iso) - Date.now()) / (365 * 86400000);
    assert.ok(yearsAway(body.rangeStart) > 2 && new Date(body.rangeStart) < new Date(), body.rangeStart);
    assert.ok(yearsAway(body.rangeEnd) > 2 && new Date(body.rangeEnd) > new Date(), body.rangeEnd);

    const birthday = await search(base, '  GEBURTSTAG ');
    assert.deepEqual(birthday.body.events.map(e => e.uid), ['birthday']);
    assert.equal(birthday.body.events[0].calendarId.endsWith('/testuser/home/'), true);
  });
});

test('#349 search refuses a missing or one-letter query and an anonymous caller', async () => {
  await withStack(async (base) => {
    assert.equal((await search(base, '')).status, 400);
    assert.equal((await search(base, ' z ')).status, 400);
  });
  const app = express();
  app.use((req, res, next) => { req.session = {}; next(); });
  app.use('/api/events', eventsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/events/search?q=zahnarzt`);
    assert.equal(res.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('#349 search reports unreadable calendars instead of answering an empty result', async () => {
  await withStack(async (base) => {
    const { status, body } = await search(base, 'zahnarzt');
    assert.notEqual(status, 200);
    assert.equal(body.errors.length, 2);
  }, { failReports: true });
});
