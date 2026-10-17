'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// #524: the stub CalDAV server of linked accounts listens on 127.0.0.1; allow it like an operator would.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';
// Issue #530 — the public slot query of a booking page must not let anonymous
// clients fan out CalDAV REPORTs against the owner's calendars: it has a
// per-page budget across all client addresses, and the free slots of a
// (page, date) are cached briefly (concurrent queries share one read) and
// dropped when a booking changes them. Production semantics against a
// loopback CalDAV stub that counts REPORTs.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue530-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue530.db');
process.env.ENCRYPTION_KEY = 'issue530-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
delete process.env.CALDAVURL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const availabilityRouter = require('../routes/availability');

const OWNER = 'testuser';
const DAY_MS = 24 * 60 * 60 * 1000;
// A Monday three to four weeks ahead: in the future and inside the one-year booking horizon.
const MONDAY = (() => {
  const d = new Date(Date.now() + 21 * DAY_MS);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
})();
const dayAfter = (n) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const at = (hhmm) => `${MONDAY}T${hhmm}:00.000Z`;

// ── Loopback CalDAV stub ─────────────────────────────────────────────────────
const dav = { store: new Map(), requests: [], failReport: false, server: null, url: null };

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function davHandler(req, body) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  dav.requests.push({ method: req.method, path: p });
  if (req.method === 'REPORT') {
    if (dav.failReport) return { status: 503, body: 'down' };
    const inner = [...dav.store.entries()]
      .filter(([href]) => href.startsWith(p))
      .map(([href, ics]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
        `<d:getetag>"e-${href.length}"</d:getetag><c:calendar-data>${xmlEscape(ics)}</c:calendar-data>` +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
      .join('');
    return {
      status: 207,
      body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        `${inner}</d:multistatus>`
    };
  }
  if (req.method === 'PUT') {
    dav.store.set(p, body);
    return { status: 201, body: '', headers: { ETag: '"new"' } };
  }
  if (req.method === 'DELETE') {
    dav.store.delete(p);
    return { status: 204, body: '' };
  }
  return { status: 405, body: '' };
}

const reports = () => dav.requests.filter(r => r.method === 'REPORT').length;

// ── App under test ───────────────────────────────────────────────────────────
let appServer;
let base;
let CAL_TARGET;
let CAL_BUSY;

test.before(async () => {
  dav.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      // Answer slowly enough that concurrent slot queries overlap.
      setTimeout(() => {
        const out = davHandler(req, body);
        res.writeHead(out.status, { 'Content-Type': 'application/xml; charset=utf-8', ...(out.headers || {}) });
        res.end(out.body || '');
      }, 20);
    });
  });
  await new Promise(resolve => dav.server.listen(0, '127.0.0.1', resolve));
  dav.url = `http://127.0.0.1:${dav.server.address().port}/`;

  await Db.ready;
  await Db.upsertUser(OWNER, OWNER, 'testuser@example.com');
  const account = await Db.addAccount(OWNER, { url: dav.url, username: OWNER, password: 'testpass', displayName: 'Test' });
  CAL_TARGET = `${account.id}::/testuser/bookings/`;
  CAL_BUSY = `${account.id}::/testuser/work/`;

  const app = express();
  // Tests play distinct clients through X-Forwarded-For.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/public/')) {
      req.session = { userId: OWNER, accounts: await Db.getAccounts(OWNER) };
    }
    next();
  });
  app.use('/api', availabilityRouter);
  appServer = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => appServer.close(resolve));
  await new Promise(resolve => dav.server.close(resolve));
});

test.beforeEach(() => {
  dav.store.clear();
  dav.requests.length = 0;
  dav.failReport = false;
});

let ipCounter = 1;
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function createPage(slug, extra = {}) {
  const res = await fetch(`${base}/api/availability-slots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug, title: 'Test Consultation', calendarId: CAL_TARGET,
      durationMinutes: 30, startHour: 9, endHour: 17, daysOfWeek: '0,1,2,3,4,5,6', ...extra
    })
  });
  assert.equal(res.status, 201);
  return res.json();
}

function slotsFor(slug, date = MONDAY, ip = freshIp()) {
  return fetch(`${base}/api/public/availability/${slug}?date=${date}`, { headers: { 'X-Forwarded-For': ip } });
}

async function startsFor(slug, date = MONDAY) {
  const res = await slotsFor(slug, date);
  assert.equal(res.status, 200);
  return (await res.json()).availableSlots.map(s => s.startTime);
}

function book(slug, startTime) {
  return fetch(`${base}/api/public/availability/${slug}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshIp() },
    body: JSON.stringify({ startTime, guestName: 'Test User', guestEmail: 'testuser@example.com' })
  });
}

test('#530 the public slot query is rate-limited per page across client addresses', async () => {
  await createPage('testuser-amplify', { busyCalendarIds: [CAL_BUSY] });
  await createPage('testuser-amplify-b');
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    // A different date each time, so no answer comes from the cache.
    const res = await slotsFor('testuser-amplify', dayAfter(i), freshIp());
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 30).every(s => s === 200), `first queries pass the limiter: ${statuses}`);
  assert.equal(statuses[30], 429);
  // Two calendars per query: at most 30 REPORT bursts reached the CalDAV server.
  assert.ok(reports() <= 30 * 2, `at most 30 REPORT bursts, saw ${reports()} REPORTs`);
  // Another page keeps its own budget.
  assert.equal((await slotsFor('testuser-amplify-b', MONDAY, freshIp())).status, 200);
});

test('#530 cached answers, unknown pages and bad dates do not use up a page budget', async () => {
  await createPage('testuser-budget');
  for (let i = 0; i < 40; i++) {
    assert.equal((await slotsFor('testuser-budget', MONDAY, freshIp())).status, 200);
    assert.equal((await slotsFor('testuser-budget', 'garbage', freshIp())).status, 400);
    assert.equal((await slotsFor(`testuser-missing-${i}`, MONDAY, freshIp())).status, 404);
  }
  assert.equal(reports(), 1, 'only the first query read the calendar');
  // The page still has budget left for 29 more reads of new dates.
  for (let i = 1; i < 30; i++) {
    assert.equal((await slotsFor('testuser-budget', dayAfter(i), freshIp())).status, 200);
  }
  const res = await slotsFor('testuser-budget', dayAfter(30), freshIp());
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  // A date already in the cache is still answered.
  assert.equal((await slotsFor('testuser-budget', dayAfter(29), freshIp())).status, 200);
});

test('#530 repeated and concurrent queries of the same page and date read the calendars once', async () => {
  await createPage('testuser-cached', { busyCalendarIds: [CAL_BUSY] });
  const first = await startsFor('testuser-cached');
  assert.equal(reports(), 2, 'one REPORT per calendar for the first query');
  assert.deepEqual(await startsFor('testuser-cached'), first);
  assert.equal(reports(), 2, 'a repeated query is answered from the cache');

  const concurrent = await Promise.all([1, 2, 3, 4, 5].map(() => slotsFor('testuser-cached', dayAfter(1))));
  assert.deepEqual(concurrent.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(reports(), 4, 'concurrent queries of a new date share one read');
});

test('#530 a booking drops the cached slots, so the booked slot is no longer offered', async () => {
  await createPage('testuser-fresh');
  assert.ok((await startsFor('testuser-fresh')).includes(at('09:30')));
  assert.equal((await book('testuser-fresh', at('09:30'))).status, 201);
  assert.ok(!(await startsFor('testuser-fresh')).includes(at('09:30')));
});

test('#530 a booking re-checks fresh busy time instead of the cached slots', async () => {
  await createPage('testuser-recheck', { busyCalendarIds: [CAL_BUSY] });
  assert.ok((await startsFor('testuser-recheck')).includes(at('11:00')));
  const ymd = MONDAY.replace(/-/g, '');
  dav.store.set('/testuser/work/meeting.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT',
    'UID:meeting', 'DTSTAMP:20350101T000000Z', `DTSTART:${ymd}T110000Z`, `DTEND:${ymd}T120000Z`, 'SUMMARY:Meeting',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
  assert.equal((await book('testuser-recheck', at('11:00'))).status, 409);
});

test('#530 cached slots expire after a minute and are kept per page', async (t) => {
  await createPage('testuser-early', { startHour: 9, endHour: 10 });
  await createPage('testuser-late', { startHour: 13, endHour: 14 });
  const early = await startsFor('testuser-early', dayAfter(2));
  const late = await startsFor('testuser-late', dayAfter(2));
  assert.deepEqual(early, [`${dayAfter(2)}T09:00:00.000Z`, `${dayAfter(2)}T09:30:00.000Z`]);
  assert.deepEqual(late, [`${dayAfter(2)}T13:00:00.000Z`, `${dayAfter(2)}T13:30:00.000Z`]);
  assert.equal(reports(), 2);

  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 61 * 1000);
  await startsFor('testuser-early', dayAfter(2));
  assert.equal(reports(), 3, 'an expired entry is read again');
});

test('#530 a failed calendar read is not cached', async () => {
  await createPage('testuser-retry');
  dav.failReport = true;
  assert.equal((await slotsFor('testuser-retry')).status, 503);
  dav.failReport = false;
  assert.ok((await startsFor('testuser-retry')).includes(at('09:00')));
});
