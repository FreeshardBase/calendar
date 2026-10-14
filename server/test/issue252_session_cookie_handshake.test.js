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
const { loginAs } = require('./helpers/testSession');

test('Issue #252 — Non-Decorative Session-Cookie Handshake & Auth Enforcement', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';
  const testUserId = 'testuser-252';

  await t.test('1. Setup: a real signed session cookie authenticates /api/accounts', async () => {
    sessionCookie = await loginAs(testUserId);
    assert.ok(sessionCookie.startsWith('connect.sid='), 'Session cookie must be a connect.sid cookie');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('2. Unauthenticated requests (no Cookie) must return 401', async () => {
    const resSlots = await fetch(`${baseUrl}/api/availability-slots`);
    assert.strictEqual(resSlots.status, 401, 'availability-slots without cookie must return 401');

    const resResources = await fetch(`${baseUrl}/api/resources`);
    assert.strictEqual(resResources.status, 401, 'resources without cookie must return 401');

    const resMSGraph = await fetch(`${baseUrl}/api/msgraph/accounts`);
    assert.strictEqual(resMSGraph.status, 401, 'msgraph/accounts without cookie must return 401');
  });

  await t.test('2b. #50/#245: an x-test-user-id header without a session is ignored (401)', async () => {
    const forged = { 'x-test-user-id': testUserId, 'x-test-username': testUserId, 'x-test-email': 'testuser@example.com' };
    for (const path of ['/api/accounts', '/api/availability-slots', '/api/resources', '/api/msgraph/accounts']) {
      const res = await fetch(`${baseUrl}${path}`, { headers: forged });
      assert.strictEqual(res.status, 401, `${path} must ignore the x-test-user-id header and return 401`);
    }
  });

  await t.test('3. Session cookie authentication must succeed (200)', async () => {
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

  await t.test('4. Invalid or dummy session cookie must return 401', async () => {
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
