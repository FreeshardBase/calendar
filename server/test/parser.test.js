'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseICSToEvent, parseAndExpandEvent, eventToICS, parseCalendarList, addOccurrenceException, upsertOccurrenceOverride } = require('../caldav/parser');

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

  await t.test('should parse and expand advanced recurrence rules (weekly on Mon, Wed)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:adv-recur-test',
      'DTSTART:20260706T100000Z', // Monday July 6
      'DTEND:20260706T110000Z',
      'SUMMARY:Project Sync',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Query range covers 2026-07-06 to 2026-07-12
    const result = parseAndExpandEvent(ics, '2026-07-06T00:00:00Z', '2026-07-12T23:59:59Z');

    // Expected occurrences: Monday July 6, Wednesday July 8, Monday July 13 (out of range), etc.
    // Within range [July 6, July 12]: July 6 (Mon), July 8 (Wed) -> 2 instances
    assert.strictEqual(result.length, 2);

    assert.strictEqual(result[0].uid, 'adv-recur-test::2026-07-06T10:00:00Z');
    assert.strictEqual(new Date(result[0].start).getDay(), 1); // Monday

    assert.strictEqual(result[1].uid, 'adv-recur-test::2026-07-08T10:00:00Z');
    assert.strictEqual(new Date(result[1].start).getDay(), 3); // Wednesday
  });

  await t.test('should parse and expand monthly recurrence rules (2nd Thursday of the month)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:monthly-recur-byday',
      'DTSTART:20260702T100000Z', // Thursday July 2
      'DTEND:20260702T110000Z',
      'SUMMARY:Monthly Committee Meeting',
      'RRULE:FREQ=MONTHLY;BYDAY=2TH', // Every 2nd Thursday
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Query range covers July 2026
    const result = parseAndExpandEvent(ics, '2026-07-01T00:00:00Z', '2026-07-31T23:59:59Z');

    // 2nd Thursday of July 2026 is July 9th
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].uid, 'monthly-recur-byday::2026-07-09T10:00:00Z');
    assert.strictEqual(new Date(result[0].start).toISOString(), '2026-07-09T10:00:00.000Z');
  });

  await t.test('should serialize monthly custom recurrence rule (last Sunday)', () => {
    const event = {
      uid: 'serialization-monthly-test',
      title: 'Last Sunday Service',
      start: '2026-07-26T10:00:00.000Z',
      end: '2026-07-26T11:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=MONTHLY;BYDAY=-1SU'
    };

    const ics = eventToICS(event);
    assert.match(ics, /RRULE:FREQ=MONTHLY;BYDAY=-1SU/);
  });

  await t.test('should limit recurrence expansion using COUNT parameter', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:recur-count-limit',
      'DTSTART:20260709T080000Z',
      'DTEND:20260709T083000Z',
      'SUMMARY:Limited Meeting',
      'RRULE:FREQ=DAILY;COUNT=3', // Stops after 3 instances
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Query range is very long (July 9 to July 25)
    const result = parseAndExpandEvent(ics, '2026-07-09T00:00:00Z', '2026-07-25T23:59:59Z');

    // Should only yield 3 occurrences (July 9, 10, 11) despite long query range
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].uid, 'recur-count-limit::2026-07-09T08:00:00Z');
    assert.strictEqual(result[2].uid, 'recur-count-limit::2026-07-11T08:00:00Z');
  });

  await t.test('should limit recurrence expansion using UNTIL parameter', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:recur-until-limit',
      'DTSTART:20260709T080000Z',
      'DTEND:20260709T083000Z',
      'SUMMARY:Until Meeting',
      'RRULE:FREQ=DAILY;UNTIL=20260711T235959Z', // Stops after July 11
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Query range is July 9 to July 25
    const result = parseAndExpandEvent(ics, '2026-07-09T00:00:00Z', '2026-07-25T23:59:59Z');

    // Should only yield 3 occurrences (July 9, 10, 11)
    assert.strictEqual(result.length, 3);
  });

  await t.test('should parse calendar list and identify shared owner and read-only flags', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/remote.php/dav/calendars/test/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Persönlich</d:displayname>
        <a:calendar-color>#ff0000</a:calendar-color>
        <d:owner><d:href>/remote.php/dav/principals/users/test/</d:href></d:owner>
        <d:share-access><d:not-shared/></d:share-access>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/shared-read-only/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Shared Work</d:displayname>
        <a:calendar-color>#00ff00</a:calendar-color>
        <d:owner><d:href>/remote.php/dav/principals/users/aaron/</d:href></d:owner>
        <d:share-access><d:read/></d:share-access>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/test/shared-read-write/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Shared Play</d:displayname>
        <a:calendar-color>#0000ff</a:calendar-color>
        <d:owner><d:href>/remote.php/dav/principals/users/aaron/</d:href></d:owner>
        <d:share-access><d:read-write/></d:share-access>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const calendars = parseCalendarList(xml, 'acc-123', 'https://cloud.example.com', 'test');

    assert.strictEqual(calendars.length, 3);

    // 1. Personal owned calendar
    const cal1 = calendars[0];
    assert.strictEqual(cal1.name, 'Persönlich');
    assert.strictEqual(cal1.isShared, false);
    assert.strictEqual(cal1.owner, null);
    assert.strictEqual(cal1.readOnly, false);

    // 2. Shared read-only calendar
    const cal2 = calendars[1];
    assert.strictEqual(cal2.name, 'Shared Work');
    assert.strictEqual(cal2.isShared, true);
    assert.strictEqual(cal2.owner, 'aaron');
    assert.strictEqual(cal2.readOnly, true);

    // 3. Shared read-write calendar
    const cal3 = calendars[2];
    assert.strictEqual(cal3.name, 'Shared Play');
    assert.strictEqual(cal3.isShared, true);
    assert.strictEqual(cal3.owner, 'aaron');
    assert.strictEqual(cal3.readOnly, false);
  });

  const weeklyIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:weekly-master',
    'DTSTART:20260706T080000Z',
    'DTEND:20260706T090000Z',
    'SUMMARY:Weekly Meeting',
    'RRULE:FREQ=WEEKLY',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const range = ['2026-07-05T00:00:00Z', '2026-07-28T00:00:00Z'];

  await t.test('should skip EXDATEd occurrences during expansion', () => {
    const ics = weeklyIcs.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY\r\nEXDATE:20260713T080000Z');
    const result = parseAndExpandEvent(ics, ...range);
    assert.strictEqual(result.length, 3);
    assert.ok(!result.some(i => i.start.startsWith('2026-07-13')));
  });

  await t.test('should apply detached RECURRENCE-ID overrides during expansion', () => {
    const ics = weeklyIcs.replace('END:VCALENDAR', [
      'BEGIN:VEVENT',
      'UID:weekly-master',
      'RECURRENCE-ID:20260720T080000Z',
      'DTSTART:20260720T100000Z',
      'DTEND:20260720T110000Z',
      'SUMMARY:Moved Meeting',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n'));

    const result = parseAndExpandEvent(ics, ...range);
    assert.strictEqual(result.length, 4);

    const moved = result.find(i => i.recurrenceId === '2026-07-20T08:00:00Z');
    assert.ok(moved);
    assert.strictEqual(moved.title, 'Moved Meeting');
    assert.strictEqual(new Date(moved.start).toISOString(), '2026-07-20T10:00:00.000Z');
    assert.strictEqual(moved.masterUid, 'weekly-master');

    // Other occurrences keep the master data
    assert.strictEqual(result.filter(i => i.title === 'Weekly Meeting').length, 3);
  });

  await t.test('addOccurrenceException should EXDATE the occurrence', () => {
    const ics = addOccurrenceException(weeklyIcs, '2026-07-13T08:00:00Z');
    assert.match(ics, /EXDATE:20260713T080000Z/);

    const result = parseAndExpandEvent(ics, ...range);
    assert.strictEqual(result.length, 3);
    assert.ok(!result.some(i => i.start.startsWith('2026-07-13')));
  });

  await t.test('upsertOccurrenceOverride should create and replace a detached exception', () => {
    const once = upsertOccurrenceOverride(weeklyIcs, '2026-07-20T08:00:00Z', {
      title: 'Moved', start: '2026-07-20T10:00:00.000Z', end: '2026-07-20T11:00:00.000Z', allDay: false
    });
    assert.match(once, /RECURRENCE-ID:20260720T080000Z/);

    let result = parseAndExpandEvent(once, ...range);
    assert.strictEqual(result.find(i => i.recurrenceId === '2026-07-20T08:00:00Z').title, 'Moved');

    // Upsert again — must replace, not duplicate
    const twice = upsertOccurrenceOverride(once, '2026-07-20T08:00:00Z', {
      title: 'Moved Again', start: '2026-07-20T12:00:00.000Z', end: '2026-07-20T13:00:00.000Z', allDay: false
    });
    assert.strictEqual((twice.match(/BEGIN:VEVENT/g) || []).length, 2);

    result = parseAndExpandEvent(twice, ...range);
    const inst = result.find(i => i.recurrenceId === '2026-07-20T08:00:00Z');
    assert.strictEqual(inst.title, 'Moved Again');
    assert.strictEqual(new Date(inst.start).toISOString(), '2026-07-20T12:00:00.000Z');
  });

  await t.test('addOccurrenceException should drop an existing override for that occurrence', () => {
    const withOverride = upsertOccurrenceOverride(weeklyIcs, '2026-07-20T08:00:00Z', {
      title: 'Moved', start: '2026-07-20T10:00:00.000Z', end: '2026-07-20T11:00:00.000Z', allDay: false
    });
    const ics = addOccurrenceException(withOverride, '2026-07-20T08:00:00Z');
    assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);

    const result = parseAndExpandEvent(ics, ...range);
    assert.strictEqual(result.length, 3);
    assert.ok(!result.some(i => i.recurrenceId === '2026-07-20T08:00:00Z'));
  });

});
