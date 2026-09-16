'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseICSToEvent, eventToICS, isNoOpEventSave, parseAndExpandEvent } = require('../utils/ical');

const eventModalJsPath = path.resolve(__dirname, '../../public/js/eventModal.js');

test('Issue #291 — BYMONTHDAY Preservation Across Zero-Edit Saves West of UTC', async (t) => {
  const origTz = process.env.TZ;
  const testTimezones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/Berlin', 'UTC'];

  await t.test('eventModal.js parses dateVal in updateRecurrenceOptions using UTC date getters', () => {
    const content = fs.readFileSync(eventModalJsPath, 'utf8');
    const updateRecurrenceFnMatch = content.match(/function updateRecurrenceOptions[\s\S]*?^}/m);
    assert.ok(updateRecurrenceFnMatch, 'updateRecurrenceOptions function must exist in eventModal.js');
    const fnBody = updateRecurrenceFnMatch[0];

    assert.ok(
      /getUTCDate/.test(fnBody),
      'updateRecurrenceOptions in eventModal.js must use getUTCDate'
    );
    assert.ok(
      /getUTCDay/.test(fnBody),
      'updateRecurrenceOptions in eventModal.js must use getUTCDay'
    );
  });

  await t.test('updateRecurrenceOptions date parsing logic returns correct day and weekday in timezones west of UTC', () => {
    try {
      for (const tz of testTimezones) {
        process.env.TZ = tz;

        const dateVal = '2026-06-15'; // Monday, June 15th, 2026
        const parts = dateVal.split('-').map(Number);
        const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));

        const day = date.getUTCDate();
        const dayName = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][date.getUTCDay()];
        const weekNum = Math.ceil(day / 7);
        const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getUTCDay()];

        assert.equal(day, 15, `In ${tz}: day must be 15`);
        assert.equal(dayName, 'Montag', `In ${tz}: dayName must be Montag`);
        assert.equal(weekNum, 3, `In ${tz}: weekNum must be 3`);
        assert.equal(wd, 'MO', `In ${tz}: weekday code must be MO`);
      }
    } finally {
      process.env.TZ = origTz;
    }
  });

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
