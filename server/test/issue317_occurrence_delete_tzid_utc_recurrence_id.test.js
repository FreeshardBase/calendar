const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndExpandEvent, addOccurrenceException, upsertOccurrenceOverride, cloneOccurrenceOverride } = require('../utils/ical.js');
const ICAL = require('ical.js');

test('Issue #317 — Occurrence delete silently does nothing for TZID series when recurrence-id is sent in UTC form', async (t) => {

  const weeklyIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WebCalendar//EN
BEGIN:VEVENT
UID:tzid-series-317
DTSTART;TZID=Europe/Berlin:20260515T120000
DTEND;TZID=Europe/Berlin:20260515T130000
RRULE:FREQ=WEEKLY
SUMMARY:Weekly Standup Europe/Berlin
END:VEVENT
END:VCALENDAR`;

  await t.test('1. addOccurrenceException with UTC recurrenceId (2026-05-15T10:00:00.000Z) generates EXDATE matching master wall-clock time in Europe/Berlin', () => {
    // 2026-05-15 12:00:00 Europe/Berlin is UTC 10:00:00.
    const utcRecId = '2026-05-15T10:00:00.000Z';
    const updatedIcs = addOccurrenceException(weeklyIcs, utcRecId);

    assert.match(updatedIcs, /EXDATE;TZID=Europe\/Berlin:20260515T120000/, 'EXDATE must use master wall-clock time (12:00:00) in Europe/Berlin, not 10:00:00');

    const instances = parseAndExpandEvent(updatedIcs, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z');
    const may15Occ = instances.find(inst => inst.start.startsWith('2026-05-15'));
    assert.equal(may15Occ, undefined, 'Occurrence on 2026-05-15 must be suppressed/deleted');
  });

  await t.test('2. addOccurrenceException with basic iCalendar UTC recurrenceId (20260515T100000Z)', () => {
    const icalUtcRecId = '20260515T100000Z';
    const updatedIcs = addOccurrenceException(weeklyIcs, icalUtcRecId);

    assert.match(updatedIcs, /EXDATE;TZID=Europe\/Berlin:20260515T120000/);

    const instances = parseAndExpandEvent(updatedIcs, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z');
    const may15Occ = instances.find(inst => inst.start.startsWith('2026-05-15'));
    assert.equal(may15Occ, undefined, 'Occurrence on 2026-05-15 must be suppressed/deleted');
  });

  await t.test('3. removeOverride removes detached override VEVENT when recurrenceId is in UTC form', () => {
    const icsWithOverride = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WebCalendar//EN
BEGIN:VEVENT
UID:tzid-series-317
DTSTART;TZID=Europe/Berlin:20260515T120000
DTEND;TZID=Europe/Berlin:20260515T130000
RRULE:FREQ=WEEKLY
SUMMARY:Weekly Standup Europe/Berlin
END:VEVENT
BEGIN:VEVENT
UID:tzid-series-317
RECURRENCE-ID;TZID=Europe/Berlin:20260515T120000
DTSTART;TZID=Europe/Berlin:20260515T140000
DTEND;TZID=Europe/Berlin:20260515T150000
SUMMARY:Moved Standup
END:VEVENT
END:VCALENDAR`;

    const updatedIcs = addOccurrenceException(icsWithOverride, '2026-05-15T10:00:00.000Z');

    assert.equal(updatedIcs.includes('SUMMARY:Moved Standup'), false, 'Detached override must be removed from ICS');
    assert.match(updatedIcs, /EXDATE;TZID=Europe\/Berlin:20260515T120000/);
  });

  const dailyIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WebCalendar//EN
BEGIN:VEVENT
UID:tzid-daily-317
DTSTART;TZID=Europe/Berlin:20261101T230000
DTEND;TZID=Europe/Berlin:20261101T233000
RRULE:FREQ=DAILY
SUMMARY:Daily Late Berlin
END:VEVENT
END:VCALENDAR`;
  const overrideData = {
    title: 'Edited', start: '2026-11-02T22:30:00.000Z', end: '2026-11-02T23:00:00.000Z',
    allDay: false, timezone: 'Europe/Berlin'
  };
  const ridCount = (ics) => (ics.match(/^RECURRENCE-ID/mg) || []).length;

  await t.test('4. local and UTC form of the same occurrence replace one override instead of accumulating', () => {
    let ics = upsertOccurrenceOverride(dailyIcs, '2026-11-02T23:00:00', overrideData);
    ics = upsertOccurrenceOverride(ics, '2026-11-02T22:00:00Z', overrideData);
    assert.equal(ridCount(ics), 1);
    assert.match(ics, /RECURRENCE-ID;TZID=Europe\/Berlin:20261102T230000/);
  });

  const rejected = (fn) => assert.throws(fn, (err) => err.status === 400 && typeof err.userMessage === 'string');

  await t.test('5. an out-of-range but parseable recurrence-id is refused, not normalised to another day', () => {
    rejected(() => upsertOccurrenceOverride(dailyIcs, '2026-13-45T99:99:99Z', overrideData));
    rejected(() => addOccurrenceException(dailyIcs, '2026-13-45T99:99:99Z'));
  });

  await t.test('6. a recurrence-id that is not an instance of the series is refused', () => {
    // 22:00 Berlin: the series occurs at 23:00.
    rejected(() => addOccurrenceException(dailyIcs, '2026-11-02T22:00:00'));
    rejected(() => upsertOccurrenceOverride(dailyIcs, '2026-11-02T21:00:00Z', overrideData));
    // Before DTSTART.
    rejected(() => addOccurrenceException(dailyIcs, '2026-10-30T23:00:00'));
    const comp = new ICAL.Component(ICAL.parse(dailyIcs));
    rejected(() => cloneOccurrenceOverride(comp, '2026-11-02T22:00:00'));
  });

  await t.test('7. a malformed recurrence-id is refused with 400, not an opaque 500', () => {
    rejected(() => addOccurrenceException(dailyIcs, 'garbage'));
    rejected(() => addOccurrenceException(dailyIcs, '2026-11-02T23:00:00\r\nX-INJECT:1'));
    rejected(() => upsertOccurrenceOverride(dailyIcs, '', overrideData));
  });

  await t.test('8. an already deleted occurrence can be deleted again (EXDATE does not make it unknown)', () => {
    const once = addOccurrenceException(dailyIcs, '2026-11-02T23:00:00');
    const twice = addOccurrenceException(once, '2026-11-02T22:00:00Z');
    const instances = parseAndExpandEvent(twice, '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z');
    assert.equal(instances.some(i => i.recurrenceId === '2026-11-02T23:00:00'), false);
    assert.equal(instances.length, 3);
  });

  const allDayIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WebCalendar//EN
BEGIN:VEVENT
UID:allday-series-317
DTSTART;VALUE=DATE:20261101
DTEND;VALUE=DATE:20261102
RRULE:FREQ=DAILY
SUMMARY:All Day Series
END:VEVENT
END:VCALENDAR`;

  await t.test('9. all-day series: deleting the occurrence id the server emits removes that day', () => {
    const before = parseAndExpandEvent(allDayIcs, '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z');
    const rid = before.find(i => i.start.startsWith('2026-11-02')).recurrenceId;
    assert.equal(rid, '2026-11-02');
    const ics = addOccurrenceException(allDayIcs, rid);
    assert.match(ics, /EXDATE;VALUE=DATE:20261102/);
    const after = parseAndExpandEvent(ics, '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z');
    assert.equal(after.some(i => i.recurrenceId === '2026-11-02'), false);
    assert.equal(after.length, before.length - 1);
  });

  await t.test('10. all-day series: editing one occurrence twice keeps one override', () => {
    const data = { title: 'Edited day', start: '2026-11-02', end: '2026-11-03', allDay: true };
    let ics = upsertOccurrenceOverride(allDayIcs, '2026-11-02', data);
    ics = upsertOccurrenceOverride(ics, '20261102', data);
    assert.equal(ridCount(ics), 1);
    assert.match(ics, /RECURRENCE-ID;VALUE=DATE:20261102/);
    rejected(() => upsertOccurrenceOverride(allDayIcs, '2026-10-30', data));
  });
});
