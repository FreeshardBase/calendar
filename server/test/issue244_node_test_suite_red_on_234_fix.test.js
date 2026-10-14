'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3184';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Issue #244 — Node test suite enforcement of #234 ownership check', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let strangerCookie = '';
  let shareeCookie = '';

  const ownerUserId = 'user244-owner';
  const strangerUserId = 'user244-stranger';
  const shareeUserId = 'user244-sharee';

  await Db.upsertUser(ownerUserId, 'owner244@example.com');
  await Db.upsertUser(strangerUserId, 'stranger244@example.com');
  await Db.upsertUser(shareeUserId, 'sharee244@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;

  // Share owner calendar with sharee as write-sharee (non-owner)
  await Db.addUserShare(ownerCalId, shareeUserId, true);

  await t.test('Initial setup — authenticate session cookies', async () => {
    ownerCookie = await loginAs(ownerUserId);
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res1.status, 200);

    strangerCookie = await loginAs(strangerUserId);
    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res2.status, 200);

    shareeCookie = await loginAs(shareeUserId);
    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: shareeCookie }
    });
    assert.strictEqual(res3.status, 200);
  });

  await t.test('Unauthenticated GET/POST/DELETE on /api/calendars/:id/shares-public returns 401', async () => {
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: {}
    });
    assert.strictEqual(getRes.status, 401, 'Unauthenticated GET shares-public must return 401');

    const postRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Unauthorized Link' })
    });
    assert.strictEqual(postRes.status, 401, 'Unauthenticated POST shares-public must return 401');

    const delRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/dummytok`, {
      method: 'DELETE',
      headers: {}
    });
    assert.strictEqual(delRes.status, 401, 'Unauthenticated DELETE shares-public must return 401');
  });

  await t.test('Stranger GET/POST/DELETE on /api/calendars/:id/shares-public returns 403', async () => {
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(getRes.status, 403, 'Stranger GET shares-public must return 403');

    const postRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({ label: 'Stranger Link' })
    });
    assert.strictEqual(postRes.status, 403, 'Stranger POST shares-public must return 403');

    const delRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/dummytok`, {
      method: 'DELETE',
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(delRes.status, 403, 'Stranger DELETE shares-public must return 403');
  });

  await t.test('Non-owner sharee GET/POST/DELETE on /api/calendars/:id/shares-public returns 403', async () => {
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: shareeCookie }
    });
    assert.strictEqual(getRes.status, 403, 'Write-sharee GET shares-public must return 403');

    const postRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: shareeCookie },
      body: JSON.stringify({ label: 'Sharee Link' })
    });
    assert.strictEqual(postRes.status, 403, 'Write-sharee POST shares-public must return 403');
  });

  await t.test('Owner GET/POST/DELETE on /api/calendars/:id/shares-public succeeds', async () => {
    // 1. Owner creates a public share token
    const postRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ label: 'Owner Public Feed' })
    });
    assert.strictEqual(postRes.status, 201, 'Owner POST shares-public must return 201');
    const created = await postRes.json();
    assert.ok(created.token);
    assert.strictEqual(created.label, 'Owner Public Feed');

    // 2. Owner lists public share tokens
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(getRes.status, 200, 'Owner GET shares-public must return 200');
    const shares = await getRes.json();
    assert.ok(Array.isArray(shares));
    assert.ok(shares.some(s => s.token === created.token));

    // 3. Owner deletes public share token
    const delRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/${created.token}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(delRes.status, 200, 'Owner DELETE shares-public must return 200');

    // 4. Verify token is gone
    const getRes2 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: ownerCookie }
    });
    const shares2 = await getRes2.json();
    assert.ok(!shares2.some(s => s.token === created.token));
  });
});
