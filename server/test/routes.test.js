'use strict';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');

test('HTTP Routes Integration Suite', async (t) => {
  const baseUrl = 'http://localhost:3000';
  let sessionCookie = '';

  await t.test('GET /api/accounts should return auto-configured account and set session cookie', async () => {
    const res = await fetch(`${baseUrl}/api/accounts`);
    assert.strictEqual(res.status, 200);
    
    const accounts = await res.json();
    assert.ok(Array.isArray(accounts));
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].id, 'env-default');
    assert.strictEqual(accounts[0].username, 'test');

    // Extract session cookie
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    }
  });

  await t.test('GET /api/calendars should return calendars list using session cookie', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        cookie: sessionCookie
      }
    });
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(data && Array.isArray(data.calendars));
    assert.ok(data.calendars.length > 0);
    assert.ok(data.calendars[0].id.includes('env-default'));
  });

  await t.test('GET /api/events should return list of events', async () => {
    const start = '2026-07-01T00:00:00Z';
    const end = '2026-07-31T23:59:59Z';
    const res = await fetch(`${baseUrl}/api/events?start=${start}&end=${end}`, {
      headers: {
        cookie: sessionCookie
      }
    });
    assert.strictEqual(res.status, 200);

    const events = await res.json();
    assert.ok(Array.isArray(events));
  });

  await t.test('POST /api/accounts with base domain should run discovery and add account', async (st) => {
    if (!process.env.CALDAVURL || !process.env.CALDAV_USERNAME || !process.env.CALDAV_PASSWORD) {
      st.skip('Missing CALDAV credentials in env');
      return;
    }

    const urlObj = new URL(process.env.CALDAVURL);
    const baseUrlOnly = `${urlObj.protocol}//${urlObj.host}`;

    const res = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: baseUrlOnly,
        username: process.env.CALDAV_USERNAME,
        password: process.env.CALDAV_PASSWORD,
        displayName: 'Discovered Account'
      })
    });

    // Since the auto-configured account is already in session,
    // a successful discovery resolving to the same URL must yield a 409 Conflict.
    assert.strictEqual(res.status, 409);
  });
});

