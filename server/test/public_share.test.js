'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3098';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');

test('Public Share & ICS Export Engine Suite', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';
  const testCalendarId = 'internal-caldav::/testuser/personal/';

  await t.test('Initial setup - fetch account session cookie', async () => {
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': 'testuser-id' }
    });
    assert.strictEqual(res.status, 200);
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    }
  });

  await t.test('GET /api/public/calendars/share/invalidtoken.ics should return 404', async () => {
    const res = await fetch(`${baseUrl}/api/public/calendars/share/invalidtoken12345.ics`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('Database-backed public share tokens lifecycle (POST, GET, DELETE /api/calendars/:id/shares-public)', async () => {
    // 1. Create a public share token
    const createRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares-public`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({ label: 'Test Public Feed' })
    });
    assert.strictEqual(createRes.status, 201);
    const shareData = await createRes.json();
    assert.ok(shareData.token);
    assert.strictEqual(shareData.label, 'Test Public Feed');
    assert.ok(shareData.url.includes(`/api/public/calendars/share/${shareData.token}.ics`));

    // 2. Fetch public shares list
    const listRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares-public`, {
      headers: {
        cookie: sessionCookie,
        'x-test-user-id': 'testuser-id'
      }
    });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData));
    const found = listData.find(s => s.token === shareData.token);
    assert.ok(found);
    assert.strictEqual(found.label, 'Test Public Feed');

    // 3. Delete / revoke public share token
    const deleteRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares-public/${shareData.token}`, {
      method: 'DELETE',
      headers: {
        cookie: sessionCookie,
        'x-test-user-id': 'testuser-id'
      }
    });
    assert.strictEqual(deleteRes.status, 200);

    // 4. Verify token is gone from list
    const listRes2 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares-public`, {
      headers: {
        cookie: sessionCookie,
        'x-test-user-id': 'testuser-id'
      }
    });
    const listData2 = await listRes2.json();
    assert.ok(!listData2.some(s => s.token === shareData.token));
  });

  await t.test('POST /api/calendars/:id/shares-public without label should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares-public`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({ label: '  ' })
    });
    assert.strictEqual(res.status, 400);
  });
});
