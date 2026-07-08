'use strict';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');

test('HTTP Routes Integration Suite', async (t) => {
  const baseUrl = 'http://localhost:3000';
  let sessionCookie = '';
  let testCalendarId = '';

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
    testCalendarId = data.calendars[0].id;
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

  await t.test('GET /api/calendars/:id/shares should return shares list', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.shares));
  });

  await t.test('POST /api/calendars/:id/public-link should enable public link and GET /api/public/calendars/share/:token.ics should download ICS', async () => {
    // 1. Enable public link
    const enableRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/public-link`, {
      method: 'POST',
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(enableRes.status, 200);
    const enableData = await enableRes.json();
    assert.ok(enableData.enabled);
    assert.ok(enableData.url);

    // 2. Fetch status
    const statusRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/public-link`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.ok(statusData.enabled);
    assert.ok(typeof statusData.url === 'string' && statusData.url.includes('/api/public/calendars/share/'));

    // 3. Download public ICS file
    const icsRes = await fetch(statusData.url);
    assert.strictEqual(icsRes.status, 200);
    assert.strictEqual(icsRes.headers.get('content-type'), 'text/calendar; charset=utf-8');
    const icsText = await icsRes.text();
    assert.ok(icsText.includes('BEGIN:VCALENDAR'));

    // 4. Disable public link
    const disableRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/public-link`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(disableRes.status, 200);
    const disableData = await disableRes.json();
    assert.strictEqual(disableData.enabled, false);

    // 5. Verify old link is now dead (returns 404)
    const deadRes = await fetch(enableData.url);
    assert.strictEqual(deadRes.status, 404);
  });
});

