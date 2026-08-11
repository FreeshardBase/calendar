'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const { parseSyncCollectionResponse } = require('../caldav/parser');
const Db = require('../db');

test('RFC 6578 sync-collection & CTag Caching Suite', async (t) => {
  await t.test('parseSyncCollectionResponse should parse updated events, deleted items, and new sync-token', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/testuser/personal/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-123"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:delta-event-1
SUMMARY:Delta Updated Meeting
DTSTART:20260910T100000Z
DTEND:20260910T110000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/testuser/personal/event2.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
  <d:sync-token>http://example.com/ns/sync/42</d:sync-token>
</d:multistatus>`;

    const calendarId = 'internal-caldav::/calendars/testuser/personal/';
    const accountId = 'internal-caldav';
    const calendarUrl = 'https://localhost:5232/calendars/testuser/personal/';

    const result = parseSyncCollectionResponse(xml, calendarId, accountId, calendarUrl);

    assert.equal(result.syncToken, 'http://example.com/ns/sync/42');
    assert.equal(result.updated.length, 1);
    assert.equal(result.updated[0].uid, 'delta-event-1');
    assert.equal(result.updated[0].title, 'Delta Updated Meeting');
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0], '/calendars/testuser/personal/event2.ics');
  });

  await t.test('CalDAVClient.syncCollection should build RFC 6578 sync-collection report body', async () => {
    const client = new CalDAVClient({
      url: 'http://localhost:5232',
      username: 'testuser',
      password: 'testpassword'
    });

    let requestedMethod = '';
    let requestedBody = '';

    client._request = async (method, url, { body }) => {
      requestedMethod = method;
      requestedBody = body;
      return {
        ok: true,
        status: 207,
        text: async () => `<d:multistatus xmlns:d="DAV:"><d:sync-token>token-abc</d:sync-token></d:multistatus>`
      };
    };

    const res = await client.syncCollection('http://localhost:5232/personal/', 'token-prev', '1');

    assert.equal(requestedMethod, 'REPORT');
    assert.ok(requestedBody.includes('<d:sync-collection'));
    assert.ok(requestedBody.includes('<d:sync-token>token-prev</d:sync-token>'));
    assert.ok(requestedBody.includes('<d:sync-level>1</d:sync-level>'));
    assert.ok(requestedBody.includes('<c:calendar-data/>'));
  });

  await t.test('Db upsertCalendarSyncCache and getCalendarSyncCache should persist CTag & Sync Token', async () => {
    const calendarId = 'test-cal-id-sync';
    const ctag = 'ctag-v100';
    const syncToken = 'sync-tok-v100';

    await Db.upsertCalendarSyncCache(calendarId, ctag, syncToken);
    const cached = await Db.getCalendarSyncCache(calendarId);

    assert.ok(cached);
    assert.equal(cached.calendarId, calendarId);
    assert.equal(cached.ctag, ctag);
    assert.equal(cached.syncToken, syncToken);

    // Update with new CTag
    await Db.upsertCalendarSyncCache(calendarId, 'ctag-v101', 'sync-tok-v101');
    const updatedCache = await Db.getCalendarSyncCache(calendarId);
    assert.equal(updatedCache.ctag, 'ctag-v101');
    assert.equal(updatedCache.syncToken, 'sync-tok-v101');
  });
});
