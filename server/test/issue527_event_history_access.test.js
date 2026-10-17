'use strict';

/**
 * Issue #527 — GET /api/events/:uid/history must not hand out another member's event history.
 * Event UIDs are not secret (busy-only public ICS, calendar listings), so the history is served only
 * for a calendarId the caller may read, and only the rows recorded for that calendar.
 *
 * Runs the real server app under NODE_ENV=production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { createTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue527-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

// #246/#143: in production, env mode serves only requests a paired terminal sends through the platform proxy.
const PROXY = { 'X-Freeshard-Secret': 'issue527-proxy-secret-0123456789abcdef0123', 'X-Ptl-Client-Type': 'terminal' };

test('Issue #527 — event history requires an accessible calendarId (NODE_ENV=production)', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'env';
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue527.db');
  process.env.SESSION_SECRET = 'issue527-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SYSTEM_SYNC_SECRET = 'issue527-system-sync-secret-0123456789abcdef';
  // The internal Radicale account makes requireAuth let the session through; the history route
  // itself never contacts it, so the stand-in answers 500 to anything.
  const radicale = https.createServer(createTestCertificate(), (req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => radicale.listen(0, '127.0.0.1', resolve));
  t.after(() => radicale.close());
  process.env.INTERNAL_CALDAV_URL = `https://127.0.0.1:${radicale.address().port}`;
  delete process.env.DISABLE_INTERNAL_CALDAV;
  delete process.env.CALDAVURL;
  delete process.env.CALDAV_USERNAME;
  delete process.env.CALDAV_PASSWORD;
  delete process.env.HTTP_HEADER_AUTH;
  process.env.HTTP_HEADER_AUTH_SECRET = PROXY['X-Freeshard-Secret'];

  const { app } = require('../index.js');
  const Db = require('../db');
  const { loginAs } = require('./helpers/testSession');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    process.env = origEnv;
  });

  const userA = 'testuser';
  const userB = 'testuser-b';
  await Db.upsertUser(userA, 'testuser@example.com');
  await Db.upsertUser(userB, 'testuser-b@example.com');
  const cookieA = await loginAs(userA, { email: 'testuser@example.com' });
  const cookieB = await loginAs(userB, { email: 'testuser-b@example.com' });
  const userC = 'testuser-c';
  await Db.upsertUser(userC, 'testuser-c@example.com');
  const cookieC = await loginAs(userC, { email: 'testuser-c@example.com' });

  const calA = `internal-caldav::/${userA}/personal/`;
  const calB = `internal-caldav::/${userB}/personal/`;
  const uid = 'issue527-private-event-uid';
  await Db.recordEventHistory({
    eventUid: uid,
    calendarId: calA,
    userId: userA,
    action: 'CREATE',
    changes: { title: { new: 'Private appointment' }, description: { new: 'Private details' } },
    snapshotIcs: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:issue527-private-event-uid\r\nSUMMARY:Private appointment\r\nEND:VEVENT\r\nEND:VCALENDAR'
  });

  // A row written with a calendarId without trailing slash, in A's second calendar.
  const calAWork = `internal-caldav::/${userA}/work`;
  await Db.recordEventHistory({ eventUid: uid, calendarId: calAWork, userId: userA, action: 'UPDATE', changes: null });
  // C may read A's personal calendar, not write it.
  await Db.addUserShare(calA, userC, 0, 'ACCEPTED', 'READ');

  function history(cookie, calendarId) {
    const qs = calendarId === undefined ? '' : `?calendarId=${encodeURIComponent(calendarId)}`;
    return fetch(`${origin}/api/events/${encodeURIComponent(uid)}/history${qs}`, { headers: { ...PROXY, cookie } });
  }

  await t.test("member B without calendarId gets no history of A's event", async () => {
    const res = await history(cookieB);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('Private'), 'response must not carry the event content');
  });

  await t.test("member B with A's calendarId is refused", async () => {
    const res = await history(cookieB, calA);
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(!text.includes('Private'), 'response must not carry the event content');
  });

  await t.test("member B with B's own calendarId does not see rows recorded for A's calendar", async () => {
    const res = await history(cookieB, calB);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  await t.test('the owner without calendarId is asked for it', async () => {
    const res = await history(cookieA);
    assert.equal(res.status, 400);
  });

  await t.test('the owner with the calendarId reads the history', async () => {
    const res = await history(cookieA, calA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].event_uid, uid);
    assert.equal(body[0].calendar_id, calA);
    assert.equal(body[0].action, 'CREATE');
    assert.deepEqual(body[0].changes.title, { new: 'Private appointment' });
  });

  await t.test('the owner reads the same history with the calendarId written without trailing slash', async () => {
    const res = await history(cookieA, calA.slice(0, -1));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].calendar_id, calA);
  });

  await t.test('rows recorded without trailing slash are found with it', async () => {
    const res = await history(cookieA, `${calAWork}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].calendar_id, calAWork);
    assert.equal(body[0].action, 'UPDATE');
  });

  await t.test('a read-only sharee of the calendar reads its history', async () => {
    const res = await history(cookieC, calA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].calendar_id, calA);
  });
});
