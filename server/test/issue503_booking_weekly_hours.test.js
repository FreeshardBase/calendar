'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// #524: the stub CalDAV server of linked accounts listens on 127.0.0.1; allow it like an operator would.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';
// Issue #503 — "Buchbare Zeiten" have per-weekday time windows (each weekday on or off, one or
// more non-overlapping windows), a buffer around busy time, a maximum number of bookings per day
// and a minimum notice. The public slot list and the booking endpoint both obey them, and a new
// page without settings keeps the old default (Mon–Fri 09:00–17:00). Production semantics against
// a loopback CalDAV stub.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue503-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue503.db');
process.env.ENCRYPTION_KEY = 'issue503-strong-encryption-key-for-tests-0123456789';
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
const plusDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const TUESDAY = plusDays(MONDAY, 1);
const SATURDAY = plusDays(MONDAY, 5);
const SUNDAY = plusDays(MONDAY, 6);
const at = (hhmm, date = MONDAY) => `${date}T${hhmm}:00.000Z`;
const w = (start, end) => ({ start, end });

// ── Loopback CalDAV stub ─────────────────────────────────────────────────────
const dav = { store: new Map(), server: null, url: null };

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function davHandler(req, body) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'REPORT') {
    const inner = [...dav.store.entries()]
      .filter(([href]) => href.startsWith(p))
      .map(([href, ics]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
        `<d:getetag>"e-${href.length}"</d:getetag><c:calendar-data>${xmlEscape(ics)}</c:calendar-data>` +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
      .join('');
    return {
      status: 207,
      body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`
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

function busyEvent(uid, date, from, to) {
  const d = date.replace(/-/g, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${uid}`,
    'DTSTAMP:20350101T000000Z', `DTSTART:${d}T${from.replace(':', '')}00Z`, `DTEND:${d}T${to.replace(':', '')}00Z`,
    'SUMMARY:Busy', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

// ── App under test ───────────────────────────────────────────────────────────
let appServer;
let base;
let CAL_TARGET;

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
  const account = await Db.addAccount(OWNER, { url: dav.url, username: OWNER, password: 'testpass', displayName: 'Test' });
  CAL_TARGET = `${account.id}::/testuser/bookings/`;

  const app = express();
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
});

let ipCounter = 1;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function createPage(slug, extra = {}) {
  return fetch(`${base}/api/availability-slots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, title: 'Test Consultation', calendarId: CAL_TARGET, durationMinutes: 30, ...extra })
  });
}

async function slotStarts(slug, date = MONDAY) {
  const res = await fetch(`${base}/api/public/availability/${slug}?date=${date}`, { headers: { 'X-Forwarded-For': freshIp() } });
  assert.equal(res.status, 200);
  return (await res.json()).availableSlots.map(s => s.startTime.slice(11, 16));
}

function book(slug, startTime) {
  return fetch(`${base}/api/public/availability/${slug}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshIp() },
    body: JSON.stringify({ startTime, guestName: 'Test User', guestEmail: 'testuser@example.com' })
  });
}

const halfHours = (fromHour, toHour) => {
  const out = [];
  for (let h = fromHour; h < toHour; h++) out.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`);
  return out;
};

test('#503 a new page without settings is open Monday to Friday 09:00–17:00 with no buffer, cap or notice', async () => {
  const res = await createPage('testuser-default');
  assert.equal(res.status, 201);
  const page = await res.json();
  assert.deepEqual(page.weeklyHours, [[], [w('09:00', '17:00')], [w('09:00', '17:00')], [w('09:00', '17:00')],
    [w('09:00', '17:00')], [w('09:00', '17:00')], []]);
  assert.equal(page.bufferMinutes, 0);
  assert.equal(page.maxBookingsPerDay, null);
  assert.equal(page.minNoticeMinutes, 0);

  assert.deepEqual(await slotStarts('testuser-default'), halfHours(9, 17));
  assert.deepEqual(await slotStarts('testuser-default', SATURDAY), []);
  assert.deepEqual(await slotStarts('testuser-default', SUNDAY), []);
});

test('#503 each weekday has its own windows; only slots inside them are offered and bookable', async () => {
  const weeklyHours = [[], [w('14:00', '15:00'), w('09:00', '10:00')], [], [], [], [], [w('10:00', '11:00')]];
  const res = await createPage('testuser-windows', { weeklyHours });
  assert.equal(res.status, 201);
  // Stored sorted by start time.
  assert.deepEqual((await res.json()).weeklyHours[1], [w('09:00', '10:00'), w('14:00', '15:00')]);
  const listed = (await (await fetch(`${base}/api/availability-slots`)).json()).find(p => p.slug === 'testuser-windows');
  assert.deepEqual(listed.weeklyHours[6], [w('10:00', '11:00')]);

  assert.deepEqual(await slotStarts('testuser-windows'), ['09:00', '09:30', '14:00', '14:30']);
  assert.deepEqual(await slotStarts('testuser-windows', TUESDAY), []);
  assert.deepEqual(await slotStarts('testuser-windows', SATURDAY), ['10:00', '10:30']);

  // The server enforces the windows itself, not only the slot list.
  assert.equal((await book('testuser-windows', at('12:00'))).status, 409);
  assert.equal((await book('testuser-windows', at('09:00', TUESDAY))).status, 409);
  assert.equal((await book('testuser-windows', at('16:00'))).status, 409);
  assert.equal((await book('testuser-windows', at('14:30'))).status, 201);
  assert.equal((await book('testuser-windows', at('10:00', SATURDAY))).status, 201);
});

test('#503 busy time from the calendars is still subtracted inside the windows', async () => {
  dav.store.set('/testuser/bookings/busy.ics', busyEvent('busy-1', MONDAY, '09:30', '10:00'));
  assert.equal((await createPage('testuser-busy', { weeklyHours: [[], [w('09:00', '11:00')], [], [], [], [], []] })).status, 201);
  assert.deepEqual(await slotStarts('testuser-busy'), ['09:00', '10:00', '10:30']);
  assert.equal((await book('testuser-busy', at('09:30'))).status, 409);
});

test('#503 overlapping, inverted or malformed windows are rejected and create no page', async () => {
  const bad = [
    [[], [w('09:00', '12:00'), w('11:00', '13:00')], [], [], [], [], []],
    [[], [w('09:00', '12:00'), w('09:00', '10:00')], [], [], [], [], []],
    [[], [w('12:00', '09:00')], [], [], [], [], []],
    [[], [w('10:00', '10:00')], [], [], [], [], []],
    [[], [w('9:00', '12:00')], [], [], [], [], []],
    [[], [w('09:00', '24:30')], [], [], [], [], []],
    [[], [{ start: '09:00' }], [], [], [], [], []],
    [[w('09:00', '12:00')], [], [], [], [], []],
    [[], [], [], [], [], [], []],
    'Mo 09:00-12:00'
  ];
  for (const [i, weeklyHours] of bad.entries()) {
    const res = await createPage(`testuser-bad-${i}`, { weeklyHours });
    assert.equal(res.status, 400, `case ${i}: ${JSON.stringify(weeklyHours)}`);
    assert.equal(await Db.getAvailabilityPageBySlug(`testuser-bad-${i}`), null);
  }
  // Windows that only touch do not overlap; 24:00 closes the day.
  const ok = await createPage('testuser-touching', { weeklyHours: [[], [w('09:00', '12:00'), w('12:00', '24:00')], [], [], [], [], []] });
  assert.equal(ok.status, 201);
});

test('#503 the buffer keeps slots that distance away from busy time and bookings', async () => {
  dav.store.set('/testuser/bookings/meeting.ics', busyEvent('meeting-1', MONDAY, '10:00', '10:30'));
  const weeklyHours = [[], [w('09:00', '13:00')], [], [], [], [], []];
  assert.equal((await createPage('testuser-buffer', { weeklyHours, bufferMinutes: 15 })).status, 201);
  // 09:30 ends at the meeting start and 10:30 starts at its end: both lie inside the buffer.
  assert.deepEqual(await slotStarts('testuser-buffer'), ['09:00', '11:00', '11:30', '12:00', '12:30']);
  assert.equal((await book('testuser-buffer', at('10:30'))).status, 409);
  assert.equal((await book('testuser-buffer', at('11:00'))).status, 201);
  // The new booking's own buffer takes 11:30 (it starts where the booking ends).
  assert.deepEqual(await slotStarts('testuser-buffer'), ['09:00', '12:00', '12:30']);
  assert.equal((await book('testuser-buffer', at('11:30'))).status, 409);
});

test('#503 the maximum number of bookings per day closes the day once reached', async () => {
  assert.equal((await createPage('testuser-cap', { maxBookingsPerDay: 2 })).status, 201);
  assert.equal((await book('testuser-cap', at('09:00'))).status, 201);
  assert.equal((await slotStarts('testuser-cap')).length, 15);
  assert.equal((await book('testuser-cap', at('11:00'))).status, 201);
  assert.deepEqual(await slotStarts('testuser-cap'), []);
  assert.equal((await book('testuser-cap', at('14:00'))).status, 409);
  // Other days are unaffected.
  assert.deepEqual(await slotStarts('testuser-cap', TUESDAY), halfHours(9, 17));
});

test('#503 the minimum notice hides and refuses slots that start too soon', async () => {
  // MONDAY is 21–27 days ahead; the notice of 40 days covers it but not the Monday three weeks later.
  assert.equal((await createPage('testuser-notice', { minNoticeMinutes: 40 * 24 * 60 })).status, 201);
  assert.deepEqual(await slotStarts('testuser-notice'), []);
  assert.equal((await book('testuser-notice', at('09:00'))).status, 409);
  const later = plusDays(MONDAY, 21);
  assert.deepEqual(await slotStarts('testuser-notice', later), halfHours(9, 17));
  assert.equal((await book('testuser-notice', at('09:00', later))).status, 201);
});

test('#503 buffer, maximum per day and notice must be whole numbers in range', async () => {
  const bad = [
    { bufferMinutes: -5 }, { bufferMinutes: 7.5 }, { bufferMinutes: '15' }, { bufferMinutes: 24 * 60 + 1 },
    { maxBookingsPerDay: 0 }, { maxBookingsPerDay: 1.5 }, { maxBookingsPerDay: 'many' },
    { minNoticeMinutes: -1 }, { minNoticeMinutes: 366 * 24 * 60 }
  ];
  for (const [i, extra] of bad.entries()) {
    const res = await createPage(`testuser-range-${i}`, extra);
    assert.equal(res.status, 400, `case ${i}: ${JSON.stringify(extra)}`);
  }
  const res = await createPage('testuser-range-ok', { bufferMinutes: 10, maxBookingsPerDay: 3, minNoticeMinutes: 120 });
  assert.equal(res.status, 201);
  const page = await Db.getAvailabilityPageBySlug('testuser-range-ok');
  assert.equal(page.bufferMinutes, 10);
  assert.equal(page.maxBookingsPerDay, 3);
  assert.equal(page.minNoticeMinutes, 120);
});

test('#503 the slot duration must be a whole number of minutes in range; a negative one cannot hang the public page', async () => {
  const bad = [-1, 0, 4, 7.5, '30', 12 * 60 + 1, null];
  for (const [i, durationMinutes] of bad.entries()) {
    const res = await createPage(`testuser-duration-${i}`, { durationMinutes });
    assert.equal(res.status, 400, `case ${i}: ${JSON.stringify(durationMinutes)}`);
    assert.equal(await Db.getAvailabilityPageBySlug(`testuser-duration-${i}`), null);
  }
  const res = await fetch(`${base}/api/availability-slots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'testuser-duration-default', title: 'Test Consultation', calendarId: CAL_TARGET })
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).durationMinutes, 30);
  assert.equal((await createPage('testuser-duration-ok', { durationMinutes: 45 })).status, 201);
  assert.equal((await Db.getAvailabilityPageBySlug('testuser-duration-ok')).durationMinutes, 45);
});
