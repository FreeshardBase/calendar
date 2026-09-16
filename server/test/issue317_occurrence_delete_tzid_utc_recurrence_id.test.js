const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndExpandEvent, addOccurrenceException, removeOverride, parseICSToEvent } = require('../utils/ical.js');

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
});
