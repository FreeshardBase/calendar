'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #105 — saving an event against an unreachable CalDAV backend. The
// report's repro is a *paused* Radicale container: the socket accepts the
// connection and never answers, so only the request timeout ends the wait.
// None of these tests pass a timeout in: they exercise the default that
// actually governs a save, and the German message the client then receives.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue105-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
delete process.env.CALDAV_TIMEOUT_MS;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue105.db');
process.env.ENCRYPTION_KEY = 'issue105-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const CalDAVClient = require('../caldav/client');
const eventsRouter = require('../routes/events');
const { sanitizeErrorMessage } = require('../utils/errorSanitizer');
require('../db');

const MSG_CONNECTION = 'Verbindung zum Kalenderserver fehlgeschlagen. Bitte prüfe deine Netzwerkverbindung.';
// A save must give up well before the 11.7 s of the report (and the 15 s default for collection requests).
const SAVE_BUDGET_MS = 6000;
const CAL_ID = 'acc::/testuser/cal/';

// Accepts TCP connections and never writes a byte back, like a paused container.
async function withHangingBackend(fn) {
  const sockets = new Set();
  const server = net.createServer(sock => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function withApp(davUrl, fn) {
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
  const origError = console.error;
  console.error = () => {};
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    console.error = origError;
    await new Promise(resolve => server.close(resolve));
  }
}

const EVENT = {
  calendarId: CAL_ID,
  summary: 'Test',
  start: '2026-10-20T10:00:00.000Z',
  end: '2026-10-20T11:00:00.000Z',
  allDay: false
};

test('Issue #105 — save against an unreachable CalDAV backend', async (t) => {
  await t.test('connection refused (container stopped) fails fast with a German message', async () => {
    const client = new CalDAVClient({ url: 'http://127.0.0.1:59998/', username: 'testuser', password: 'testpassword' });
    const started = Date.now();
    const err = await client.put('http://127.0.0.1:59998/testuser/cal/x.ics', 'BEGIN:VCALENDAR', null).then(
      () => assert.fail('PUT against a closed port must reject'),
      e => e
    );
    assert.ok(Date.now() - started < 2000, `refused connection took ${Date.now() - started}ms`);
    assert.equal(sanitizeErrorMessage(err), MSG_CONNECTION);
  });

  await t.test('client.put() with the default timeout gives up on a backend that never answers', async () => {
    await withHangingBackend(async (davUrl) => {
      const client = new CalDAVClient({ url: davUrl, username: 'testuser', password: 'testpassword' });
      const started = Date.now();
      const err = await client.put(`${davUrl}testuser/cal/x.ics`, 'BEGIN:VCALENDAR', null).then(
        () => assert.fail('PUT against a hanging backend must reject'),
        e => e
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < SAVE_BUDGET_MS, `PUT hung for ${elapsed}ms; must give up within ${SAVE_BUDGET_MS}ms`);
      assert.equal(err.name, 'TimeoutError');
      assert.equal(sanitizeErrorMessage(err), MSG_CONNECTION);
    });
  });

  await t.test('POST /api/events answers 504 with the German connection message within the budget', async () => {
    await withHangingBackend(async (davUrl) => {
      await withApp(davUrl, async (base) => {
        const started = Date.now();
        const res = await fetch(`${base}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(EVENT)
        });
        const elapsed = Date.now() - started;
        const body = await res.json();
        assert.ok(elapsed < SAVE_BUDGET_MS, `create hung for ${elapsed}ms; must answer within ${SAVE_BUDGET_MS}ms`);
        assert.equal(res.status, 504);
        assert.equal(body.error, MSG_CONNECTION);
      });
    });
  });

  await t.test('PUT /api/events/:uid (edit) answers 504 with the German connection message within the budget', async () => {
    await withHangingBackend(async (davUrl) => {
      await withApp(davUrl, async (base) => {
        const started = Date.now();
        const res = await fetch(`${base}/api/events/test-uid-105`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...EVENT, href: '/testuser/cal/test-uid-105.ics', etag: '"1"', scope: 'series' })
        });
        const elapsed = Date.now() - started;
        const body = await res.json();
        assert.ok(elapsed < SAVE_BUDGET_MS, `edit hung for ${elapsed}ms; must answer within ${SAVE_BUDGET_MS}ms`);
        assert.equal(res.status, 504);
        assert.equal(body.error, MSG_CONNECTION);
      });
    });
  });
});
