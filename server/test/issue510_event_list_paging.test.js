'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #510 — the list view pages through large ranges. GET /api/events with `limit` sorts and
// filters the whole range on the server and answers one page plus the total, so the browser never
// holds the full range. Runs with production semantics against a loopback CalDAV stub.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue510-paging-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue510.db');
process.env.ENCRYPTION_KEY = 'issue510-strong-encryption-key-for-tests-0123456789';
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

const CALENDARS = [
  { href: '/testuser/work/', name: 'Arbeit' },
  { href: '/testuser/home/', name: 'Zuhause' },
];
const CAL_LIST = multistatus(CALENDARS.map(c =>
  `<d:response><d:href>${c.href}</d:href><d:propstat><d:prop>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${c.name}</d:displayname>` +
  '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join(''));

// title, day in March 2036, location, calendar
const EVENTS = [
  ['Delta', 5, 'Raum B', '/testuser/work/'],
  ['alpha', 2, 'Raum C', '/testuser/home/'],
  ['Echo', 9, '', '/testuser/work/'],
  ['Charlie', 1, 'Raum A', '/testuser/home/'],
  ['Bravo', 7, 'Garten', '/testuser/work/'],
];

function report(href) {
  return multistatus(EVENTS.filter(e => e[3] === href).map(([title, day, loc], i) => {
    const dd = String(day).padStart(2, '0');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${title}`,
      'DTSTAMP:20360301T000000Z', `DTSTART:203603${dd}T100000Z`, `DTEND:203603${dd}T110000Z`,
      `SUMMARY:${title}`, ...(loc ? [`LOCATION:${loc}`] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return `<d:response><d:href>${href}item${i}.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>` +
      `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }).join(''));
}

async function withStack(fn) {
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
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
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

const RANGE = 'start=2036-03-01T00:00:00Z&end=2036-04-01T00:00:00Z';

async function page(base, query) {
  const res = await fetch(`${base}/api/events?${RANGE}&${query}`);
  const body = await res.json();
  return { status: res.status, body };
}

test('limit/offset answer one page in date order plus the total of the range', async () => {
  await withStack(async (base) => {
    const first = await page(base, 'limit=2&offset=0');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.events.map(e => e.title), ['Charlie', 'alpha']);
    assert.equal(first.body.total, 5);
    assert.equal(first.body.offset, 0);
    assert.equal(first.body.limit, 2);
    assert.deepEqual(first.body.errors, []);

    const second = await page(base, 'limit=2&offset=2');
    assert.deepEqual(second.body.events.map(e => e.title), ['Delta', 'Bravo']);
    const last = await page(base, 'limit=2&offset=4');
    assert.deepEqual(last.body.events.map(e => e.title), ['Echo']);
    assert.equal(last.body.total, 5);
  });
});

test('the page is cut after sorting the whole range by title, location or calendar', async () => {
  await withStack(async (base) => {
    const byTitle = await page(base, 'limit=3&sort=title&order=desc');
    assert.deepEqual(byTitle.body.events.map(e => e.title), ['Echo', 'Delta', 'Charlie']);
    const byTitleAsc = await page(base, 'limit=2&sort=title');
    assert.deepEqual(byTitleAsc.body.events.map(e => e.title), ['alpha', 'Bravo']);

    // Events without a location come last in ascending order.
    const byLocation = await page(base, 'limit=5&sort=location');
    assert.deepEqual(byLocation.body.events.map(e => e.title), ['Bravo', 'Charlie', 'Delta', 'alpha', 'Echo']);

    // By calendar name ("Arbeit" before "Zuhause"), then by date.
    const byCalendar = await page(base, 'limit=5&sort=calendar&order=asc');
    assert.deepEqual(byCalendar.body.events.map(e => e.title), ['Delta', 'Bravo', 'Echo', 'Charlie', 'alpha']);
  });
});

test('q filters the range on title and location before paging, case-insensitively', async () => {
  await withStack(async (base) => {
    const raum = await page(base, 'limit=2&q=RAUM');
    assert.deepEqual(raum.body.events.map(e => e.title), ['Charlie', 'alpha']);
    assert.equal(raum.body.total, 3);
    const title = await page(base, 'limit=10&q=echo');
    assert.deepEqual(title.body.events.map(e => e.title), ['Echo']);
    assert.equal(title.body.total, 1);
  });
});

test('invalid paging parameters are refused, not silently replaced', async () => {
  await withStack(async (base) => {
    for (const query of ['limit=0', 'limit=abc', 'limit=501', 'limit=10&offset=-1', 'limit=10&sort=colour',
      'limit=10&order=up']) {
      const res = await page(base, query);
      assert.equal(res.status, 400, query);
    }
  });
});

test('without limit the full range is answered as before', async () => {
  await withStack(async (base) => {
    const res = await fetch(`${base}/api/events?${RANGE}`);
    const body = await res.json();
    assert.equal(body.events.length, 5);
    assert.equal(body.total, undefined);
  });
});
