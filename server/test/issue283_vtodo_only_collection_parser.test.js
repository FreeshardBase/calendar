'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCalendarList } = require('../caldav/parser');

test('Issue #283 — VTODO-only collection parsing & drop prevention', async (t) => {
  await t.test('parseCalendarList retains VTODO-only collection with self-closing or non-standard comp elements', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/calendars/test/vtodo-self-closing/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Self Closing Comp Task List</d:displayname>
        <cal:supported-calendar-component-set>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/vtodo-text-inside/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Text Node Comp Task List</d:displayname>
        <cal:supported-calendar-component-set>
          <cal:comp>VTODO</cal:comp>
        </cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/vtodo-custom-tag/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Custom Tag Task List</d:displayname>
        <cal:supported-calendar-component-set>
          <cal:component name="VTODO"/>
        </cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/vtodo-text-only/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Text Only Task List</d:displayname>
        <cal:supported-calendar-component-set>VTODO</cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const calendars = parseCalendarList(xml, 'acc-123', 'https://cloud.example.com', 'test');

    assert.strictEqual(calendars.length, 4, 'All 4 VTODO-only collections must be parsed and retained');
    
    assert.strictEqual(calendars[0].name, 'Self Closing Comp Task List');
    assert.strictEqual(calendars[0].supportsVTODO, true);
    assert.strictEqual(calendars[0].supportsVEVENT, false);

    assert.strictEqual(calendars[1].name, 'Text Node Comp Task List');
    assert.strictEqual(calendars[1].supportsVTODO, true);
    assert.strictEqual(calendars[1].supportsVEVENT, false);

    assert.strictEqual(calendars[2].name, 'Custom Tag Task List');
    assert.strictEqual(calendars[2].supportsVTODO, true);
    assert.strictEqual(calendars[2].supportsVEVENT, false);

    assert.strictEqual(calendars[3].name, 'Text Only Task List');
    assert.strictEqual(calendars[3].supportsVTODO, true);
    assert.strictEqual(calendars[3].supportsVEVENT, false);
  });
});
