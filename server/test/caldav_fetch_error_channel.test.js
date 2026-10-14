'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3299';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = 'http://127.0.0.1:59999/unreachable-caldav/';
process.env.CALDAV_USERNAME = 'testuser';
process.env.CALDAV_PASSWORD = 'testpassword';

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Issue #65 — CalDAV Fetch Error Channel & Status Enforcement', async (t) => {
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

  let sessionCookie = '';

  await t.test('Setup session with unreachable CalDAV account', async () => {
    sessionCookie = await loginAs('testuser');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('GET /api/calendars provides X-CalDAV-Error header and error channel when CalDAV fetches fail', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        cookie: sessionCookie
      }
    });

    assert.ok(res.headers.has('x-caldav-error'), 'Should set X-CalDAV-Error header');
    const body = await res.json();
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0, 'Response body should contain account errors');
  });

  await t.test('GET /api/events returns HTTP 502 and X-CalDAV-Error header when CalDAV fetch fails completely', async () => {
    const start = '2026-07-01T00:00:00Z';
    const end = '2026-07-31T23:59:59Z';
    
    const res = await fetch(`${baseUrl}/api/events?start=${start}&end=${end}`, {
      headers: {
        cookie: sessionCookie
      }
    });

    assert.strictEqual(res.status, 502, 'Should return HTTP 502 Bad Gateway when CalDAV fetch fails completely');
    assert.ok(res.headers.has('x-caldav-error'), 'Should set X-CalDAV-Error header');
  });

  await t.test('GET /api/tasks returns HTTP 502 and X-CalDAV-Error header when CalDAV fetch fails completely', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: {
        cookie: sessionCookie
      }
    });

    assert.strictEqual(res.status, 502, 'Should return HTTP 502 Bad Gateway when task CalDAV fetch fails');
    assert.ok(res.headers.has('x-caldav-error'), 'Should set X-CalDAV-Error header');
  });
});
