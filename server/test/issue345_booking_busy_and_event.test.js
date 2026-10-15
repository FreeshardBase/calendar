'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #345 — a public booking page must (1) offer no slot that collides with
// busy time in the calendars the owner selected (recurrence-expanded,
// TRANSP:TRANSPARENT ignored), (2) write a VEVENT with the booker as ATTENDEE
// into the page's calendar together with the booking row, and (3) rate-limit
// the public booking endpoint per IP and per page. Production semantics
// against a loopback CalDAV stub that stores what it is sent.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue345-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue345.db');
process.env.ENCRYPTION_KEY = 'issue345-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
delete process.env.CALDAVURL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ICAL = require('ical.js');

const Db = require('../db');
const availabilityRouter = require('../routes/availability');

const OWNER = 'testuser';
const OTHER = 'otheruser';
// A Monday three to four weeks ahead: in the future and inside the one-year booking horizon.
const MONDAY = (() => {
  const d = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
})();
const SERIES_START = new Date(Date.parse(`${MONDAY}T10:00:00Z`) - 14 * 24 * 60 * 60 * 1000)
  .toISOString().slice(0, 10).replace(/-/g, '');

// ── Loopback CalDAV stub ─────────────────────────────────────────────────────
// store: Map<path, ics>. Collections are path prefixes ending in '/'.
const dav = {
  store: new Map(),
  failPut: false,
  failReportFor: null,
  requests: [],
  server: null,
  url: null
};

function multistatus(inner) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `${inner}</d:multistatus>`;
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function davHandler(req, body) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  dav.requests.push({ method: req.method, path: p, headers: req.headers, body });
  if (req.method === 'REPORT') {
    if (dav.failReportFor && p === dav.failReportFor) return { status: 503, body: 'down' };
    const inner = [...dav.store.entries()]
      .filter(([href]) => href.startsWith(p))
      .map(([href, ics]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
        `<d:getetag>"e-${href.length}"</d:getetag><c:calendar-data>${xmlEscape(ics)}</c:calendar-data>` +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
      .join('');
    return { status: 207, body: multistatus(inner) };
  }
  if (req.method === 'PUT') {
    if (dav.failPut) return { status: 500, body: 'boom' };
    if (req.headers['if-none-match'] === '*' && dav.store.has(p)) return { status: 412, body: '' };
    dav.store.set(p, body);
    return { status: 201, body: '', headers: { ETag: '"new"' } };
  }
  if (req.method === 'DELETE') {
    dav.store.delete(p);
    return { status: 204, body: '' };
  }
  return { status: 405, body: '' };
}

function vevent(uid, lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${uid}`,
    'DTSTAMP:20350101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

function eventsIn(collection) {
  return [...dav.store.entries()].filter(([href]) => href.startsWith(collection));
}

// ── App under test ───────────────────────────────────────────────────────────
let appServer;
let base;
let ownerAccount;
let otherAccount;
let CAL_TARGET;
let CAL_BUSY;
let CAL_IGNORED;

test.before(async () => {
  dav.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const out = davHandler(req, body);
      res.writeHead(out.status, { 'Content-Type': 'application/xml; charset=utf-8', ...(out.headers || {}) });
      res.end(out.body || '');
    });
  });
  await new Promise(resolve => dav.server.listen(0, '127.0.0.1', resolve));
  dav.url = `http://127.0.0.1:${dav.server.address().port}/`;

  await Db.ready;
  await Db.upsertUser(OWNER, OWNER, 'testuser@example.com');
  await Db.upsertUser(OTHER, OTHER, 'otheruser@example.com');
  ownerAccount = await Db.addAccount(OWNER, { url: dav.url, username: OWNER, password: 'testpass', displayName: 'Test' });
  otherAccount = await Db.addAccount(OTHER, { url: dav.url, username: OTHER, password: 'otherpass', displayName: 'Other' });
  CAL_TARGET = `${ownerAccount.id}::/testuser/bookings/`;
  CAL_BUSY = `${ownerAccount.id}::/testuser/work/`;
  CAL_IGNORED = `${ownerAccount.id}::/testuser/hobby/`;

  const app = express();
  // Tests play distinct clients through X-Forwarded-For.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(async (req, res, next) => {
    // The public endpoints carry no session, exactly as for an anonymous booker.
    if (!req.path.startsWith('/api/public/')) {
      const userId = req.get('x-test-user') || OWNER;
      req.session = { userId, accounts: await Db.getAccounts(userId) };
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
  dav.failPut = false;
  dav.failReportFor = null;
});

let ipCounter = 1;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function createPage(slug, extra = {}, user = OWNER) {
  const res = await fetch(`${base}/api/availability-slots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify({
      slug, title: 'Test Consultation', calendarId: CAL_TARGET,
      durationMinutes: 30, startHour: 9, endHour: 17, daysOfWeek: '1,2,3,4,5', ...extra
    })
  });
  return res;
}

async function slotsFor(slug, date = MONDAY, ip = freshIp()) {
  const res = await fetch(`${base}/api/public/availability/${slug}?date=${date}`, { headers: { 'X-Forwarded-For': ip } });
  return res;
}

function book(slug, startTime, ip = freshIp(), guest = {}) {
  return fetch(`${base}/api/public/availability/${slug}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ startTime, guestName: 'Test User', guestEmail: 'testuser@example.com', notes: 'Hello', ...guest })
  });
}

const at = (hhmm) => `${MONDAY}T${hhmm}:00.000Z`;

test('#345 offered slots exclude busy time from the selected calendars (recurring, opaque) but not transparent or unselected events', async () => {
  // Weekly series that started weeks earlier: only an expanded occurrence hits MONDAY.
  dav.store.set('/testuser/work/standup.ics', vevent('standup', [
    `DTSTART:${SERIES_START}T100000Z`, `DTEND:${SERIES_START}T110000Z`, 'RRULE:FREQ=DAILY', 'SUMMARY:Standup']));
  dav.store.set('/testuser/work/focus.ics', vevent('focus', [
    `DTSTART:${MONDAY.replace(/-/g, '')}T140000Z`, `DTEND:${MONDAY.replace(/-/g, '')}T150000Z`,
    'TRANSP:TRANSPARENT', 'SUMMARY:Focus (free)']));
  dav.store.set('/testuser/bookings/lunch.ics', vevent('lunch', [
    `DTSTART:${MONDAY.replace(/-/g, '')}T130000Z`, `DTEND:${MONDAY.replace(/-/g, '')}T133000Z`, 'SUMMARY:Lunch']));
  dav.store.set('/testuser/hobby/gym.ics', vevent('gym', [
    `DTSTART:${MONDAY.replace(/-/g, '')}T150000Z`, `DTEND:${MONDAY.replace(/-/g, '')}T160000Z`, 'SUMMARY:Gym']));

  const created = await createPage('testuser-busy', { busyCalendarIds: [CAL_BUSY] });
  assert.equal(created.status, 201);
  const page = await created.json();
  assert.deepEqual(page.busyCalendarIds, [CAL_BUSY]);

  const res = await slotsFor('testuser-busy');
  assert.equal(res.status, 200);
  const starts = (await res.json()).availableSlots.map(s => s.startTime);

  assert.ok(starts.includes(at('09:00')), 'a free slot is offered');
  assert.ok(!starts.includes(at('10:00')) && !starts.includes(at('10:30')), 'recurring occurrence in a busy calendar blocks');
  assert.ok(!starts.includes(at('13:00')), 'an event in the booking calendar itself blocks');
  assert.ok(starts.includes(at('14:00')) && starts.includes(at('14:30')), 'TRANSP:TRANSPARENT does not block');
  assert.ok(starts.includes(at('15:00')), 'a calendar the owner did not select does not block');

  // Every CalDAV request carries Accept-Encoding: identity.
  assert.ok(dav.requests.length > 0);
  for (const r of dav.requests) assert.equal(r.headers['accept-encoding'], 'identity');
});

test('#345 a booking into busy time is refused even when the client posts the start time directly', async () => {
  dav.store.set('/testuser/work/meeting.ics', vevent('meeting', [
    `DTSTART:${MONDAY.replace(/-/g, '')}T110000Z`, `DTEND:${MONDAY.replace(/-/g, '')}T120000Z`, 'SUMMARY:Meeting']));
  assert.equal((await createPage('testuser-direct', { busyCalendarIds: [CAL_BUSY] })).status, 201);

  const res = await book('testuser-direct', at('11:00'));
  assert.equal(res.status, 409);
  assert.deepEqual(eventsIn('/testuser/bookings/'), []);
  const page = await Db.getAvailabilityPageBySlug('testuser-direct');
  assert.deepEqual(await Db.getSlotBookingsForPage(page.id), []);
});

test('#345 a busy calendar that cannot be read fails the slot query instead of offering colliding slots', async () => {
  assert.equal((await createPage('testuser-down', { busyCalendarIds: [CAL_BUSY] })).status, 201);
  dav.failReportFor = '/testuser/work/';
  const res = await slotsFor('testuser-down');
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.availableSlots, undefined);
});

test('#345 the page owner may only select calendars they can read', async () => {
  const foreignAccount = await createPage('testuser-steal', { busyCalendarIds: [`${otherAccount.id}::/otheruser/cal/`] });
  assert.equal(foreignAccount.status, 404);
  const foreignInternal = await createPage('testuser-steal2', { busyCalendarIds: ['internal-caldav::/otheruser/private/'] });
  assert.equal(foreignInternal.status, 404);
  const notArray = await createPage('testuser-bad', { busyCalendarIds: CAL_BUSY });
  assert.equal(notArray.status, 400);
  assert.equal(await Db.getAvailabilityPageBySlug('testuser-steal'), null);
  assert.equal(await Db.getAvailabilityPageBySlug('testuser-steal2'), null);
  assert.equal(await Db.getAvailabilityPageBySlug('testuser-bad'), null);
});

test('#345 a booking writes a VEVENT with the booker as ATTENDEE into the page calendar and records its UID', async () => {
  assert.equal((await createPage('testuser-event')).status, 201);
  const res = await book('testuser-event', at('09:30'), freshIp(), { guestName: 'Test Guest', notes: 'Project kickoff' });
  assert.equal(res.status, 201);
  const body = await res.json();

  const stored = eventsIn('/testuser/bookings/');
  assert.equal(stored.length, 1, 'exactly one event in the page calendar');
  const [href, ics] = stored[0];
  const comp = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent');
  const ev = new ICAL.Event(comp);
  assert.equal(ev.startDate.toJSDate().toISOString(), at('09:30'));
  assert.equal(ev.endDate.toJSDate().toISOString(), at('10:00'));
  assert.match(ev.summary, /Test Guest/);
  assert.match(ev.description, /Project kickoff/);
  const attendee = comp.getFirstProperty('attendee');
  assert.ok(attendee, 'ATTENDEE present');
  assert.equal(attendee.getFirstValue().toLowerCase(), 'mailto:testuser@example.com');
  assert.equal(attendee.getParameter('cn'), 'Test Guest');
  assert.equal(String(comp.getFirstPropertyValue('transp') || 'OPAQUE').toUpperCase(), 'OPAQUE');
  assert.equal(href, `/testuser/bookings/${encodeURIComponent(ev.uid)}.ics`);

  assert.equal(body.booking.eventUid, ev.uid);
  const page = await Db.getAvailabilityPageBySlug('testuser-event');
  const rows = await Db.getSlotBookingsForPage(page.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventUid, ev.uid);

  // The new event blocks the slot for the next booker.
  const starts = (await (await slotsFor('testuser-event')).json()).availableSlots.map(s => s.startTime);
  assert.ok(!starts.includes(at('09:30')));
  assert.equal((await book('testuser-event', at('09:30'))).status, 409);
});

test('#345 a failed calendar write leaves no booking row behind', async () => {
  assert.equal((await createPage('testuser-putfail')).status, 201);
  dav.failPut = true;
  const res = await book('testuser-putfail', at('10:00'));
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  const page = await Db.getAvailabilityPageBySlug('testuser-putfail');
  assert.deepEqual(await Db.getSlotBookingsForPage(page.id), []);
});

test('#345 a failed booking row removes the calendar event again', async () => {
  assert.equal((await createPage('testuser-dbfail')).status, 201);
  const original = Db.createSlotBooking;
  Db.createSlotBooking = async () => { throw new Error('SQLITE_FULL: database or disk is full'); };
  let res;
  try {
    res = await book('testuser-dbfail', at('10:00'));
  } finally {
    Db.createSlotBooking = original;
  }
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  assert.deepEqual(eventsIn('/testuser/bookings/'), [], 'the orphaned event was deleted');
  assert.ok(dav.requests.some(r => r.method === 'DELETE'));
});

test('#345 concurrent bookings of the same slot produce exactly one booking and one event', async () => {
  assert.equal((await createPage('testuser-race')).status, 201);
  const results = await Promise.all([1, 2, 3].map(() => book('testuser-race', at('12:00'))));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);
  assert.equal(eventsIn('/testuser/bookings/').length, 1);
  const page = await Db.getAvailabilityPageBySlug('testuser-race');
  assert.equal((await Db.getSlotBookingsForPage(page.id)).length, 1);
});

test('#345 the booking endpoint is rate-limited per client IP', async () => {
  assert.equal((await createPage('testuser-iplimit')).status, 201);
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    // Invalid bodies: the limit counts attempts, not only successful bookings.
    const res = await book('testuser-iplimit', 'not-a-time', ip);
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 10).every(s => s === 400), `first attempts pass the limiter: ${statuses}`);
  assert.deepEqual(statuses.slice(10), [429, 429]);
  // Another client is unaffected.
  assert.equal((await book('testuser-iplimit', 'not-a-time', freshIp())).status, 400);
});

test('#345 the booking endpoint is rate-limited per page across client IPs', async () => {
  assert.equal((await createPage('testuser-pagelimit')).status, 201);
  assert.equal((await createPage('testuser-pagelimit-b')).status, 201);
  const statuses = [];
  for (let i = 0; i < 32; i++) {
    // Well-formed attempts at a time that is no slot: they count, but book nothing.
    const res = await book('testuser-pagelimit', at('08:00'), freshIp());
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 30).every(s => s === 409), `first attempts pass the limiter: ${statuses}`);
  assert.deepEqual(statuses.slice(30), [429, 429]);
  // Another page is unaffected.
  assert.equal((await book('testuser-pagelimit-b', at('08:00'), freshIp())).status, 409);
});

function withDavHandler(handler, fn) {
  const original = dav.server.listeners('request')[0];
  dav.server.removeAllListeners('request');
  dav.server.on('request', (req, res) => handler(req, res, original));
  return fn().finally(() => {
    dav.server.removeAllListeners('request');
    dav.server.on('request', original);
  });
}

test('#345 a busy calendar answering with something other than a DAV multistatus fails the slot query', async () => {
  assert.equal((await createPage('testuser-garbled', { busyCalendarIds: [CAL_BUSY] })).status, 201);
  await withDavHandler((req, res, original) => {
    if (req.method !== 'REPORT' || !req.url.startsWith('/testuser/work/')) return original(req, res);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Login</body></html>');
  }, async () => {
    const res = await slotsFor('testuser-garbled');
    assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  });
});

test('#345 an upstream credential failure reaches the booker as "page unavailable", not as a login prompt', async () => {
  assert.equal((await createPage('testuser-cred')).status, 201);
  await withDavHandler((req, res) => {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
  }, async () => {
    const res = await slotsFor('testuser-cred');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'Diese Buchungsseite ist derzeit nicht verfügbar.');
    const bookRes = await book('testuser-cred', at('09:00'));
    assert.equal(bookRes.status, 503);
  });
});

test('#345 slots in the past are neither offered nor bookable', async () => {
  assert.equal((await createPage('testuser-past', { daysOfWeek: '0,1,2,3,4,5,6' })).status, 201);
  const res = await slotsFor('testuser-past', '2020-01-06');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).availableSlots, []);
  assert.equal((await book('testuser-past', '2020-01-06T09:00:00.000Z')).status, 409);
  assert.deepEqual(eventsIn('/testuser/bookings/'), []);
});

test('#345 a start time that is not in slot format is rejected as a bad request', async () => {
  assert.equal((await createPage('testuser-format')).status, 201);
  assert.equal((await book('testuser-format', `${MONDAY} 10:00`)).status, 400);
});

test('#345 malformed booking attempts do not use up the page budget', async () => {
  assert.equal((await createPage('testuser-junk')).status, 201);
  for (let i = 0; i < 35; i++) {
    assert.equal((await book('testuser-junk', 'not-a-time', freshIp())).status, 400);
  }
  assert.equal((await book('testuser-junk', at('09:00'))).status, 201);
});

test('#345 deleting a calendar removes it from the busy calendars of other pages', async () => {
  assert.equal((await createPage('testuser-del', { busyCalendarIds: [CAL_BUSY, CAL_IGNORED] })).status, 201);
  await Db.deleteCalendarData(CAL_BUSY);
  const page = await Db.getAvailabilityPageBySlug('testuser-del');
  assert.deepEqual(page.busyCalendarIds, [CAL_IGNORED]);
  assert.equal((await slotsFor('testuser-del')).status, 200);
});
