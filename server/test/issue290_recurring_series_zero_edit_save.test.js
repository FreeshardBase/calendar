'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndExpandEvent, parseICSToEvent, isNoOpEventSave, updateWholeSeries } = require('../utils/ical');

test('Issue #290 — Recurring Series Zero-Edit Save & Occurrence Preservation', async (t) => {
  await t.test('isNoOpEventSave returns true for zero-edit save of any occurrence in a TZID recurring series', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue290-ny-series',
      'SUMMARY:Monday Evening Sync',
      'DTSTART;TZID=America/New_York:20260601T200000',
      'DTEND;TZID=America/New_York:20260601T210000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Expand series occurrences across June 2026
    const occurrences = parseAndExpandEvent(originalIcs, '2026-06-01T00:00:00Z', '2026-06-30T23:59:59Z');
    assert.strictEqual(occurrences.length, 5, 'Should expand to 5 weekly occurrences in June 2026');

    // Every occurrence payload when saved without edits must be recognized as a no-op save
    for (let i = 0; i < occurrences.length; i++) {
      const occ = occurrences[i];
      const noOp = isNoOpEventSave(originalIcs, occ);
      assert.strictEqual(noOp, true, `Occurrence ${i} (${occ.recurrenceId}) zero-edit save must return true for isNoOpEventSave`);
    }
  });

  await t.test('updateWholeSeries preserves master DTSTART and all occurrences when saving from an occurrence payload', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue290-byday-series',
      'SUMMARY:Weekly Sync',
      'DTSTART;TZID=America/New_York:20260601T200000',
      'DTEND;TZID=America/New_York:20260601T210000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const occurrences = parseAndExpandEvent(originalIcs, '2026-06-01T00:00:00Z', '2026-06-30T23:59:59Z');
    assert.strictEqual(occurrences.length, 5);

    // Edit summary on occurrence #2 (June 15th occurrence)
    const occ2 = occurrences[2];
    const editedPayload = { ...occ2, title: 'Weekly Sync (Updated Title)' };

    const updatedIcs = updateWholeSeries(originalIcs, editedPayload);

    // Re-expand occurrences from updated ICS
    const reExpanded = parseAndExpandEvent(updatedIcs, '2026-06-01T00:00:00Z', '2026-06-30T23:59:59Z');
    assert.strictEqual(reExpanded.length, 5, 'Must maintain all 5 occurrences in June 2026 without deleting June 1st occurrence');
    assert.strictEqual(reExpanded[0].start, occurrences[0].start, 'First occurrence start time must be preserved');
    assert.strictEqual(reExpanded[0].title, 'Weekly Sync (Updated Title)', 'Title change must apply across whole series');
  });
});
