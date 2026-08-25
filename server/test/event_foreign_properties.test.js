'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, updateWholeSeries } = require('../utils/ical');

test.describe('Issue #61 — VEVENT Foreign Property Loss & Attendee Parameter Preservation', () => {

  const foreignIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Foreign CalDAV Client//EN',
    'BEGIN:VEVENT',
    'UID:event-foreign-61',
    'DTSTART:20260824T100000Z',
    'DTEND:20260824T110000Z',
    'SUMMARY:Original Meeting Summary',
    'DESCRIPTION:Original Description',
    'STATUS:CONFIRMED',
    'CLASS:CONFIDENTIAL',
    'SEQUENCE:3',
    'TRANSP:OPAQUE',
    'URL:https://example.com/meeting/61',
    'GEO:37.386013;-122.083932',
    'PRIORITY:1',
    'CREATED:20260101T100000Z',
    'X-CUSTOM-HEADER:custom-value-123',
    'X-APPLE-SORT-ORDER:42',
    'CATEGORIES:WORK,IMPORTANT',
    'LOCATION:Conference Room A',
    'ORGANIZER;CN=Test Organizer:mailto:testuser@example.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=FALSE;X-CUSTOM-ATT=attval:mailto:chair@example.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:attendee@example.com',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Meeting Alarm',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  test('parseICSToEvent attaches rawIcs to event object', () => {
    const event = parseICSToEvent(foreignIcs, { calendarId: 'cal-1' });
    assert.equal(event.uid, 'event-foreign-61');
    assert.equal(event.title, 'Original Meeting Summary');
    assert.equal(event.rawIcs, foreignIcs);
  });

  test('eventToICS preserves 11+ foreign properties when updating an existing event', () => {
    const updatedEvent = {
      uid: 'event-foreign-61',
      title: 'Updated Meeting Summary',
      description: 'Updated Description',
      status: 'CONFIRMED',
      start: '2026-08-24T10:00:00.000Z',
      end: '2026-08-24T11:00:00.000Z'
    };

    const resultIcs = eventToICS(updatedEvent, foreignIcs);

    assert.ok(resultIcs.includes('SUMMARY:Updated Meeting Summary'), 'Summary should be updated');
    assert.ok(resultIcs.includes('DESCRIPTION:Updated Description'), 'Description should be updated');
    assert.ok(resultIcs.includes('CLASS:CONFIDENTIAL'), 'CLASS should be preserved');
    assert.ok(resultIcs.includes('SEQUENCE:3'), 'SEQUENCE should be preserved');
    assert.ok(resultIcs.includes('TRANSP:OPAQUE'), 'TRANSP should be preserved');
    assert.ok(resultIcs.includes('URL:https://example.com/meeting/61'), 'URL should be preserved');
    assert.ok(resultIcs.includes('GEO:37.386013;-122.083932'), 'GEO should be preserved');
    assert.ok(resultIcs.includes('PRIORITY:1'), 'PRIORITY should be preserved');
    assert.ok(resultIcs.includes('CREATED:20260101T100000Z'), 'CREATED should be preserved');
    assert.ok(resultIcs.includes('X-CUSTOM-HEADER:custom-value-123'), 'X-CUSTOM-HEADER should be preserved');
    assert.ok(resultIcs.includes('X-APPLE-SORT-ORDER:42'), 'X-APPLE-SORT-ORDER should be preserved');
    assert.ok(resultIcs.includes('CATEGORIES:WORK,IMPORTANT'), 'CATEGORIES should be preserved');
    assert.ok(resultIcs.includes('LOCATION:Conference Room A'), 'LOCATION should be preserved');
    assert.ok(resultIcs.includes('PRODID:-//Foreign CalDAV Client//EN'), 'PRODID should be preserved');
  });

  test('eventToICS preserves custom attendee parameters (ROLE, RSVP=FALSE, X-*) without rewriting RSVP=TRUE blindly', () => {
    const updatedEvent = {
      uid: 'event-foreign-61',
      title: 'Updated Summary',
      start: '2026-08-24T10:00:00.000Z',
      end: '2026-08-24T11:00:00.000Z',
      attendees: [
        { name: 'Chair Person', email: 'chair@example.com', status: 'ACCEPTED', rsvp: false },
        { name: 'Attendee', email: 'attendee@example.com', status: 'ACCEPTED', rsvp: true }
      ]
    };

    const resultIcs = eventToICS(updatedEvent, foreignIcs);
    const unfoldedIcs = resultIcs.replace(/\r?\n /g, '');

    assert.ok(unfoldedIcs.includes('ROLE=CHAIR'), 'ROLE parameter should be preserved on chair');
    assert.ok(unfoldedIcs.includes('X-CUSTOM-ATT=attval'), 'X-CUSTOM-ATT parameter should be preserved on chair');
    assert.ok(unfoldedIcs.includes('RSVP=FALSE'), 'RSVP=FALSE should not be rewritten to RSVP=TRUE for chair');
    assert.ok(unfoldedIcs.includes('RSVP=TRUE'), 'RSVP=TRUE should be maintained for attendee with rsvp=true');
  });

  test('eventToICS from scratch does not force RSVP=TRUE for rsvp=false attendee', () => {
    const newEvent = {
      uid: 'event-new-61',
      title: 'Brand New Event',
      start: '2026-08-24T10:00:00.000Z',
      end: '2026-08-24T11:00:00.000Z',
      attendees: [
        { name: 'No RSVP Person', email: 'norsvp@example.com', status: 'ACCEPTED', rsvp: false }
      ]
    };

    const resultIcs = eventToICS(newEvent);
    assert.ok(!resultIcs.includes('RSVP=TRUE'), 'Should not contain RSVP=TRUE for rsvp=false attendee');
  });

  test('updateWholeSeries preserves foreign properties via eventToICS', () => {
    const updatedEvent = {
      uid: 'event-foreign-61',
      title: 'Series Updated Title',
      start: '2026-08-24T10:00:00.000Z',
      end: '2026-08-24T11:00:00.000Z',
      status: 'CONFIRMED'
    };

    const resultIcs = updateWholeSeries(foreignIcs, updatedEvent);

    assert.ok(resultIcs.includes('SUMMARY:Series Updated Title'));
    assert.ok(resultIcs.includes('CLASS:CONFIDENTIAL'), 'CLASS should be preserved');
    assert.ok(resultIcs.includes('SEQUENCE:3'), 'SEQUENCE should be preserved');
    assert.ok(resultIcs.includes('X-CUSTOM-HEADER:custom-value-123'), 'X-CUSTOM-HEADER should be preserved');
  });

});
