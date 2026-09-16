'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3186';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');

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

  await Db.clearAll().catch(() => {});

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

  await t.test('4. Explicit x-test-user-id: unauthenticated returns 401', async () => {
    const resUnauth = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        'x-test-user-id': 'unauthenticated'
      }
    });

    assert.strictEqual(resUnauth.status, 401, 'Explicit unauthenticated header must return 401');
  });
});
