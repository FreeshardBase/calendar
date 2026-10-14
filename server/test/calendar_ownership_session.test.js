'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3298';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Calendar Ownership & Session Authentication Verification Suite (Issue #51)', async (t) => {
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
  let ownerCookie = '';
  let strangerCookie = '';

  const ownerUserId = 'test-owner-51';
  const strangerUserId = 'test-stranger-51';

  await Db.upsertUser(ownerUserId, 'owner51@example.com');
  await Db.upsertUser(strangerUserId, 'stranger51@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;

  await t.test('Authenticate owner and stranger sessions', async () => {
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
  });

  await t.test('Unauthenticated GET /api/calendars should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated POST /api/calendars should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'internal-caldav', name: 'New Cal' })
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated GET /api/events should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/events?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated GET /api/events/invitations should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/events/invitations`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated GET /api/tasks should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Stranger POST /api/calendars/:id/import/detect on foreign calendar should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/import/detect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: strangerCookie
      },
      body: JSON.stringify({ ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger POST /api/calendars/:id/import on foreign calendar should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: strangerCookie
      },
      body: JSON.stringify({ ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger GET/POST/DELETE /api/calendars/:id/public-link on foreign calendar should return 403', async () => {
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/public-link`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(getRes.status, 403);

    const postRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/public-link`, {
      method: 'POST',
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(postRes.status, 403);

    const delRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/public-link`, {
      method: 'DELETE',
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(delRes.status, 403);
  });
});
