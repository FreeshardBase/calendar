/**
 * Issue #91 — HIGH: a weekly series recurs on the wrong weekday if the start
 * date is changed after the dialog opens.
 *
 * Root cause:
 * 1. public/js/eventModal.js previously guarded BYDAY auto-resync with
 *    `_currentEvent === null`, skipping the resync in edit mode.
 * 2. ev-start-date change listener did not call markRecurrenceTouched(),
 *    leaving _recurrenceTouched false.
 * 3. On save, handleSubmit reused _currentEvent.recurrence verbatim.
 * 4. Nothing downstream on the write path re-derived single BYDAY against DTSTART.
 *
 * Result:
 * When editing a weekly event originally on Wednesday (BYDAY=WE) and changing
 * the start date to Monday (2026-08-10), the series saved with BYDAY=WE,
 * causing occurrences to land on Wednesdays and completely miss Monday (DTSTART).
 *
 * Fix:
 * 1. Allow BYDAY auto-resync in both create and edit modes when checkedBoxes.length <= 1.
 * 2. Mark recurrence touched on ev-start-date change so the updated BYDAY is saved.
 * 3. Preserve multi-day selections (e.g. MO,WE,FR) without collapsing them.
 * 4. Normalise / re-derive single BYDAY against DTSTART on the server write path
 *    (normalizeRecurrenceRule, eventToICS, updateWholeSeries).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToEvent,
  eventToICS,
  updateWholeSeries,
  parseAndExpandEvent,
  normalizeRecurrenceRule
} = require('../utils/ical');

// The dialog side (fixes 1-3: the single weekday follows the start date in create and edit mode,
// a multi-day choice stays, an opened rule is left as is) is covered by the Playwright tests
// "Issue #91" and "Issue #403" in e2e/calendar.spec.js.
test('Issue #91 — Weekly series BYDAY weekday tracking after start-date change', async t => {

  // ── Server-side write path normalisation ─────────────────────────────────

  await t.test('server: normalizeRecurrenceRule re-derives single weekly BYDAY against DTSTART', () => {
    assert.equal(typeof normalizeRecurrenceRule, 'function', 'normalizeRecurrenceRule must be exported');
    // 2026-08-10 is Monday
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=WE', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO'
    );
    // Already matching
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO'
    );
    // Preserves INTERVAL and other parts
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;UNTIL=20261231T235959Z', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231T235959Z'
    );
    // Preserves multi-day rules
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO,WE,FR'
    );
    // Preserves MONTHLY rules
    assert.equal(
      normalizeRecurrenceRule('FREQ=MONTHLY;BYDAY=2TH', '2026-08-10T09:00:00.000Z'),
      'FREQ=MONTHLY;BYDAY=2TH'
    );
  });

  await t.test('server: eventToICS normalises single weekly BYDAY against start date', () => {
    const ics = eventToICS({
      title: 'Mismatched Standup',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=WE'
    });
    assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO/, 'eventToICS must normalise single BYDAY to match DTSTART Monday');
    assert.doesNotMatch(ics, /BYDAY=WE/, 'eventToICS must not write mismatched BYDAY=WE');

    const expanded = parseAndExpandEvent(ics, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.equal(expanded[0].start, '2026-08-10T09:00:00.000Z');
  });

  await t.test('server: updateWholeSeries re-derives single weekly BYDAY when series is shifted', () => {
    // Existing series starts Wednesday 2026-08-05 with BYDAY=WE
    const origIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:series-shift-test',
      'SUMMARY:Weekly Meeting',
      'DTSTART:20260805T090000Z',
      'DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // User shifts series to Monday 2026-08-10 (-2 days delta from occurrence on 2026-08-12)
    const updatedIcs = updateWholeSeries(origIcs, {
      uid: 'series-shift-test',
      recurrenceId: '2026-08-12T09:00:00.000Z',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z',
      title: 'Weekly Meeting Shifted'
    });

    assert.match(updatedIcs, /RRULE:FREQ=WEEKLY;BYDAY=MO/,
      'updateWholeSeries must update single BYDAY=WE to BYDAY=MO when master is shifted to Monday');
    assert.doesNotMatch(updatedIcs, /BYDAY=WE/,
      'updateWholeSeries must eliminate stale BYDAY=WE');

    const expanded = parseAndExpandEvent(updatedIcs, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.equal(expanded[0].start, '2026-08-03T09:00:00.000Z', 'Prior occurrence shifted to Monday');
    assert.equal(expanded[1].start, '2026-08-10T09:00:00.000Z', 'Target occurrence on Monday 2026-08-10');
  });

});
