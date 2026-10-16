'use strict';

// Issue #302: a VTODO's deadline derived from DTSTART + DURATION must use exact
// time for the hour/minute/second part (RFC 5545 §3.3.6/§3.8.2.5), not
// ICAL.Time.addDuration's wall-clock addition, or a task spanning a DST
// changeover shows its deadline an hour off (#293's defect on the task path).
// Fixtures embed the Berlin VTIMEZONE, as a foreign client would.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToTask, taskToICS } = require('../caldav/parser');

const BERLIN = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
];

function fixture(dtstartLine, duration) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    ...BERLIN,
    'BEGIN:VTODO',
    'UID:task302dst@example.com',
    'SUMMARY:Test User task',
    'STATUS:NEEDS-ACTION',
    dtstartLine,
    `DURATION:${duration}`,
    'END:VTODO',
    'END:VCALENDAR'
  ].join('\r\n');
}

test('PT5H spanning the autumn changeover: deadline is five exact hours after start', () => {
  const t = parseICSToTask(fixture('DTSTART;TZID=Europe/Berlin:20261024T230000', 'PT5H'));
  assert.equal(t.dtstart, '2026-10-24T21:00:00.000Z');
  assert.equal(t.due, '2026-10-25T02:00:00.000Z');
});

test('PT5H spanning the spring changeover: deadline is five exact hours after start', () => {
  const t = parseICSToTask(fixture('DTSTART;TZID=Europe/Berlin:20260328T230000', 'PT5H'));
  assert.equal(t.dtstart, '2026-03-28T22:00:00.000Z');
  assert.equal(t.due, '2026-03-29T03:00:00.000Z');
});

test('control: PT5H one week earlier, no changeover inside', () => {
  const t = parseICSToTask(fixture('DTSTART;TZID=Europe/Berlin:20261018T230000', 'PT5H'));
  assert.equal(t.due, '2026-10-19T02:00:00.000Z');
});

test('control: Z-form start spanning the changeover', () => {
  const t = parseICSToTask(fixture('DTSTART:20261024T210000Z', 'PT5H'));
  assert.equal(t.due, '2026-10-25T02:00:00.000Z');
});

test('P1D stays nominal: same Berlin wall clock next day, 25 real hours across fall-back', () => {
  const t = parseICSToTask(fixture('DTSTART;TZID=Europe/Berlin:20261024T120000', 'P1D'));
  assert.equal(t.due, '2026-10-25T11:00:00.000Z');
});

test('all-day DTSTART + P2D gives a date deadline', () => {
  const t = parseICSToTask(fixture('DTSTART;VALUE=DATE:20261024', 'P2D'));
  assert.equal(t.due, '2026-10-26T00:00:00.000Z');
});

test('stored bytes: zero-edit saves keep DTSTART + DURATION, never write DUE, deadline stable', () => {
  for (const [start, expectedDue] of [
    ['20261024T230000', '2026-10-25T02:00:00.000Z'],
    ['20261018T230000', '2026-10-19T02:00:00.000Z']
  ]) {
    let ics = fixture(`DTSTART;TZID=Europe/Berlin:${start}`, 'PT5H');
    for (let i = 0; i < 4; i++) {
      const parsed = parseICSToTask(ics);
      assert.equal(parsed.due, expectedDue, `${start} read ${i + 1}: deadline`);
      ics = taskToICS(parsed, ics);
      assert.match(ics, /\r?\nDURATION:PT5H\r?\n/, `${start} save ${i + 1}: DURATION kept`);
      assert.match(ics, /\r?\nDTSTART[;:]/, `${start} save ${i + 1}: DTSTART kept`);
      assert.doesNotMatch(ics, /\r?\nDUE[;:]/, `${start} save ${i + 1}: no DUE written`);
    }
  }
});
