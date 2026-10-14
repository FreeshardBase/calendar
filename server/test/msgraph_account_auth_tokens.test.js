'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3286';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

test('Issue #81 — MS Graph Account Authorization & Token Security Suite', async (t) => {
  const { app, server } = require('../index');
  const { loginAs } = require('./helpers/testSession');
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3286, resolve));
  }
  await new Promise(r => setTimeout(r, 100));

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userA = 'user-a-id';
  const userB = 'user-b-id';

  let accountA;

  t.beforeEach(async () => {
    await Db.clearAll().catch(() => {});
    accountA = await Db.addMSGraphAccount({
      userId: userA,
      accountEmail: 'usera@example.com',
      tenantId: 'common',
      clientId: 'client-user-a',
      accessToken: 'secret-access-token-user-a',
      refreshToken: 'secret-refresh-token-user-a'
    });
  });

  t.afterEach(async () => {
    if (accountA && accountA.id) {
      await Db.deleteMSGraphAccount(accountA.id).catch(() => {});
    }
  });

  await t.test('GET /api/msgraph/accounts must reject unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'Authentication required');
  });

  await t.test('GET /api/msgraph/accounts must NOT return access_token or refresh_token', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      headers: { cookie: await loginAs(userA) }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.equal(data.accounts.length, 1);
    const acc = data.accounts[0];
    assert.equal(acc.id, accountA.id);
    assert.equal(acc.accountEmail, 'usera@example.com');
    assert.equal(acc.accessToken, undefined, 'accessToken must not be returned in list route');
    assert.equal(acc.refreshToken, undefined, 'refreshToken must not be returned in list route');
    assert.equal(acc.access_token, undefined, 'access_token must not be returned in list route');
    assert.equal(acc.refresh_token, undefined, 'refresh_token must not be returned in list route');
  });

  await t.test('DELETE /api/msgraph/accounts/:id must reject unauthenticated requests (401)', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts/${accountA.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 401);

    // Verify account still exists in DB
    const existing = await Db.getMSGraphAccountById(accountA.id);
    assert.ok(existing, 'Account should NOT be deleted by unauthenticated request');
  });

  await t.test('DELETE /api/msgraph/accounts/:id must reject requests from unauthorized user (403)', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts/${accountA.id}`, {
      method: 'DELETE',
      headers: { cookie: await loginAs(userB) }
    });
    assert.equal(res.status, 403);

    // Verify account still exists in DB
    const existing = await Db.getMSGraphAccountById(accountA.id);
    assert.ok(existing, 'Account should NOT be deleted by another user');
  });

  await t.test('DELETE /api/msgraph/accounts/:id allowed for owner (200)', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts/${accountA.id}`, {
      method: 'DELETE',
      headers: { cookie: await loginAs(userA) }
    });
    assert.equal(res.status, 200);

    const existing = await Db.getMSGraphAccountById(accountA.id);
    assert.equal(existing, null, 'Account should be deleted when owner requests it');
  });
});
