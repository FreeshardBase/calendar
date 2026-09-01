'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3132';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');

describe('Issue #162 — Public Share Route JSON & Clean Error Handling', () => {
  after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;

  test('GET /api/public/calendars/share/invalidtoken.ics returns JSON error payload with status 404', async () => {
    const res = await fetch(`${baseUrl}/api/public/calendars/share/invalidtoken99999.ics`);
    assert.strictEqual(res.status, 404);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json, got ${contentType}`);

    const data = await res.json();
    assert.ok(data && typeof data === 'object', 'Response body must be JSON object');
    assert.ok(data.error, 'JSON payload must contain "error" property');
    assert.strictEqual(typeof data.error, 'string');
    assert.strictEqual(data.error.includes('Calendar share not found'), false, 'Error message must not be raw English plain text');
  });

  test('Public share 500 error handler returns JSON error without echoing internal exception messages', async () => {
    // Add an oauth2 account with no GOOGLE_CLIENT_ID to throw immediately in getClientForAccount
    const acc = await Db.addAccount('testuser', {
      label: 'Broken OAuth Account',
      url: 'https://apidata.googleusercontent.com/caldav/v2/test/user',
      username: 'oauthuser',
      password: 'dummy_refresh_token',
      authType: 'oauth2'
    });

    await new Promise((resolve, reject) => {
      Db.db.run("UPDATE linked_accounts SET auth_type = 'oauth2', expires_at = 0 WHERE id = ?", [acc.id], (err) => err ? reject(err) : resolve());
    });

    const share = await Db.addCalendarShare(`${acc.id}::/caldav/v2/test/user/events/`, 'Broken OAuth Share');
    assert.ok(share.token);

    // Save current env and temporarily clear GOOGLE_CLIENT_ID to force immediate local throw
    const origId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;

    try {
      const res = await fetch(`${baseUrl}/api/public/calendars/share/${share.token}.ics`);
      assert.strictEqual(res.status, 500);
      const contentType = res.headers.get('content-type') || '';
      assert.ok(contentType.includes('application/json'), `Expected application/json, got ${contentType}`);

      const data = await res.json();
      assert.ok(data && typeof data === 'object');
      assert.ok(data.error);
      assert.strictEqual(data.error.includes('Error generating calendar export:'), false, 'Error message must not echo internal exception strings');
      assert.strictEqual(data.error.includes('GOOGLE_CLIENT_ID'), false, 'Error message must not leak internal configuration variable names');
    } finally {
      if (origId !== undefined) process.env.GOOGLE_CLIENT_ID = origId;
    }
  });
});
