'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, parseAndExpandEvent, updateWholeSeries, isNoOpEventSave, eventToICS } = require('../utils/ical');

test('Issue #297 — Timezone Drift & Re-anchor Exception Preservation', async (t) => {
  await t.test('zero-edit save of TZID recurring series occurrence preserves master DTSTART, TZID, EXDATE, and detached override', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VTIMEZONE',
      'TZID:America/Denver',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZOFFSETFROM:-0700',
      'TZOFFSETTO:-0600',
      'TZNAME:MDT',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZOFFSETFROM:-0600',
      'TZOFFSETTO:-0700',
      'TZNAME:MST',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:series-297-denver-master',
      'SUMMARY:Denver Weekly Standup',
      'DTSTART;TZID=America/Denver:20260601T100000',
      'DTEND;TZID=America/Denver:20260601T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=America/Denver:20260608T100000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-297-denver-master',
      'RECURRENCE-ID;TZID=America/Denver:20260615T100000',
      'SUMMARY:Denver Standup - Detached Special',
      'DTSTART;TZID=America/Denver:20260615T120000',
      'DTEND;TZID=America/Denver:20260615T130000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Expand third occurrence (2026-06-22) which is a normal recurrence instance (not detached)
    const occurrencePayload = {
      uid: 'series-297-denver-master::20260622T100000',
      recurrenceId: '20260622T100000',
      title: 'Denver Weekly Standup',
      start: '2026-06-22T16:00:00.000Z', // 10:00 AM MDT (UTC-6) is 16:00 UTC
      end: '2026-06-22T17:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO'
    };

    // Verify isNoOpEventSave identifies this zero-edit payload as no-op
    const noOp = isNoOpEventSave(originalIcs, occurrencePayload);
    assert.strictEqual(noOp, true, 'Zero-edit save of occurrence payload must be identified as no-op');

    // Run updateWholeSeries with the occurrence payload
    const updatedIcs = updateWholeSeries(originalIcs, occurrencePayload);

    // Verify master DTSTART and TZID did not drift
    assert.match(updatedIcs, /DTSTART;TZID=America\/Denver:20260601T100000/, 'Master DTSTART must retain America/Denver 10:00:00 wall-clock time');
    assert.match(updatedIcs, /DTEND;TZID=America\/Denver:20260601T110000/, 'Master DTEND must retain America/Denver 11:00:00 wall-clock time');
    assert.match(updatedIcs, /EXDATE(;TZID=America\/Denver)?:20260608T100000/, 'EXDATE must be preserved without drift');
    assert.match(updatedIcs, /RECURRENCE-ID(;TZID=America\/Denver)?:20260615T100000/, 'Detached override RECURRENCE-ID must be preserved');
    assert.match(updatedIcs, /SUMMARY:Denver Standup - Detached Special/, 'Detached override VEVENT summary must be preserved');
  });

  await t.test('consecutive zero-edit saves on recurring TZID series produce 0 cumulative drift over 5 iterations', () => {
    let currentIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:series-297-berlin-drift',
      'SUMMARY:Berlin Weekly Sync',
      'DTSTART;TZID=Europe/Berlin:20260504T090000',
      'DTEND;TZID=Europe/Berlin:20260504T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=Europe/Berlin:20260511T090000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-297-berlin-drift',
      'RECURRENCE-ID;TZID=Europe/Berlin:20260518T090000',
      'SUMMARY:Berlin Sync - Detached Third Instance',
      'DTSTART;TZID=Europe/Berlin:20260518T110000',
      'DTEND;TZID=Europe/Berlin:20260518T120000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const payload = {
      uid: 'series-297-berlin-drift',
      title: 'Berlin Weekly Sync',
      start: '2026-05-04T07:00:00.000Z', // 09:00 CEST (UTC+2) is 07:00 UTC
      end: '2026-05-04T08:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'Europe/Berlin'
    };

    for (let i = 1; i <= 5; i++) {
      currentIcs = updateWholeSeries(currentIcs, payload);
      assert.match(currentIcs, /DTSTART;TZID=Europe\/Berlin:20260504T090000/, `Iteration ${i}: DTSTART must remain 20260504T090000`);
      assert.match(currentIcs, /DTEND;TZID=Europe\/Berlin:20260504T100000/, `Iteration ${i}: DTEND must remain 20260504T100000`);
      assert.match(currentIcs, /EXDATE(;TZID=Europe\/Berlin)?:20260511T090000/, `Iteration ${i}: EXDATE must be preserved`);
      assert.match(currentIcs, /RECURRENCE-ID(;TZID=Europe\/Berlin)?:20260518T090000/, `Iteration ${i}: RECURRENCE-ID must be preserved`);
    }
  });
});
