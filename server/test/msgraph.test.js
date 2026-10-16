'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3094';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

test('MS Graph account storage and REST API Suite', async (t) => {
  const { app, server } = require('../index');
  server.listen(process.env.PORT);
  const { loginAs } = require('./helpers/testSession');

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';

  await t.test('Initial setup - authenticate session', async () => {
    sessionCookie = await loginAs('testuser-id');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.status, 200);
  });

  await t.test('Database MS Graph account persistence lifecycle', async () => {
    const userId = 'testuser-id';
    const account = await Db.addMSGraphAccount({
      userId,
      accountEmail: 'testuser@example.com',
      accessToken: 'access-123',
      refreshToken: 'refresh-123'
    });

    assert.ok(account.id);
    assert.equal(account.accountEmail, 'testuser@example.com');

    const accounts = await Db.getMSGraphAccounts(userId);
    assert.ok(accounts.length >= 1);
    const fetched = accounts.find(a => a.id === account.id);
    assert.ok(fetched);
    assert.equal(fetched.accountEmail, 'testuser@example.com');

    await Db.updateMSGraphAccount(account.id, { deltaLink: 'https://graph.microsoft.com/delta-link-1' });
    const updated = await Db.getMSGraphAccountById(account.id);
    assert.equal(updated.deltaLink, 'https://graph.microsoft.com/delta-link-1');

    await Db.upsertMSGraphEventMapping('local-1', 'graph-1', account.id, 'etag-1');
    const mapping = await Db.getMSGraphEventMapping('local-1');
    assert.ok(mapping);
    assert.equal(mapping.graphId, 'graph-1');

    await Db.deleteMSGraphAccount(account.id);
    const deleted = await Db.getMSGraphAccountById(account.id);
    assert.equal(deleted, null);
  });

  await t.test('REST API GET & DELETE /api/msgraph/accounts', async () => {
    // Accounts are created only by the OAuth callback (issue97_msgraph_sync_defects.test.js).
    const created = await Db.addMSGraphAccount({
      userId: 'testuser-id',
      accountEmail: 'testuser@example.com',
      accessToken: 'testuser-access-token',
      refreshToken: 'testuser-refresh-token'
    });
    const createdAccountId = created.id;

    const resGet = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(resGet.status, 200);
    const getData = await resGet.json();
    assert.ok(getData.accounts.some(a => a.id === createdAccountId));

    const resDel = await fetch(`${baseUrl}/api/msgraph/accounts/${createdAccountId}`, {
      method: 'DELETE',
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(resDel.status, 200);
  });
});
