'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3152';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');

test('Issue #252 — Non-Decorative Session-Cookie Handshake & Auth Enforcement', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';
  const testUserId = 'testuser-252';

  await t.test('1. Setup: obtain session cookie via /api/accounts with x-test-user-id', async () => {
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    assert.strictEqual(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Server must return Set-Cookie header on session initialization');
    sessionCookie = setCookie.split(';')[0];
    assert.ok(sessionCookie.includes('connect.sid'), 'Session cookie must contain connect.sid');
  });

  await t.test('2. Unauthenticated requests (no Cookie, no x-test-user-id) must return 401', async () => {
    const resSlots = await fetch(`${baseUrl}/api/availability-slots`);
    assert.strictEqual(resSlots.status, 401, 'availability-slots without cookie/auth header must return 401');

    const resResources = await fetch(`${baseUrl}/api/resources`);
    assert.strictEqual(resResources.status, 401, 'resources without cookie/auth header must return 401');

    const resMSGraph = await fetch(`${baseUrl}/api/msgraph/accounts`);
    assert.strictEqual(resMSGraph.status, 401, 'msgraph/accounts without cookie/auth header must return 401');
  });

  await t.test('3. Session cookie authentication without x-test-user-id header must succeed (200)', async () => {
    const resSlots = await fetch(`${baseUrl}/api/availability-slots`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(resSlots.status, 200, 'availability-slots with valid session cookie must succeed');

    const resResources = await fetch(`${baseUrl}/api/resources`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(resResources.status, 200, 'resources with valid session cookie must succeed');

    const resMSGraph = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(resMSGraph.status, 200, 'msgraph/accounts with valid session cookie must succeed');
  });

  await t.test('4. Invalid or dummy session cookie without x-test-user-id must return 401', async () => {
    const invalidCookie = 'connect.sid=s%3Ainvalid_session_id_123456789.bogus_signature';

    const resSlots = await fetch(`${baseUrl}/api/availability-slots`, {
      headers: { cookie: invalidCookie }
    });
    assert.strictEqual(resSlots.status, 401, 'availability-slots with invalid session cookie must return 401');

    const resResources = await fetch(`${baseUrl}/api/resources`, {
      headers: { cookie: invalidCookie }
    });
    assert.strictEqual(resResources.status, 401, 'resources with invalid session cookie must return 401');

    const resMSGraph = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      headers: { cookie: invalidCookie }
    });
    assert.strictEqual(resMSGraph.status, 401, 'msgraph/accounts with invalid session cookie must return 401');
  });
});
