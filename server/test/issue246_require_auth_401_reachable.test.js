'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '3186';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Issue #246 — requireAuth 401 Branch Reachability under AUTH_METHOD=env and NODE_ENV=test', async (t) => {
  t.before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT, resolve));
    }
  });

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;

  await t.test('1. Unauthenticated API request without session cookie or auth header returns 401 Unauthorized under AUTH_METHOD=env', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        'Accept': 'application/json'
      }
    });

    assert.strictEqual(res.status, 401, 'Unauthenticated API request must return 401 Unauthorized');
    const body = await res.json();
    assert.strictEqual(body.error, 'Authentication required', 'Error message must be "Authentication required"');
  });

  await t.test('2. Unauthenticated request to /api/events and /api/tasks return 401 Unauthorized', async () => {
    const resEvents = await fetch(`${baseUrl}/api/events`);
    assert.strictEqual(resEvents.status, 401, 'Unauthenticated GET /api/events must return 401');

    const resTasks = await fetch(`${baseUrl}/api/tasks`);
    assert.strictEqual(resTasks.status, 401, 'Unauthenticated GET /api/tasks must return 401');
  });

  await t.test('3. GET /api/auth/session initializes single-user session under AUTH_METHOD=env, enabling subsequent cookie requests', async () => {
    // GET /api/auth/session initializes single-user session under AUTH_METHOD=env
    const resSess = await fetch(`${baseUrl}/api/auth/session`);
    assert.strictEqual(resSess.status, 200, 'Session init endpoint must return 200');

    const cookies = resSess.headers.getSetCookie ? resSess.headers.getSetCookie() : [resSess.headers.get('set-cookie')].filter(Boolean);
    const cookieHeader = cookies.length > 0 ? cookies[0] : resSess.headers.get('set-cookie');
    assert.ok(cookieHeader, `Set-Cookie header must be present on session response`);

    // Extract cookie value for subsequent API call
    const sessionCookie = cookieHeader.split(';')[0];

    const resAuthApi = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        'Cookie': sessionCookie
      }
    });

    assert.strictEqual(resAuthApi.status, 200, 'API call with initialized session cookie must succeed (200)');
  });

  await t.test('4. Request without a session cannot authenticate via an x-test-user-id header (#245/#50)', async () => {
    const resForged = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        'x-test-user-id': 'testuser-id',
        'x-test-username': 'testuser',
        'x-test-email': 'testuser@example.com'
      }
    });

    assert.strictEqual(resForged.status, 401, 'Identity header without a session must be ignored and return 401');
  });

  await t.test('5. An x-test-user-id header does not override or clear an existing session identity', async () => {
    const cookie = await loginAs('testuser-id', { username: 'testuser', email: 'testuser@example.com' });

    const resUnauthHeader = await fetch(`${baseUrl}/api/calendars`, {
      headers: { cookie, 'x-test-user-id': 'unauthenticated' }
    });
    assert.strictEqual(resUnauthHeader.status, 200, "x-test-user-id: 'unauthenticated' must not drop a real session");

    const resSess = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie, 'x-test-user-id': 'other-user-id', 'x-test-email': 'other@example.com' }
    });
    assert.strictEqual(resSess.status, 200);
    const body = await resSess.json();
    assert.strictEqual(body.userId, 'testuser-id', 'Session identity must not be replaced by the header');
    assert.strictEqual(body.email, 'testuser@example.com', 'Session email must not be replaced by the header');
  });
});
