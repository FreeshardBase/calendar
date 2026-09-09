'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const { fetchCalendarICS } = require('../routes/calendars');

test('Issue #236 — Whole-Calendar Export Untruncated Fallback Suite', async (t) => {

  await t.test('CalDAVClient.getEvents without dates produces calendar-query without time-range filter', async () => {
    const client = new CalDAVClient({
      url: 'http://localhost:5232/users/testuser/calendars/personal/',
      username: 'testuser',
      password: 'password'
    });

    let capturedBody = null;
    client.report = async (url, body) => {
      capturedBody = body;
      return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>`;
    };

    await client.getEvents(client.baseUrl);

    assert.ok(capturedBody, 'report should have been called');
    assert.ok(capturedBody.includes('<c:comp-filter name="VEVENT"/>'), 'Body should filter for VEVENT');
    assert.strictEqual(capturedBody.includes('<c:time-range'), false, 'Body MUST NOT include a time-range filter when dates are omitted');
  });

  await t.test('CalDAVClient.getEvents with dates produces calendar-query with time-range filter', async () => {
    const client = new CalDAVClient({
      url: 'http://localhost:5232/users/testuser/calendars/personal/',
      username: 'testuser',
      password: 'password'
    });

    let capturedBody = null;
    client.report = async (url, body) => {
      capturedBody = body;
      return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>`;
    };

    const startDate = new Date('2025-01-01T00:00:00Z');
    const endDate = new Date('2025-12-31T23:59:59Z');
    await client.getEvents(client.baseUrl, startDate, endDate);

    assert.ok(capturedBody, 'report should have been called');
    assert.ok(capturedBody.includes('<c:time-range'), 'Body MUST include a time-range filter when dates are provided');
  });

  await t.test('fetchCalendarICS fallback queries getEvents without date limits and includes distant past/future events', async () => {
    const calendarUrl = 'http://localhost:5232/users/testuser/calendars/personal/';
    let getEventsArgs = null;

    const client = {
      baseUrl: calendarUrl,
      _request: async () => {
        // Simulate backend without ?export (throws or returns non-ok)
        const err = new Error('GET export not supported');
        err.status = 404;
        throw err;
      },
      getEvents: async (...args) => {
        getEventsArgs = args;
        // Return two events: one from 10 years ago, one 10 years in future
        return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${calendarUrl}past-event.ics</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:past-event-1234
SUMMARY:Distant Past Event (10 Years Ago)
DTSTART:20160101T100000Z
DTEND:20160101T110000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>${calendarUrl}future-event.ics</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:future-event-5678
SUMMARY:Distant Future Event (10 Years In Future)
DTSTART:20360101T100000Z
DTEND:20360101T110000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;
      }
    };

    const icsResult = await fetchCalendarICS(client, calendarUrl);

    // Verify getEvents was called with only calendarUrl and no start/end dates
    assert.strictEqual(getEventsArgs.length, 1, 'getEvents should be called with only calendarUrl');
    assert.strictEqual(getEventsArgs[0], calendarUrl);

    // Verify output ICS contains both events
    assert.ok(icsResult.includes('SUMMARY:Distant Past Event (10 Years Ago)'), 'Export should include distant past event');
    assert.ok(icsResult.includes('SUMMARY:Distant Future Event (10 Years In Future)'), 'Export should include distant future event');
    assert.ok(icsResult.includes('BEGIN:VCALENDAR'));
    assert.ok(icsResult.includes('END:VCALENDAR'));
  });

});
