'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
require('dotenv').config();
process.env.NODE_ENV = 'test';
// #337: the in-process mock-dav stands in for a remote CalDAV server — allow it explicitly.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1,localhost';
process.env.PORT = process.env.PORT || '3125';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = process.env.CALDAVURL || `http://localhost:${process.env.PORT}/mock-dav/`;
process.env.CALDAV_USERNAME = process.env.CALDAV_USERNAME || 'test';
process.env.CALDAV_PASSWORD = process.env.CALDAV_PASSWORD || 'test';

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('HTTP Routes Integration Suite', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  // Clean up database before running tests
  await Db.clearAll();

  let sessionCookie = '';
  let testCalendarId = '';

  await t.test('GET /api/accounts should return auto-configured account for the session user', async () => {
    sessionCookie = await loginAs('test');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
    
    const accounts = await res.json();
    assert.ok(Array.isArray(accounts));
    assert.strictEqual(accounts.length, 1);
    assert.ok(accounts[0].id === 'env-default' || accounts[0].id === 'internal-caldav');
    assert.strictEqual(accounts[0].username, 'test');
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

  await t.test('POST /api/accounts with base domain should run discovery and add account', async () => {
    const urlObj = new URL(process.env.CALDAVURL);
    const baseUrlOnly = `${urlObj.protocol}//${urlObj.host}`;

    const res = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: sessionCookie
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

  await t.test('POST, PUT/update and DELETE /api/calendars/:id/shares should manage calendar share permissions', async () => {
    const headers = {
      'Content-Type': 'application/json',
      cookie: sessionCookie
    };

    // 1. Add share (read-write)
    const addRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sharee: 'testuser@example.com', readWrite: true })
    });
    assert.strictEqual(addRes.status, 200);

    // 2. Verify share is added as read-write
    const getRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      headers
    });
    assert.strictEqual(getRes.status, 200);
    const getBody = await getRes.json();
    const share = getBody.shares.find(s => s.href.includes('testuser'));
    assert.ok(share);
    assert.strictEqual(share.readWrite, true);

    // 3. Update share to read-only
    const updateRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sharee: share.href, readWrite: false })
    });
    assert.strictEqual(updateRes.status, 200);

    // 4. Verify share is updated to read-only
    const getRes2 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      headers
    });
    assert.strictEqual(getRes2.status, 200);
    const getBody2 = await getRes2.json();
    const share2 = getBody2.shares.find(s => s.href.includes('testuser'));
    assert.ok(share2);
    assert.strictEqual(share2.readWrite, false);

    // 5. Remove share
    const deleteRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ sharee: share.href })
    });
    assert.strictEqual(deleteRes.status, 200);

    // 6. Verify share is removed
    const getRes3 = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/shares`, {
      headers
    });
    assert.strictEqual(getRes3.status, 200);
    const getBody3 = await getRes3.json();
    const share3 = getBody3.shares.find(s => s.href.includes('testuser'));
    assert.ok(!share3);
  });

  await t.test('GET /api/calendars/search-users should return matched users', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/search-users?q=test`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
    const users = await res.json();
    assert.ok(Array.isArray(users));
    assert.ok(users.length > 0);
    assert.ok(users[0].displayname, 'Matched user must have a non-empty displayname');
    assert.ok(users[0].displayname.toLowerCase().includes('test'), `Expected displayname containing "test", got "${users[0].displayname}"`);
  });

  await t.test('POST /api/calendars/:id/public-link should enable public link and GET /api/public/calendars/share/:token.ics should download ICS', async () => {
    const headers = { cookie: sessionCookie };

    // 1. Enable public link
    const enableRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/public-link`, {
      method: 'POST',
      headers
    });
    assert.strictEqual(enableRes.status, 200);
    const enableData = await enableRes.json();
    assert.ok(enableData.enabled);
    assert.ok(enableData.url);

    // 2. Fetch status
    const statusRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(testCalendarId)}/public-link`, {
      headers
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
      headers
    });
    assert.strictEqual(disableRes.status, 200);
    const disableData = await disableRes.json();
    assert.strictEqual(disableData.enabled, false);

    // 5. Verify old link is now dead (returns 404)
    const deadRes = await fetch(enableData.url);
    assert.strictEqual(deadRes.status, 404);
  });

  await t.test('POST, PATCH, DELETE /api/accounts and POST /internal/webhooks/user-deleted should manage accounts and clean up via webhook', async () => {
    // Second identity, as a real session (#245).
    const headers = {
      'Content-Type': 'application/json',
      cookie: await loginAs('webhook-test-user')
    };

    // 1. Add a temporary account
    const addAccRes = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: `${baseUrl}/mock-dav/`,
        username: 'webhook-test-user',
        password: 'some-password-123',
        displayName: 'Webhook Test User'
      })
    });
    assert.strictEqual(addAccRes.status, 201);
    const addAccData = await addAccRes.json();
    assert.ok(addAccData.id);

    // 2. Verify account is present in list
    const listRes = await fetch(`${baseUrl}/api/accounts`, {
      headers
    });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    const foundAcc = listData.find(a => a.id === addAccData.id);
    assert.ok(foundAcc);
    assert.strictEqual(foundAcc.displayName, 'Webhook Test User');

    // 3. Update account display name
    const patchRes = await fetch(`${baseUrl}/api/accounts/${addAccData.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ displayName: 'Updated Webhook Name' })
    });
    assert.strictEqual(patchRes.status, 200);

    // 4. Verify display name is updated
    const listRes2 = await fetch(`${baseUrl}/api/accounts`, {
      headers
    });
    const listData2 = await listRes2.json();
    const foundAcc2 = listData2.find(a => a.id === addAccData.id);
    assert.ok(foundAcc2);
    assert.strictEqual(foundAcc2.displayName, 'Updated Webhook Name');

    // 5. Test webhook for a different user_id (should not delete our account)
    const hookRes1 = await fetch(`${baseUrl}/internal/webhooks/user-deleted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'non-existent-user' })
    });
    assert.strictEqual(hookRes1.status, 200);

    const listRes3 = await fetch(`${baseUrl}/api/accounts`, {
      headers
    });
    const listData3 = await listRes3.json();
    assert.ok(listData3.some(a => a.id === addAccData.id));

    // 6. Test webhook for our user_id ('webhook-test-user')
    const hookRes2 = await fetch(`${baseUrl}/internal/webhooks/user-deleted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'webhook-test-user' })
    });
    assert.strictEqual(hookRes2.status, 200);

    // 7. Verify account and session are deleted by webhook
    assert.ok(!(await Db.getAccounts('webhook-test-user')).some(a => a.id === addAccData.id));
    const listRes4 = await fetch(`${baseUrl}/api/accounts`, {
      headers
    });
    assert.strictEqual(listRes4.status, 401, 'deleted user\'s session must no longer authenticate');
  });

  await t.test('GET /api/auth/login should return 302/200 or 500 depending on OIDC config', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
    assert.ok(res.status === 302 || res.status === 200 || res.status === 500);
    if (res.status === 500) {
      const body = await res.text();
      assert.ok(body.includes('OIDC-Konfiguration fehlt') || body.includes('OIDC-Initialisierung fehlgeschlagen'));
    }
  });

  await t.test('GET /api/auth/google should return 302/200 or 500 depending on Google config', async () => {
    const res = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
    assert.ok(res.status === 302 || res.status === 200 || res.status === 500);
    if (res.status === 500) {
      const body = await res.text();
      assert.ok(body.includes('Google OAuth-Konfiguration fehlt'));
    }
  });
});
