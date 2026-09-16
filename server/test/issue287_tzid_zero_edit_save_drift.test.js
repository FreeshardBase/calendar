'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave } = require('../utils/ical');

test('Issue #287 — TZID Zero-Edit Save Timezone Drift Prevention', async (t) => {
  await t.test('parseICSToEvent registers TZID BEFORE reading ev.startDate to prevent wall-clock drift', () => {
    // Use America/Denver (MDT = UTC-6 in June).
    // Ensure this tzid has not been registered in ICAL.TimezoneService prior to this test step.
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue287-tzid-drift-denver',
      'SUMMARY:Denver Sync',
      'DTSTART;TZID=America/Denver:20260601T100000',
      'DTEND;TZID=America/Denver:20260601T110000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Parse ICS to Event object on FIRST parse
    const event = parseICSToEvent(originalIcs);
    assert.ok(event, 'Event should be successfully parsed');
    assert.strictEqual(event.startTimeZone, 'America/Denver');
    assert.strictEqual(event.endTimeZone, 'America/Denver');

    // 10:00:00 MDT (UTC-6) is 16:00:00 UTC
    assert.strictEqual(event.start, '2026-06-01T16:00:00.000Z', 'First parse must resolve DTSTART in America/Denver zone');
    assert.strictEqual(event.end, '2026-06-01T17:00:00.000Z', 'First parse must resolve DTEND in America/Denver zone');

    // Re-generate ICS string from parsed event
    const generatedIcs = eventToICS(event);
    assert.match(generatedIcs, /DTSTART;TZID=America\/Denver:20260601T100000/);
    assert.match(generatedIcs, /DTEND;TZID=America\/Denver:20260601T110000/);
  });

  await t.test('isNoOpEventSave returns true for zero-edit save of TZID event', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue287-tzid-noop-1',
      'SUMMARY:Berlin Team Sync',
      'DTSTART;TZID=Europe/Berlin:20260601T100000',
      'DTEND;TZID=Europe/Berlin:20260601T110000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const event = parseICSToEvent(originalIcs);
    const noOp = isNoOpEventSave(originalIcs, event);
    assert.strictEqual(noOp, true, 'Zero-edit save of TZID event must be identified as no-op');
  });
});
