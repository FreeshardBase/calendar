/**
 * Issue #91 follow-up — the server-side BYDAY normalisation must resolve the
 * weekday in the event's own time zone, not from the UTC instant.
 *
 * The dialog sends `start` as a UTC ISO string plus `startTimeZone`, and
 * computes BYDAY from the local date field. Whenever the local date differs
 * from the UTC date (evening in the Americas, early morning in Europe/Asia),
 * deriving the weekday via getUTCDay() rewrote a correct rule into a wrong
 * one: a Monday 20:00 New York series became BYDAY=TU.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const ICAL   = require('ical.js');
const {
  eventToICS,
  parseAndExpandEvent,
  normalizeRecurrenceRule
} = require('../utils/ical');

function localWeekdays(occurrences, tz) {
  return occurrences.map(o => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date(o.start)));
}

function rruleOf(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const master = comp.getAllSubcomponents('vevent').find(v => !v.getFirstProperty('recurrence-id'));
  return master.getFirstPropertyValue('rrule').toString();
}

test('normalizeRecurrenceRule resolves the weekday in the given time zone', () => {
  // Monday 2026-08-10 20:00 in New York is Tuesday 00:00 UTC.
  assert.equal(
    normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO', '2026-08-11T00:00:00.000Z', 'America/New_York'),
    'FREQ=WEEKLY;BYDAY=MO'
  );
  // Monday 2026-08-10 00:30 in Berlin is Sunday 22:30 UTC.
  assert.equal(
    normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO', '2026-08-09T22:30:00.000Z', 'Europe/Berlin'),
    'FREQ=WEEKLY;BYDAY=MO'
  );
  // A wrong weekday is still repaired, against the local date.
  assert.equal(
    normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=WE', '2026-08-11T00:00:00.000Z', 'America/New_York'),
    'FREQ=WEEKLY;BYDAY=MO'
  );
  // Without a time zone the DTSTART is written in UTC, so UTC is the reference.
  assert.equal(
    normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO', '2026-08-11T00:00:00.000Z'),
    'FREQ=WEEKLY;BYDAY=TU'
  );
});

// The Berlin case ends in UTC: only the start zone decides the weekday.
for (const { tz, endTz, start, end } of [
  { tz: 'America/New_York', endTz: 'America/New_York', start: '2026-08-11T00:00:00.000Z', end: '2026-08-11T01:00:00.000Z' },
  { tz: 'Europe/Berlin',    endTz: 'UTC',              start: '2026-08-09T22:30:00.000Z', end: '2026-08-09T23:30:00.000Z' }
]) {
  test(`eventToICS (create) keeps a Monday series on Mondays in ${tz}`, () => {
    const ics = eventToICS({
      uid: 'issue91-tz-create',
      title: 'Weekly sync',
      start, end,
      startTimeZone: tz,
      endTimeZone: endTz,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO'
    });
    assert.match(rruleOf(ics), /BYDAY=MO/);
    const occ = parseAndExpandEvent(ics, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
    assert.ok(occ.length >= 3, 'expected at least three occurrences');
    assert.deepEqual([...new Set(localWeekdays(occ, tz))], ['Mon']);
    assert.equal(occ[0].start, start, 'first occurrence is the chosen start');
  });
}

test('eventToICS keeps an all-day series on its DATE weekday even with a startTimeZone', () => {
  // All-day DTSTART is written as the instant's UTC date, so the zone must not apply.
  const ics = eventToICS({
    uid: 'issue91-tz-allday',
    title: 'All-day weekly',
    allDay: true,
    start: '2026-08-10T00:00:00.000Z',
    end:   '2026-08-11T00:00:00.000Z',
    startTimeZone: 'America/New_York',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO'
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260810/);
  assert.match(rruleOf(ics), /BYDAY=MO/);
});
