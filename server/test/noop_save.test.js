'use strict';

/**
 * Issue #79 — No-Op Save Series Protection
 *
 * Requirements:
 *  1. isNoOpEventSave(existingIcs, incomingEventData) must be exported from
 *     server/utils/ical.js.
 *  2. A save where title, start, end, description, location, recurrence,
 *     attendees, and alarms are all unchanged must be detected as a no-op.
 *  3. A save where any significant field changes must NOT be a no-op.
 *  4. No-op detection must preserve RRULE / EXDATE / recurrence data — the
 *     primary protection goal (prevents series destruction).
 *  5. All-day events round-trip correctly through no-op detection.
 *  6. Null / empty ICS returns false (safe default — cannot confirm no-op).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isNoOpEventSave, eventToICS, parseICSToEvent } = require('../utils/ical');

// ── helpers ───────────────────────────────────────────────────────────────────

function buildRecurringICS(overrides = {}) {
  const event = {
    uid: 'noop-test-master-uid',
    title: 'Weekly Standup',
    start: '2026-09-07T09:00:00.000Z',
    end:   '2026-09-07T09:30:00.000Z',
    allDay: false,
    description: 'Standup meeting',
    location: 'Zoom',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    attendees: [{ name: 'Test User', email: 'testuser@example.com', status: 'ACCEPTED' }],
    alarms: [{ action: 'DISPLAY', trigger: '-PT10M', description: 'Reminder' }],
    ...overrides
  };
  return eventToICS(event);
}

// ── test suite ────────────────────────────────────────────────────────────────

test('Issue #79 — No-Op Save Series Protection', async (t) => {

  await t.test('isNoOpEventSave is exported from server/utils/ical.js', () => {
    assert.equal(typeof isNoOpEventSave, 'function',
      'isNoOpEventSave must be exported from server/utils/ical.js');
  });

  await t.test('identical event data round-trips as a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.ok(parsed, 'must parse ICS back to event object');
    assert.equal(isNoOpEventSave(ics, parsed), true,
      'unchanged event must be detected as no-op');
  });

  await t.test('title change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, title: 'Renamed Standup' }), false,
      'title change must not be a no-op');
  });

  await t.test('start time change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, start: '2026-09-07T10:00:00.000Z' }), false,
      'start time change must not be a no-op');
  });

  await t.test('end time change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, end: '2026-09-07T10:00:00.000Z' }), false,
      'end time change must not be a no-op');
  });

  await t.test('description change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, description: 'Updated description' }), false,
      'description change must not be a no-op');
  });

  await t.test('location change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, location: 'Teams' }), false,
      'location change must not be a no-op');
  });

  await t.test('RRULE change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, { ...parsed, recurrence: 'FREQ=WEEKLY;BYDAY=TU' }), false,
      'RRULE change must not be a no-op');
  });

  await t.test('round-tripped event with same recurrence is a no-op (RRULE preservation guard)', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    assert.equal(isNoOpEventSave(ics, parsed), true,
      'round-tripped event with same recurrence must be detected as no-op');
  });

  await t.test('attendee PARTSTAT change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    const modified = {
      ...parsed,
      attendees: [{ name: 'Test User', email: 'testuser@example.com', status: 'DECLINED' }]
    };
    assert.equal(isNoOpEventSave(ics, modified), false,
      'attendee status change must not be a no-op');
  });

  await t.test('all-day event round-trip is a no-op', () => {
    const allDayEvent = {
      uid: 'noop-allday-test',
      title: 'Public Holiday',
      start: '2026-12-25T00:00:00.000Z',
      end:   '2026-12-26T00:00:00.000Z',
      allDay: true
    };
    const ics = eventToICS(allDayEvent);
    const parsed = parseICSToEvent(ics);
    assert.ok(parsed, 'must parse all-day ICS');
    assert.equal(isNoOpEventSave(ics, parsed), true,
      'all-day event unchanged round-trip must be no-op');
  });

  await t.test('null existing ICS returns false (safe default)', () => {
    const parsed = parseICSToEvent(buildRecurringICS());
    assert.equal(isNoOpEventSave(null, parsed), false,
      'null existing ICS must return false');
  });

  await t.test('empty existing ICS returns false (safe default)', () => {
    const parsed = parseICSToEvent(buildRecurringICS());
    assert.equal(isNoOpEventSave('', parsed), false,
      'empty existing ICS must return false');
  });

  await t.test('alarm trigger change is NOT a no-op', () => {
    const ics = buildRecurringICS();
    const parsed = parseICSToEvent(ics);
    const modified = {
      ...parsed,
      alarms: [{ action: 'DISPLAY', trigger: '-PT30M', description: 'Reminder' }]
    };
    assert.equal(isNoOpEventSave(ics, modified), false,
      'alarm trigger change must not be a no-op');
  });

});
