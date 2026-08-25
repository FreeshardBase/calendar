'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const { parseSyncCollectionResponse } = require('../caldav/parser');
const Db = require('../db');

test('Issue #68 — RFC 6578 Invalidated Sync Token Fallback Suite', async (t) => {
  await t.test('CalDAVClient.syncCollection should automatically fall back to initial sync on 409 Conflict', async () => {
    const client = new CalDAVClient({
      url: 'http://localhost:5232',
      username: 'testuser',
      password: 'testpassword'
    });

    const requestedBodies = [];

    client._request = async (method, url, { body }) => {
      requestedBodies.push(body);
      if (body.includes('<d:sync-token>invalid-token-123</d:sync-token>')) {
        return {
          ok: false,
          status: 409,
          statusText: 'Conflict',
          text: async () => '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>'
        };
      }
      return {
        ok: true,
        status: 207,
        text: async () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:sync-token>fresh-sync-token-456</d:sync-token>
</d:multistatus>`
      };
    };

    const xml = await client.syncCollection('http://localhost:5232/personal/', 'invalid-token-123');

    assert.equal(requestedBodies.length, 2);
    assert.ok(requestedBodies[0].includes('<d:sync-token>invalid-token-123</d:sync-token>'));
    assert.ok(requestedBodies[1].includes('<d:sync-token/>'));
    assert.ok(xml.includes('fresh-sync-token-456'));
  });

  await t.test('CalDAVClient.syncCollection should fall back to initial sync when multistatus contains valid-sync-token error', async () => {
    const client = new CalDAVClient({
      url: 'http://localhost:5232',
      username: 'testuser',
      password: 'testpassword'
    });

    const requestedBodies = [];

    client._request = async (method, url, { body }) => {
      requestedBodies.push(body);
      if (body.includes('<d:sync-token>stale-token</d:sync-token>')) {
        return {
          ok: true,
          status: 207,
          text: async () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:error><d:valid-sync-token/></d:error>
</d:multistatus>`
        };
      }
      return {
        ok: true,
        status: 207,
        text: async () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:sync-token>new-token-after-fallback</d:sync-token>
</d:multistatus>`
      };
    };

    const xml = await client.syncCollection('http://localhost:5232/personal/', 'stale-token');

    assert.equal(requestedBodies.length, 2);
    assert.ok(requestedBodies[0].includes('<d:sync-token>stale-token</d:sync-token>'));
    assert.ok(requestedBodies[1].includes('<d:sync-token/>'));
    assert.ok(xml.includes('new-token-after-fallback'));
  });

  await t.test('parseSyncCollectionResponse should detect valid-sync-token error in XML', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:error>
    <d:valid-sync-token/>
  </d:error>
</d:multistatus>`;

    const result = parseSyncCollectionResponse(xml, 'cal1', 'acc1', 'http://localhost/cal1');
    assert.equal(result.invalidSyncToken, true);
    assert.equal(result.syncToken, null);
  });

  await t.test('Db sync cache correctly clears and updates invalid sync token', async () => {
    const calendarId = 'cal-invalid-token-test';
    await Db.upsertCalendarSyncCache(calendarId, 'ctag1', 'bad-sync-token-999');

    const cachedBefore = await Db.getCalendarSyncCache(calendarId);
    assert.equal(cachedBefore.syncToken, 'bad-sync-token-999');

    // Simulate fallback update in Db
    await Db.upsertCalendarSyncCache(calendarId, 'ctag1', 'recovered-sync-token-1000');
    const cachedAfter = await Db.getCalendarSyncCache(calendarId);
    assert.equal(cachedAfter.syncToken, 'recovered-sync-token-1000');
  });
});
