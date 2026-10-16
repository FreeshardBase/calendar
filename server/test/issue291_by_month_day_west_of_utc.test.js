'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave, parseAndExpandEvent } = require('../utils/ical');

// The dialog's side (the start date reads as the same day and weekday west of UTC) is the
// Playwright test "Issue #291" in e2e/calendar.spec.js, run in America/Los_Angeles.
test('Issue #291 — BYMONTHDAY Preservation Across Zero-Edit Saves West of UTC', async (t) => {
  const origTz = process.env.TZ;
  const testTimezones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/Berlin', 'UTC'];

  await t.test('BYMONTHDAY is preserved across consecutive zero-edit saves and series retains occurrences', () => {
    try {
      for (const tz of testTimezones) {
        process.env.TZ = tz;

        let ics = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Example//EN',
          'BEGIN:VEVENT',
          'UID:issue291-bymonthday-test',
          'SUMMARY:Monthly Team Retrospective',
          'DTSTART;TZID=America/New_York:20260615T200000',
          'DTEND;TZID=America/New_York:20260615T210000',
          'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
          'END:VEVENT',
          'END:VCALENDAR'
        ].join('\r\n');

        const initialOccurrences = parseAndExpandEvent(ics, '2026-06-01T00:00:00Z', '2026-09-30T23:59:59Z');
        assert.ok(initialOccurrences.length >= 3, `Initial expansion in ${tz} must have at least 3 occurrences`);

        for (let save = 1; save <= 5; save++) {
          const event = parseICSToEvent(ics);
          assert.equal(event.recurrence, 'FREQ=MONTHLY;BYMONTHDAY=15', `Save ${save} in ${tz}: recurrence must remain BYMONTHDAY=15`);

          const isNoOp = isNoOpEventSave(ics, event);
          assert.equal(isNoOp, true, `Save ${save} in ${tz}: zero-edit save must return true for isNoOpEventSave`);

          ics = eventToICS(event, ics);
          assert.match(ics, /BYMONTHDAY=15/, `Save ${save} in ${tz}: output ICS must preserve BYMONTHDAY=15`);

          const reExpanded = parseAndExpandEvent(ics, '2026-06-01T00:00:00Z', '2026-09-30T23:59:59Z');
          assert.equal(reExpanded.length, initialOccurrences.length, `Save ${save} in ${tz}: series must maintain all occurrences`);
        }
      }
    } finally {
      process.env.TZ = origTz;
    }
  });
});
