'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCalendarList } = require('../caldav/parser');

test('Issue #122 — VTODO-only collection is parsed and not filtered out', async (t) => {
  await t.test('parseCalendarList should return collections supporting VTODO even if VEVENT is missing', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/remote.php/dav/calendars/test/vtodo-tasks/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>My Task List</d:displayname>
        <cal:supported-calendar-component-set>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/text-vtodo/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Text VTODO List</d:displayname>
        <cal:supported-calendar-component-set>VTODO</cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const calendars = parseCalendarList(xml, 'acc-123', 'https://cloud.example.com', 'test');

    assert.strictEqual(calendars.length, 2);
    assert.strictEqual(calendars[0].name, 'My Task List');
    assert.strictEqual(calendars[0].supportsVTODO, true);
    assert.strictEqual(calendars[0].supportsVEVENT, false);
    assert.strictEqual(calendars[1].name, 'Text VTODO List');
    assert.strictEqual(calendars[1].supportsVTODO, true);
    assert.strictEqual(calendars[1].supportsVEVENT, false);
  });
});
