'use strict';

// Issue #260 residue: saving a TZID-anchored foreign VTODO rewrote DTSTART/DUE
// as UTC values but kept the inherited TZID parameter
// ("DTSTART;TZID=Europe/Berlin:20260803T070000Z"), which RFC 5545 §3.2.19
// forbids. The fix drops TZID whenever the value is written in UTC; the instant
// must stay the same and untouched TZID properties (EXDATE, RECURRENCE-ID) keep theirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseICSToTask, taskToICS } = require('../caldav/parser');

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'END:VTIMEZONE'
];

const recurringFixture = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
  'VERSION:2.0',
  ...VTIMEZONE,
  'BEGIN:VTODO',
  'UID:task-tzid-260',
  'CREATED:20260801T080000Z',
  'DTSTAMP:20260801T080000Z',
  'SUMMARY:Wochenbericht',
  'DESCRIPTION:Bericht schreiben',
  'STATUS:NEEDS-ACTION',
  'PRIORITY:2',
  'DTSTART;TZID=Europe/Berlin:20260803T090000',
  'DUE;TZID=Europe/Berlin:20260803T170000',
  'RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO',
  'EXDATE;TZID=Europe/Berlin:20260817T090000',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VTODO',
  'BEGIN:VTODO',
  'UID:task-tzid-260',
  'DTSTAMP:20260801T080000Z',
  'RECURRENCE-ID;TZID=Europe/Berlin:20260810T090000',
  'SUMMARY:Wochenbericht',
  'STATUS:COMPLETED',
  'DTSTART;TZID=Europe/Berlin:20260810T090000',
  'DUE;TZID=Europe/Berlin:20260810T170000',
  'END:VTODO',
  'END:VCALENDAR'
].join('\r\n');

const plainFixture = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
  'VERSION:2.0',
  ...VTIMEZONE,
  'BEGIN:VTODO',
  'UID:task-tzid-260-plain',
  'DTSTAMP:20260801T080000Z',
  'SUMMARY:Einkauf',
  'STATUS:NEEDS-ACTION',
  'DTSTART;TZID=Europe/Berlin:20260803T090000',
  'DUE;TZID=Europe/Berlin:20260803T170000',
  'END:VTODO',
  'END:VCALENDAR'
].join('\r\n');

function masterVtodo(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  return comp.getAllSubcomponents('vtodo').find(v => !v.getFirstProperty('recurrence-id'));
}

function utcValuesWithTzid(ics) {
  // Every content line whose value ends in "Z" (UTC) but still carries TZID.
  return ics.split(/\r?\n/).filter(line => /;TZID=[^:]*:\d{8}T\d{6}Z$/.test(line));
}

function instantOf(ics, name) {
  return masterVtodo(ics).getFirstPropertyValue(name).toJSDate().toISOString();
}

test.describe('Issue #260 — TZID-anchored VTODO dates written as UTC must not keep TZID', () => {
  test('zero-edit save of the recurring Thunderbird fixture writes RFC 5545 §3.2.19-valid DTSTART/DUE', () => {
    const parsed = parseICSToTask(recurringFixture, { calendarId: 'cal-1' });
    // The seven-field payload the task modal sends, browser in UTC.
    const payload = {
      uid: parsed.uid,
      title: parsed.title,
      description: parsed.description,
      status: parsed.status,
      due: parsed.due,
      dtstart: parsed.dtstart,
      priority: parsed.priority
    };

    const out = taskToICS(payload, recurringFixture);

    assert.deepEqual(utcValuesWithTzid(out), [], 'no UTC value may carry a TZID parameter');

    const master = masterVtodo(out);
    assert.equal(master.getFirstProperty('dtstart').getParameter('tzid'), undefined);
    assert.equal(master.getFirstProperty('due').getParameter('tzid'), undefined);

    // Instant preserved: 09:00 / 17:00 Berlin (CEST) = 07:00Z / 15:00Z.
    assert.equal(instantOf(out, 'dtstart'), '2026-08-03T07:00:00.000Z');
    assert.equal(instantOf(out, 'due'), '2026-08-03T15:00:00.000Z');

    // Properties the save does not touch keep their TZID anchoring.
    assert.match(out, /EXDATE;TZID=Europe\/Berlin:20260817T090000\r?\n/);
    assert.match(out, /RECURRENCE-ID;TZID=Europe\/Berlin:20260810T090000\r?\n/);
    assert.match(out, /BEGIN:VTIMEZONE/);
  });

  test('a genuine retitle of a non-recurring TZID task also drops TZID on the UTC values', () => {
    const parsed = parseICSToTask(plainFixture, { calendarId: 'cal-1' });
    const out = taskToICS({
      uid: parsed.uid,
      title: 'Einkauf erledigen',
      status: parsed.status,
      due: parsed.due,
      dtstart: parsed.dtstart
    }, plainFixture);

    assert.deepEqual(utcValuesWithTzid(out), []);
    assert.match(out, /SUMMARY:Einkauf erledigen/);
    assert.match(out, /DTSTART:20260803T070000Z\r?\n/);
    assert.match(out, /DUE:20260803T150000Z\r?\n/);
    assert.equal(instantOf(out, 'dtstart'), '2026-08-03T07:00:00.000Z');
    assert.equal(instantOf(out, 'due'), '2026-08-03T15:00:00.000Z');
  });

  test('changing DUE to a date-only value drops TZID too (DATE values carry no zone)', () => {
    const parsed = parseICSToTask(plainFixture, { calendarId: 'cal-1' });
    const out = taskToICS({
      uid: parsed.uid,
      title: parsed.title,
      due: '2026-08-05',
      dueIsDate: true
    }, plainFixture);

    const due = masterVtodo(out).getFirstProperty('due');
    assert.equal(due.getFirstValue().isDate, true);
    assert.equal(due.getParameter('tzid'), undefined);
    assert.match(out, /DUE;VALUE=DATE:20260805\r?\n/);
  });
});
