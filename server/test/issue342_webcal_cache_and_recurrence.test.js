'use strict';

// Issue #342: a bad feed response must not wipe the cached webcal events — the
// last good copy is kept and the error is recorded on the subscription — and
// recurring feed events are expanded for the requested window.
// Runs under NODE_ENV=production against an isolated database.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue342-'));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, '.encryption_key');
// The local feed server stands in for a remote one (#337 outbound guard).
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const webcalRouter = require('../routes/webcal');
const { syncDueWebcalSubscriptions } = require('../utils/webcalSubscription');

const USER = 'testuser';

const GOOD_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test Feed//EN',
  'BEGIN:VEVENT',
  'UID:single-342@example.com',
  'SUMMARY:Single Event',
  'DTSTART:20261015T090000Z',
  'DTEND:20261015T100000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

const RECURRING_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test Feed//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  // Weekly lesson on Mondays 08:00 Berlin, one week cancelled, one extra Wednesday.
  'BEGIN:VEVENT',
  'UID:lesson-342@example.com',
  'SUMMARY:Math Lesson',
  'DTSTART;TZID=Europe/Berlin:20261102T080000',
  'DTEND;TZID=Europe/Berlin:20261102T090000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE;TZID=Europe/Berlin:20261116T080000',
  'RDATE;TZID=Europe/Berlin:20261118T080000',
  'END:VEVENT',
  // One occurrence moved to Tuesday.
  'BEGIN:VEVENT',
  'UID:lesson-342@example.com',
  'RECURRENCE-ID;TZID=Europe/Berlin:20261123T080000',
  'SUMMARY:Math Lesson (moved)',
  'DTSTART;TZID=Europe/Berlin:20261124T100000',
  'DTEND;TZID=Europe/Berlin:20261124T110000',
  'END:VEVENT',
  // Outside the requested window.
  'BEGIN:VEVENT',
  'UID:far-away-342@example.com',
  'SUMMARY:Far Away',
  'DTSTART:20270601T090000Z',
  'DTEND:20270601T100000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('Issue #342 — webcal cache survives bad responses; recurrences expand (NODE_ENV=production)', async (t) => {
  let server;
  let baseUrl;
  let feedServer;
  let feedUrl;
  let feedStatus = 200;
  let feedBody = GOOD_FEED;

  t.before(async () => {
    await Db.upsertUser(USER, USER, 'testuser@example.com');

    feedServer = http.createServer((req, res) => {
      res.writeHead(feedStatus, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(feedBody);
    });
    await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
    feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.ics`;

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'issue342-test-secret', resave: false, saveUninitialized: false }));
    // Harness-only identity injection: stands in for the OIDC login.
    app.use((req, res, next) => {
      const who = req.get('x-harness-user');
      if (who) req.session.userId = who;
      next();
    });
    app.use('/api/webcal', webcalRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (feedServer) await new Promise((resolve) => feedServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = (method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'x-harness-user': USER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const RANGE = 'start=2026-10-01T00:00:00.000Z&end=2026-10-31T23:59:59.999Z';

  async function createSub(name) {
    const res = await call('POST', '/api/webcal/subscriptions', { name, url: feedUrl });
    assert.equal(res.status, 201);
    return res.json();
  }

  async function getSub(id) {
    const res = await call('GET', `/api/webcal/subscriptions/${id}`);
    assert.equal(res.status, 200);
    return res.json();
  }

  async function getEvents(id, range = RANGE) {
    const res = await call('GET', `/api/webcal/subscriptions/${id}/events?${range}`);
    assert.equal(res.status, 200);
    return (await res.json()).events;
  }

  await t.test('a 200 response that is not iCalendar keeps the cache and records the error', async () => {
    feedStatus = 200;
    feedBody = GOOD_FEED;
    const sub = await createSub('Parse Error Feed');
    assert.deepEqual((await getEvents(sub.id)).map(e => e.title), ['Single Event']);
    assert.equal((await getSub(sub.id)).last_error, null);

    feedBody = '<html><body>502 Bad Gateway</body></html>';
    const syncRes = await call('POST', `/api/webcal/subscriptions/${sub.id}/sync`);
    assert.equal(syncRes.status, 502);
    const syncBody = await syncRes.json();
    assert.ok(syncBody.error, 'sync failure must be reported to the client');

    assert.deepEqual((await getEvents(sub.id)).map(e => e.title), ['Single Event'],
      'the last good copy must still be served');
    const failed = await getSub(sub.id);
    assert.ok(failed.last_error, 'the error must be recorded on the subscription');
    assert.ok(failed.last_error_at > 0);

    const list = await (await call('GET', '/api/webcal/subscriptions')).json();
    const listed = list.subscriptions.find(s => s.id === sub.id);
    assert.equal(listed.last_error, failed.last_error, 'the list carries the error for the sidebar');

    // The feed recovers: the error is cleared.
    feedBody = GOOD_FEED;
    const okRes = await call('POST', `/api/webcal/subscriptions/${sub.id}/sync`);
    assert.equal(okRes.status, 200);
    assert.equal((await getSub(sub.id)).last_error, null);
  });

  await t.test('an empty 200 body and a truncated feed keep the cache', async () => {
    feedStatus = 200;
    feedBody = GOOD_FEED;
    const sub = await createSub('Truncated Feed');

    for (const bad of ['', GOOD_FEED.slice(0, 80)]) {
      feedBody = bad;
      const syncRes = await call('POST', `/api/webcal/subscriptions/${sub.id}/sync`);
      assert.equal(syncRes.status, 502);
      assert.deepEqual((await getEvents(sub.id)).map(e => e.title), ['Single Event']);
    }
  });

  await t.test('the background worker keeps the cache on HTTP errors and records them', async () => {
    feedStatus = 200;
    feedBody = GOOD_FEED;
    const sub = await createSub('Worker Feed');

    feedStatus = 500;
    feedBody = 'Internal Server Error';
    const farFuture = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const result = await syncDueWebcalSubscriptions(farFuture);
    assert.ok(result.errors.some(e => e.id === sub.id));

    assert.deepEqual((await getEvents(sub.id)).map(e => e.title), ['Single Event']);
    const failed = await getSub(sub.id);
    assert.match(failed.last_error, /500/);
  });

  await t.test('a forced refresh that fails still serves the cache, with the error', async () => {
    feedStatus = 200;
    feedBody = GOOD_FEED;
    const sub = await createSub('Forced Feed');

    feedBody = 'not a calendar';
    const res = await call('GET', `/api/webcal/subscriptions/${sub.id}/events?force=true&${RANGE}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.events.map(e => e.title), ['Single Event']);
    assert.ok(body.error);
  });

  await t.test('recurring feed events are expanded for the requested window (RRULE, EXDATE, RDATE, overrides)', async () => {
    feedStatus = 200;
    feedBody = RECURRING_FEED;
    const sub = await createSub('Timetable');

    const events = await getEvents(sub.id, 'start=2026-11-01T00:00:00.000Z&end=2026-11-30T23:59:59.999Z');
    const got = events.map(e => [e.start, e.title]).sort();
    assert.deepEqual(got, [
      ['2026-11-02T07:00:00.000Z', 'Math Lesson'],
      ['2026-11-09T07:00:00.000Z', 'Math Lesson'],
      // 16 Nov excluded by EXDATE
      ['2026-11-18T07:00:00.000Z', 'Math Lesson'], // RDATE
      ['2026-11-24T09:00:00.000Z', 'Math Lesson (moved)'],
      ['2026-11-30T07:00:00.000Z', 'Math Lesson']
    ]);
    for (const ev of events) {
      assert.equal(ev.readOnly, true);
      assert.equal(ev.isSubscription, true);
      assert.equal(ev.subscriptionId, sub.id);
    }
    assert.equal(new Set(events.map(e => e.id)).size, events.length, 'occurrence ids must be unique');

    // A window a year later still yields the weekly occurrences (not only the first one).
    const later = await getEvents(sub.id, 'start=2027-11-01T00:00:00.000Z&end=2027-11-07T23:59:59.999Z');
    assert.deepEqual(later.map(e => e.start), ['2027-11-01T07:00:00.000Z']);

    const june = await getEvents(sub.id, 'start=2027-06-01T00:00:00.000Z&end=2027-06-01T23:59:59.999Z');
    assert.deepEqual(june.map(e => e.title).sort(), ['Far Away']);
  });

  await t.test('the events endpoint rejects a missing or invalid window', async () => {
    feedStatus = 200;
    feedBody = GOOD_FEED;
    const sub = await createSub('Window Feed');
    assert.equal((await call('GET', `/api/webcal/subscriptions/${sub.id}/events`)).status, 400);
    assert.equal((await call('GET', `/api/webcal/subscriptions/${sub.id}/events?start=nope&end=nope`)).status, 400);
  });
});
