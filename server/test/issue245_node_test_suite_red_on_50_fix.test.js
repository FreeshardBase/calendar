'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// Issue #245 / #50: no request header asserts an identity, not even under NODE_ENV=test.
// The suite's multi-identity mechanism is a real session (helpers/testSession.js).

process.env.NODE_ENV = 'test';
process.env.PORT = '3185';
process.env.DISABLE_INTERNAL_CALDAV = '1';
// #337: the in-process mock-dav stands in for a remote CalDAV server.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1,localhost';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { server } = require('../index');
server.listen(process.env.PORT);
const { loginAs } = require('./helpers/testSession');

const IDENTITY_HEADERS = {
  'x-test-user-id': 'testuser-245',
  'x-test-username': 'testuser@example.com',
  'x-test-email': 'testuser@example.com',
  'x-test-user-email': 'testuser@example.com'
};

test('Issue #245 — identity comes from the session, never from an x-test-* header', async (t) => {
  t.after(() => {
    if (server && server.close) server.close();
  });

  await Db.clearAll();
  const baseUrl = `http://localhost:${process.env.PORT}`;

  const ownerUserId = 'testuser-245-owner';
  const strangerUserId = 'testuser-245-stranger';
  await Db.upsertUser(ownerUserId, 'testuser-245-owner@example.com');
  await Db.upsertUser(strangerUserId, 'testuser-245-stranger@example.com');
  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;

  // notifications, webcal and availability resolve the user themselves; the other probes hit requireAuth first.
  await t.test('x-test-* headers alone do not authenticate', async () => {
    const probes = [
      ['GET', '/api/accounts'],
      ['GET', '/api/calendars'],
      ['GET', '/api/notifications/push-subscriptions'],
      ['GET', '/api/webcal/subscriptions'],
      ['GET', '/api/msgraph/accounts'],
      ['GET', '/api/availability-slots'],
      ['GET', '/api/resources/bookings'],
      ['POST', '/api/freebusy/query']
    ];
    for (const [method, path] of probes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ participants: [], start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }) : undefined
      });
      assert.strictEqual(res.status, 401, `${method} ${path} must reject a header-only identity, got ${res.status}`);
    }
  });

  await t.test('x-test-user-id does not override the identity of an existing session', async () => {
    const cookie = await loginAs(ownerUserId);
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie, ...IDENTITY_HEADERS, 'x-test-user-id': strangerUserId }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.userId, ownerUserId);
    assert.strictEqual(body.username, ownerUserId, 'x-test-username must not rename the session user');
    assert.notStrictEqual(body.email, IDENTITY_HEADERS['x-test-email'], 'x-test-email must not change the session email');
  });

  await t.test('x-test-user-id: unauthenticated / none does not log out an existing session', async () => {
    const cookie = await loginAs(ownerUserId);
    for (const value of ['unauthenticated', 'none']) {
      const res = await fetch(`${baseUrl}/api/accounts`, {
        headers: { cookie, 'x-test-user-id': value }
      });
      assert.strictEqual(res.status, 200, `x-test-user-id: ${value} must not drop the session`);
    }
  });

  await t.test('two sessions are two identities: owner reads own calendar, stranger is refused', async () => {
    const ownerRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: await loginAs(ownerUserId) }
    });
    assert.strictEqual(ownerRes.status, 200);

    const strangerRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: await loginAs(strangerUserId) }
    });
    assert.strictEqual(strangerRes.status, 403);
  });

  await t.test('webhook deletes the second identity\'s accounts and sessions, leaving the first intact', async () => {
    const victimId = 'testuser-245-webhook';
    const victimCookie = await loginAs(victimId);
    const ownerCookie = await loginAs(ownerUserId);

    const addRes = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { cookie: victimCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://localhost:${process.env.PORT}/mock-dav/`, username: 'testuser', password: 'testpass', displayName: 'Test User' })
    });
    assert.strictEqual(addRes.status, 201);
    const added = await addRes.json();
    assert.ok((await Db.getAccounts(victimId)).some(a => a.id === added.id));

    const hookRes = await fetch(`${baseUrl}/internal/webhooks/user-deleted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: victimId })
    });
    assert.strictEqual(hookRes.status, 200);

    assert.ok(!(await Db.getAccounts(victimId)).some(a => a.id === added.id));
    const victimAfter = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie: victimCookie } });
    assert.strictEqual(victimAfter.status, 401, 'deleted user\'s session must be gone');
    const ownerAfter = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie: ownerCookie } });
    assert.strictEqual(ownerAfter.status, 200);
  });
});
