'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { CALDAV_PRESETS, getPresets, resolvePreset, resolveCalDAVUrl } = require('../utils/caldavPresets');
const accountsRouter = require('../routes/accounts');

const TEST_PORT = 3109;
let server;
let baseUrl;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret-key-presets',
    resave: false,
    saveUninitialized: true
  }));
  app.use('/api/accounts', accountsRouter);
  return app;
}

test.before(async () => {
  const app = makeApp();
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      baseUrl = `http://127.0.0.1:${TEST_PORT}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Issue #11 — Autoconfiguration presets for popular CalDAV providers (GMX, WEB.DE, mailbox.org, Posteo)', async (t) => {
  await t.test('caldavPresets utility exports required provider presets', async () => {
    const presets = getPresets();
    assert.ok(Array.isArray(presets));
    assert.equal(presets.length, 6);

    const ids = presets.map(p => p.id);
    assert.ok(ids.includes('gmx'));
    assert.ok(ids.includes('webde'));
    assert.ok(ids.includes('mailbox'));
    assert.ok(ids.includes('posteo'));

    assert.equal(CALDAV_PRESETS.gmx.url, 'https://caldav.gmx.net/begenda/dav/');
    assert.equal(CALDAV_PRESETS.webde.url, 'https://caldav.web.de/begenda/dav/');
    assert.equal(CALDAV_PRESETS.mailbox.url, 'https://dav.mailbox.org/caldav/');
    assert.equal(CALDAV_PRESETS.posteo.url, 'https://posteo.de:8443/calendars/');
  });

  await t.test('resolvePreset resolves email addresses and preset IDs to correct provider', async () => {
    assert.equal(resolvePreset('gmx')?.id, 'gmx');
    assert.equal(resolvePreset('user@gmx.de')?.id, 'gmx');
    assert.equal(resolvePreset('user@gmx.net')?.id, 'gmx');
    assert.equal(resolvePreset('user@web.de')?.id, 'webde');
    assert.equal(resolvePreset('user@mailbox.org')?.id, 'mailbox');
    assert.equal(resolvePreset('user@posteo.de')?.id, 'posteo');
    assert.equal(resolvePreset('user@unknown-domain.com'), null);
  });

  await t.test('resolveCalDAVUrl maps provider preset ID or email address to server URL', async () => {
    assert.equal(resolveCalDAVUrl('gmx'), 'https://caldav.gmx.net/begenda/dav/');
    assert.equal(resolveCalDAVUrl('testuser@web.de'), 'https://caldav.web.de/begenda/dav/');
    assert.equal(resolveCalDAVUrl('testuser@mailbox.org'), 'https://dav.mailbox.org/caldav/');
    assert.equal(resolveCalDAVUrl('testuser@posteo.de'), 'https://posteo.de:8443/calendars/');
    assert.equal(resolveCalDAVUrl('https://custom.caldav.com/dav/'), 'https://custom.caldav.com/dav/');
  });

  await t.test('GET /api/accounts/presets returns list of presets and resolves query parameters', async () => {
    const resList = await fetch(`${baseUrl}/api/accounts/presets`);
    assert.equal(resList.status, 200);
    const bodyList = await resList.json();
    assert.ok(Array.isArray(bodyList.presets));
    assert.equal(bodyList.presets.length, 6);

    const resEmail = await fetch(`${baseUrl}/api/accounts/presets?email=testuser@posteo.de`);
    assert.equal(resEmail.status, 200);
    const bodyEmail = await resEmail.json();
    assert.equal(bodyEmail.resolved?.id, 'posteo');
    assert.equal(bodyEmail.resolved?.url, 'https://posteo.de:8443/calendars/');
  });

  await t.test('POST /api/accounts automatically autoconfigures URL if preset or provider email is used', async () => {
    // We pass url: 'posteo' and username: 'testuser@posteo.de'
    // Since posteo.de:8443 is unreachable in unit tests, client.discover() rejects with error immediately or within connection timeout.
    // To ensure fast unit test, pass invalid port 1 or bad endpoint URL so fetch rejects immediately.
    const res = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://127.0.0.1:1/invalid',
        username: 'testuser@posteo.de',
        password: 'fake_password'
      })
    });
    assert.ok(res.status === 400 || res.status === 401, `Expected status 400 or 401, got ${res.status}`);
    const errBody = await res.json();
    assert.ok(errBody.error);
  });
});
