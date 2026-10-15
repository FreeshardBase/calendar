'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3262';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

/**
 * Issue #262 — Docker Volume Lifecycles & Recreated Calendar Share Isolation
 *
 * Certifies that:
 *   1. docker-compose.yml does NOT define a separate `radicale-collections` volume, ensuring
 *      Radicale collection files reside inside `shared-data` alongside `webcalendar.db`.
 *   2. Creating a calendar via POST /api/calendars purges any stale/residual `user_calendar_shares`
 *      and `calendar_shares` rows matching the created calendarId.
 *   3. A recreated calendar with the same slug does not hand previous sharees read-write access.
 *   4. radicale_custom_rights.py verifies that the collection directory exists on disk before granting share permissions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const ROOT_DIR = path.join(__dirname, '../..');
const baseUrl = `http://localhost:${process.env.PORT}`;

test.describe('Issue #262 — Docker Volume Lifecycles & Recreated Calendar Share Isolation', () => {

  test.before(async () => {
    if (server && !server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT || 3262, resolve));
    }
  });

  test.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  test('docker-compose.yml unifies storage inside shared-data volume without separate radicale-collections volume', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    assert.ok(
      !content.includes('radicale-collections:'),
      'docker-compose.yml must not declare a separate radicale-collections volume'
    );
    assert.ok(
      !content.includes('- radicale-collections:/data/collections'),
      'caldav-server must not mount separate radicale-collections volume'
    );
    assert.ok(
      content.includes('shared-data:/data'),
      'caldav-server must mount shared-data volume to /data'
    );
  });

  test('POST /api/calendars purges stale share grants for recreated calendar ID', async () => {
    const ownerUserId = 'testowner262';
    const staleSharee = 'stranger_user_262';

    await Db.upsertUser(ownerUserId, 'owner262@example.com');
    await Db.upsertUser(staleSharee, 'stranger262@example.com');

    // Authenticate session for owner and fetch accounts
    const sessionCookie = await loginAs(ownerUserId);
    const accRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(accRes.status, 200);
    const accData = await accRes.json();
    const account = accData[0];

    const calendarUrlPath = new URL(account.url.replace(/\/+$/, '') + '/recreated-cal/').pathname;
    const staleCalId = `${account.id}::${calendarUrlPath}`;

    // Insert a stale share grant into DB simulating a remnant from a deleted/wiped calendar
    await Db.withTransaction(async (tx) => {
      await tx.run(
        `INSERT OR REPLACE INTO user_calendar_shares
          (id, calendar_id, sharee_user_id, read_write, status, created_at, role, can_view_private, can_manage_shares)
         VALUES (?, ?, ?, 1, 'ACCEPTED', strftime('%s', 'now'), 'WRITE', 0, 0)`,
        ['stale-share-262', staleCalId, staleSharee]
      );
    });

    // Verify stale share exists prior to POST /api/calendars
    const preShares = await Db.getUserShares(staleCalId);
    assert.ok(preShares.some(s => s.shareeUserId === staleSharee), 'Stale share should exist prior to calendar creation test');

    // Perform calendar creation for name "Recreated Cal" -> slug "recreated-cal"
    await fetch(`${baseUrl}/api/calendars`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cookie': sessionCookie
      },
      body: JSON.stringify({
        accountId: account.id,
        name: 'Recreated Cal',
        color: '#10b981'
      })
    });

    // Check that stale shares for created calendar ID were purged
    const postShares = await Db.getUserShares(staleCalId);
    assert.strictEqual(
      postShares.length,
      0,
      'POST /api/calendars must purge stale share grants for the recreated calendar ID'
    );
  });

  test('radicale_custom_rights.py verifies collection directory existence before granting share rights', () => {
    const rightsPath = path.join(ROOT_DIR, 'radicale/radicale_custom_rights.py');
    assert.ok(fs.existsSync(rightsPath), 'radicale_custom_rights.py must exist');
    const content = fs.readFileSync(rightsPath, 'utf8');

    assert.ok(
      content.includes('os.path.exists') || content.includes('os.path.isdir'),
      'radicale_custom_rights.py must check filesystem path existence'
    );
    assert.ok(
      content.includes('col_dir') || content.includes('collections') || content.includes('collection_path'),
      'radicale_custom_rights.py must check existence of calendar collection directory'
    );
  });

});
