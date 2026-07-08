'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseICSToEvent, parseAndExpandEvent, eventToICS } = require('../caldav/parser');

test('iCalendar parser suite', async (t) => {

  await t.test('should parse simple non-recurring event correctly', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:test-uid-123',
      'DTSTART:20260709T080000Z',
      'DTEND:20260709T090000Z',
      'SUMMARY:Normal Meeting',
      'LOCATION:Office 1',
      'DESCRIPTION:Talk about project',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = parseAndExpandEvent(ics, '2026-07-01T00:00:00Z', '2026-07-31T23:59:59Z');
    
    assert.strictEqual(result.length, 1);
    const ev = result[0];
    assert.strictEqual(ev.uid, 'test-uid-123');
    assert.strictEqual(ev.title, 'Normal Meeting');
    assert.strictEqual(ev.location, 'Office 1');
    assert.strictEqual(ev.description, 'Talk about project');
    assert.strictEqual(new Date(ev.start).toISOString(), '2026-07-09T08:00:00.000Z');
    assert.strictEqual(new Date(ev.end).toISOString(), '2026-07-09T09:00:00.000Z');
  });

  await t.test('should expand daily recurring event within range', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:daily-rrule-abc',
      'DTSTART:20260709T080000Z',
      'DTEND:20260709T083000Z',
      'SUMMARY:Daily Coffee',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Query range covers 2026-07-08 to 2026-07-12
    const result = parseAndExpandEvent(ics, '2026-07-08T00:00:00Z', '2026-07-12T23:59:59Z');
    
    // July 9, 10, 11, 12 -> 4 instances
    assert.strictEqual(result.length, 4);
    
    assert.strictEqual(result[0].masterUid, 'daily-rrule-abc');
    assert.strictEqual(result[0].uid, 'daily-rrule-abc::2026-07-09T08:00:00Z');
    assert.strictEqual(new Date(result[0].start).toISOString(), '2026-07-09T08:00:00.000Z');
    
    assert.strictEqual(result[1].uid, 'daily-rrule-abc::2026-07-10T08:00:00Z');
    assert.strictEqual(new Date(result[1].start).toISOString(), '2026-07-10T08:00:00.000Z');
    
    assert.strictEqual(result[3].uid, 'daily-rrule-abc::2026-07-12T08:00:00Z');
    assert.strictEqual(new Date(result[3].start).toISOString(), '2026-07-12T08:00:00.000Z');
  });

  await t.test('should serialize event to valid iCalendar format', () => {
    const event = {
      uid: 'serialization-test-999',
      title: 'Coffee Break',
      start: '2026-07-09T15:00:00.000Z',
      end: '2026-07-09T15:30:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY'
    };

    const ics = eventToICS(event);
    
    assert.match(ics, /UID:serialization-test-999/);
    assert.match(ics, /SUMMARY:Coffee Break/);
    assert.match(ics, /DTSTART:20260709T150000Z/);
    assert.match(ics, /DTEND:20260709T153000Z/);
    assert.match(ics, /RRULE:FREQ=WEEKLY/);
  });

  await t.test('should serialize event with independent start and end timezones', () => {
    const event = {
      uid: 'timezone-test-123',
      title: 'Transatlantic Flight',
      start: '2026-07-09T11:00:00.000Z', // 13:00 in Berlin (CEST)
      end: '2026-07-09T17:00:00.000Z',   // 13:00 in New York (EDT)
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'America/New_York'
    };

    const ics = eventToICS(event);

    assert.match(ics, /UID:timezone-test-123/);
    assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20260709T130000/);
    assert.match(ics, /DTEND;TZID=America\/New_York:20260709T130000/);
  });

});
