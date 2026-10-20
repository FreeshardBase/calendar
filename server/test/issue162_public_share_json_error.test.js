'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3132';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Db = require('../db');
const { server } = require('../index');
server.listen(process.env.PORT);

// The one answer an anonymous subscriber gets when the export fails, whatever the cause.
const PUBLIC_SHARE_ERROR = 'Der freigegebene Kalender kann gerade nicht abgerufen werden. Bitte versuche es später erneut.';

describe('Issue #162 — Public Share Route JSON & Clean Error Handling', () => {
  after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;

  async function addOAuthShare() {
    // The account's owner must exist (FOREIGN KEY), whatever other test files left in the DB.
    await Db.upsertUser('testuser-162', 'testuser-162', 'testuser@example.com');
    // Unique username so the file can be re-run against an existing test DB.
    const acc = await Db.addAccount('testuser-162', {
      label: 'Broken OAuth Account',
      url: 'https://apidata.googleusercontent.com/caldav/v2/test/user',
      username: `oauthuser-${crypto.randomUUID()}`,
      password: 'dummy_refresh_token',
      authType: 'oauth2'
    });
    await new Promise((resolve, reject) => {
      Db.db.run("UPDATE linked_accounts SET auth_type = 'oauth2', expires_at = 0 WHERE id = ?", [acc.id], (err) => err ? reject(err) : resolve());
    });
    const share = await Db.addCalendarShare(`${acc.id}::/caldav/v2/test/user/events/`, 'Broken OAuth Share');
    assert.ok(share.token);
    return share;
  }

  async function assertFixedError(res, leaks) {
    assert.strictEqual(res.status, 500);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json, got ${contentType}`);
    const raw = await res.text();
    for (const fragment of leaks) {
      assert.strictEqual(raw.includes(fragment), false, `Response must not contain ${JSON.stringify(fragment)}: ${raw}`);
    }
    assert.deepStrictEqual(JSON.parse(raw), { error: PUBLIC_SHARE_ERROR });
  }

  test('GET /api/public/calendars/share/invalidtoken.ics returns a German JSON error with status 404', async () => {
    const res = await fetch(`${baseUrl}/api/public/calendars/share/invalidtoken99999.ics`);
    assert.strictEqual(res.status, 404);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json, got ${contentType}`);
    assert.deepStrictEqual(await res.json(), { error: 'Kalenderfreigabe nicht gefunden oder Token ungültig.' });
  });

  test('missing OAuth configuration is answered with the fixed German error, not the config detail', async () => {
    const share = await addOAuthShare();
    const origId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const res = await fetch(`${baseUrl}/api/public/calendars/share/${share.token}.ics`);
      await assertFixedError(res, ['GOOGLE_CLIENT_ID', 'OAuth', 'nicht eingerichtet']);
    } finally {
      if (origId !== undefined) process.env.GOOGLE_CLIENT_ID = origId;
    }
  });

  test('a failed Google token refresh does not leak the upstream body to the anonymous caller', async () => {
    const share = await addOAuthShare();
    const origFetch = global.fetch;
    const origId = process.env.GOOGLE_CLIENT_ID;
    const origSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'UPSTREAM-SECRET-BODY host=internal-caldav:5232' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(url, opts);
    };
    try {
      const res = await origFetch(`${baseUrl}/api/public/calendars/share/${share.token}.ics`);
      await assertFixedError(res, ['UPSTREAM-SECRET-BODY', 'internal-caldav', 'token refresh', 'verknüpfe']);
    } finally {
      global.fetch = origFetch;
      if (origId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = origId;
      if (origSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = origSecret;
    }
  });

  test('an internal database error is answered with the fixed German error', async () => {
    const orig = Db.getCalendarShareByToken;
    Db.getCalendarShareByToken = async () => {
      throw new Error('SQLITE_ERROR: no such table: calendar_shares');
    };
    try {
      const res = await fetch(`${baseUrl}/api/public/calendars/share/sometoken12345.ics`);
      await assertFixedError(res, ['SQLITE', 'calendar_shares']);
    } finally {
      Db.getCalendarShareByToken = orig;
    }
  });
});
