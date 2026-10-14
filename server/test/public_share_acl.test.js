'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3127';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Public Share Link Handlers Session Identity & Ownership Suite (Issue #234)', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let strangerCookie = '';
  let readonlyUserCookie = '';

  const ownerUserId = 'test-owner-234';
  const strangerUserId = 'test-stranger-234';
  const readonlyUserId = 'test-readonly-234';

  await Db.upsertUser(ownerUserId, 'owner234@example.com');
  await Db.upsertUser(strangerUserId, 'stranger234@example.com');
  await Db.upsertUser(readonlyUserId, 'readonly234@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;
  const strangerCalId = `internal-caldav::/${strangerUserId}/personal/`;

  await Db.addUserShare(ownerCalId, readonlyUserId, false);

  await t.test('Authenticate sessions', async () => {
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

    readonlyUserCookie = await loginAs(readonlyUserId);
    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: readonlyUserCookie }
    });
    assert.strictEqual(res3.status, 200);
  });

  await t.test('Unauthenticated GET /api/calendars/:id/shares-public should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated POST /api/calendars/:id/shares-public should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Public Link' })
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated DELETE /api/calendars/:id/shares-public/:token should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/token123`, {
      method: 'DELETE'
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('Stranger GET /api/calendars/:id/shares-public should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger POST /api/calendars/:id/shares-public should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({ label: 'Unauthorized Public Link' })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger DELETE /api/calendars/:id/shares-public/:token should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/dummytoken`, {
      method: 'DELETE',
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Read-only shared user GET/POST/DELETE /api/calendars/:id/shares-public should return 403', async () => {
    const resGet = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { cookie: readonlyUserCookie }
    });
    assert.strictEqual(resGet.status, 403);

    const resPost = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: readonlyUserCookie },
      body: JSON.stringify({ label: 'Shared User Link' })
    });
    assert.strictEqual(resPost.status, 403);
  });

  await t.test('Owner deleting non-existent token or token belonging to foreign calendar should return 404', async () => {
    // Create share token for strangerCalId
    const strangerShare = await Db.addCalendarShare(strangerCalId, 'Stranger Share');

    // Owner tries to delete stranger's share token using owner's calendarId endpoint
    const res1 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/${strangerShare.token}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res1.status, 404);

    // Owner tries to delete non-existent token
    const res2 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public/nonexistenttoken999`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res2.status, 404);
  });
});
