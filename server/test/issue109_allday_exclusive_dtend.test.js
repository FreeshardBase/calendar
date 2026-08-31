'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventToICS, parseICSToEvent } = require('../utils/ical');

test('Issue #109 — All-day events write non-inclusive DTEND (exclusive end date)', async (t) => {
  await t.test('eventToICS ensures DTEND is non-inclusive when start equals end date', () => {
    const event = {
      uid: 'issue109-test-1',
      title: 'Ganztägiges Event (Tag 1)',
      start: '2026-08-24T00:00:00.000Z',
      end: '2026-08-24T00:00:00.000Z',
      allDay: true
    };

    const ics = eventToICS(event);
    assert.match(ics, /DTSTART;VALUE=DATE:20260824/);
    assert.match(ics, /DTEND;VALUE=DATE:20260825/);
  });

  await t.test('eventToICS preserves existing exclusive DTEND when end date is already after start date', () => {
    const event = {
      uid: 'issue109-test-2',
      title: 'Ganztägiges Event (Tag 1 bis 2)',
      start: '2026-08-24T00:00:00.000Z',
      end: '2026-08-26T00:00:00.000Z',
      allDay: true
    };

    const ics = eventToICS(event);
    assert.match(ics, /DTSTART;VALUE=DATE:20260824/);
    assert.match(ics, /DTEND;VALUE=DATE:20260826/);
  });

  await t.test('eventToICS updating existing ICS component ensures non-inclusive DTEND', () => {
    const baseIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:issue109-test-3',
      'SUMMARY:Alt',
      'DTSTART;VALUE=DATE:20260824',
      'DTEND;VALUE=DATE:20260824',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updateEvent = {
      uid: 'issue109-test-3',
      title: 'Neu',
      start: '2026-08-24T00:00:00.000Z',
      end: '2026-08-24T00:00:00.000Z',
      allDay: true,
      rawIcs: baseIcs
    };

    const outputIcs = eventToICS(updateEvent);
    assert.match(outputIcs, /DTSTART;VALUE=DATE:20260824/);
    assert.match(outputIcs, /DTEND;VALUE=DATE:20260825/);
  });
});
