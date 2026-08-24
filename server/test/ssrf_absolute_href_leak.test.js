'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUrl, parseCalendarList } = require('../caldav/parser');
const { buildAbsoluteUrl } = require('../routes/events');
const { resolveCalendar } = require('../routes/calendars');

test('Issue #258 — SSRF & CalDAV Master Credential Leak Fix (Absolute Href Removal)', async (t) => {
  await t.test('resolveUrl should strip untrusted host from absolute href and keep target on baseUrl host', () => {
    const baseUrl = 'http://caldav.example.com:5232/remote.php/dav/';
    const maliciousHref = 'http://attacker.com/steal-creds?token=123';
    const resolved = resolveUrl(baseUrl, maliciousHref);

    assert.equal(
      resolved,
      'http://caldav.example.com:5232/steal-creds?token=123',
      'resolveUrl must not retain attacker.com host'
    );
  });

  await t.test('buildAbsoluteUrl should strip untrusted host from absolute href', () => {
    const baseUrl = 'http://caldav.example.com:5232/remote.php/dav/';
    const maliciousHref = 'http://169.254.169.254/latest/meta-data/';
    const resolved = buildAbsoluteUrl(baseUrl, maliciousHref);

    assert.equal(
      resolved,
      'http://caldav.example.com:5232/latest/meta-data/',
      'buildAbsoluteUrl must not target AWS metadata IP'
    );
  });

  await t.test('parseCalendarList should sanitize absolute href in XML responses', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>http://attacker.com/remote.php/dav/calendars/testuser/malicious/</d:href>
    <d:propstat>
      <d:status>HTTP/1.1 200 OK</d:status>
      <d:prop>
        <d:resourcetype><c:calendar/></d:resourcetype>
        <d:displayname>Malicious Calendar</d:displayname>
        <c:supported-calendar-component-set>
          <c:comp name="VEVENT"/>
        </c:supported-calendar-component-set>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const baseUrl = 'http://caldav.example.com:5232/remote.php/dav/';
    const calendars = parseCalendarList(xml, 'acc-123', baseUrl, 'testuser');

    assert.equal(calendars.length, 1);
    assert.equal(
      calendars[0].url,
      'http://caldav.example.com:5232/remote.php/dav/calendars/testuser/malicious/',
      'Parsed calendar URL must be resolved on trusted baseUrl host'
    );
  });

  await t.test('resolveCalendar should enforce account base URL host on absolute calendarHref', async () => {
    const req = {
      session: {
        accounts: [
          {
            id: 'acc-test-ssrf',
            url: 'http://caldav.example.com:5232/remote.php/dav/',
            username: 'testuser',
            password: 'secret-password'
          }
        ]
      }
    };

    const calendarId = 'acc-test-ssrf::http://attacker.com/stolen-cal/';
    const { calendarUrl } = await resolveCalendar(req, calendarId);

    assert.equal(
      calendarUrl,
      'http://caldav.example.com:5232/stolen-cal/',
      'resolveCalendar must resolve target URL on account.url host'
    );
  });

  await t.test('Issue #324 — resolveUrl should neutralize scheme-relative //attacker.com and port hijacking', () => {
    const baseUrl = 'http://caldav.example.com:5232/remote.php/dav/';

    const resolvedSchemeRelative = resolveUrl(baseUrl, '//attacker.com/steal-creds?token=123');
    assert.equal(
      resolvedSchemeRelative,
      'http://caldav.example.com:5232/steal-creds?token=123',
      'resolveUrl must strip scheme-relative //attacker.com host'
    );

    const resolvedPortHijack = resolveUrl(baseUrl, 'https://attacker.com:8443/steal-creds');
    assert.equal(
      resolvedPortHijack,
      'http://caldav.example.com:5232/steal-creds',
      'resolveUrl must enforce base protocol, host, and port'
    );
  });

  await t.test('Issue #324 — resolveCalendar should sanitize scheme-relative hrefs', async () => {
    const req = {
      session: {
        accounts: [
          {
            id: 'acc-test-ssrf-324',
            url: 'http://caldav.example.com:5232/remote.php/dav/',
            username: 'testuser',
            password: 'secret-password'
          }
        ]
      }
    };

    const calendarId = 'acc-test-ssrf-324:://attacker.com/scheme-relative-stolen/';
    const { calendarUrl } = await resolveCalendar(req, calendarId);

    assert.equal(
      calendarUrl,
      'http://caldav.example.com:5232/scheme-relative-stolen/',
      'resolveCalendar must strip scheme-relative host'
    );
  });
});

