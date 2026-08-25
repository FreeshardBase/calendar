const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const { formatIfMatch } = CalDAVClient;
const { parseEventList, parseTaskList } = require('../caldav/parser');

describe('Issue #69 — ETag Quote-Stripping & Weak/Unquoted ETag Handling Suite', () => {
  describe('formatIfMatch helper', () => {
    test('preserves strong ETags with double quotes', () => {
      assert.equal(formatIfMatch('"etag-12345"'), '"etag-12345"');
    });

    test('preserves weak ETags with W/"..."', () => {
      assert.equal(formatIfMatch('W/"weak-etag-123"'), 'W/"weak-etag-123"');
      assert.equal(formatIfMatch('w/"weak-etag-456"'), 'w/"weak-etag-456"');
    });

    test('recovers weak ETags missing inner quotes (W/123 -> W/"123")', () => {
      assert.equal(formatIfMatch('W/weak-etag-123'), 'W/"weak-etag-123"');
    });

    test('preserves unquoted ETags', () => {
      assert.equal(formatIfMatch('unquoted-etag-789'), 'unquoted-etag-789');
    });

    test('handles null/undefined/empty input', () => {
      assert.equal(formatIfMatch(null), null);
      assert.equal(formatIfMatch(undefined), null);
      assert.equal(formatIfMatch(''), null);
      assert.equal(formatIfMatch('   '), null);
    });
  });

  describe('CalDAVClient put and delete If-Match headers', () => {
    test('sends correct If-Match header for weak ETag on PUT', async () => {
      let sentHeaders = {};
      const dummyClient = new CalDAVClient({
        url: 'http://localhost:9999',
        username: 'testuser',
        password: 'password'
      });
      dummyClient._request = async (method, url, options) => {
        sentHeaders = options.headers || {};
        return { ok: true, status: 200, headers: new Map([['etag', 'W/"new-weak-etag"']]), text: async () => '' };
      };

      const res = await dummyClient.put('http://localhost:9999/event.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'W/"weak-etag-123"');
      assert.equal(sentHeaders['If-Match'], 'W/"weak-etag-123"');
      assert.equal(res.etag, 'W/"new-weak-etag"');
    });

    test('sends correct If-Match header for unquoted ETag on PUT', async () => {
      let sentHeaders = {};
      const dummyClient = new CalDAVClient({
        url: 'http://localhost:9999',
        username: 'testuser',
        password: 'password'
      });
      dummyClient._request = async (method, url, options) => {
        sentHeaders = options.headers || {};
        return { ok: true, status: 200, headers: new Map([['etag', 'unquoted-etag-123']]), text: async () => '' };
      };

      const res = await dummyClient.put('http://localhost:9999/event.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'unquoted-etag-123');
      assert.equal(sentHeaders['If-Match'], 'unquoted-etag-123');
      assert.equal(res.etag, 'unquoted-etag-123');
    });

    test('sends correct If-Match header for weak ETag on DELETE', async () => {
      let sentHeaders = {};
      const dummyClient = new CalDAVClient({
        url: 'http://localhost:9999',
        username: 'testuser',
        password: 'password'
      });
      dummyClient._request = async (method, url, options) => {
        sentHeaders = options.headers || {};
        return { ok: true, status: 204, headers: new Map() };
      };

      await dummyClient.delete('http://localhost:9999/event.ics', 'W/"weak-etag-999"');
      assert.equal(sentHeaders['If-Match'], 'W/"weak-etag-999"');
    });
  });

  describe('CalDAV Parser XML ETag preservation', () => {
    test('preserves weak ETag from <getetag> without stripping quotes inside W/"..."', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/user/persoenlich/event-1.ics</href>
    <propstat>
      <prop>
        <getetag>W/"weak-123"</getetag>
        <calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR
BEGIN:VEVENT
UID:event-1
SUMMARY:Weak ETag Event
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
END:VEVENT
END:VCALENDAR</calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

      const events = parseEventList(xml, 'cal-1', 'acc-1', 'http://localhost:9999/');
      assert.equal(events.length, 1);
      assert.equal(events[0].etag, 'W/"weak-123"');
    });

    test('preserves unquoted ETag from <getetag>', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/user/persoenlich/event-2.ics</href>
    <propstat>
      <prop>
        <getetag>unquoted-456</getetag>
        <calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR
BEGIN:VEVENT
UID:event-2
SUMMARY:Unquoted ETag Event
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
END:VEVENT
END:VCALENDAR</calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

      const events = parseEventList(xml, 'cal-1', 'acc-1', 'http://localhost:9999/');
      assert.equal(events.length, 1);
      assert.equal(events[0].etag, 'unquoted-456');
    });
  });
});
