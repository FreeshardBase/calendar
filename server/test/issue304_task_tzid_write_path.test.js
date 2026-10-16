'use strict';

// Issue #304: the task suite only fed bare-Z fixtures through the write path,
// so a drift or byte corruption that hits only TZID-labelled dates stayed
// invisible. These tests save TZID-anchored VTODOs through taskToICS with the
// stored ICS present (the real setDateProp path) and assert on the stored bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseICSToTask, taskToICS } = require('../caldav/parser');

const BERLIN_VTIMEZONE = [
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

function vtodoIcs(uid, lines) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar Test//EN',
    ...BERLIN_VTIMEZONE,
    'BEGIN:VTODO',
    `UID:${uid}`,
    'SUMMARY:Test task',
    'STATUS:NEEDS-ACTION',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR'
  ].join('\r\n');
}

// Unfolded content lines of the stored VTODO for the given property name.
function storedLines(ics, name) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const vtodo = unfolded.slice(unfolded.indexOf('BEGIN:VTODO'));
  return vtodo.split(/\r?\n/).filter(l => new RegExp(`^${name}[;:]`, 'i').test(l));
}

// The instant the stored bytes denote, read by ical.js directly rather than
// through the app's own parser.
function storedInstant(ics, name) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vtz = comp.getFirstSubcomponent('vtimezone');
  if (vtz) ICAL.TimezoneService.register(vtz);
  const prop = comp.getFirstSubcomponent('vtodo').getFirstProperty(name);
  assert.ok(prop, `stored VTODO must carry ${name.toUpperCase()}`);
  return prop.getFirstValue().toJSDate().toISOString();
}

// RFC 5545 §3.2.19: a TZID parameter must not be applied to a UTC DATE-TIME.
function assertNoTzidOnUtc(ics, name) {
  for (const line of storedLines(ics, name)) {
    assert.ok(!(/;TZID=/i.test(line) && /Z$/.test(line)),
      `stored line carries both TZID and a Z designator: ${line}`);
  }
}

function zeroEditSaves(seed, n) {
  const snapshots = [];
  let ics = seed;
  for (let i = 0; i < n; i++) {
    ics = taskToICS(parseICSToTask(ics), ics);
    snapshots.push(ics);
  }
  return snapshots;
}

test('DUE;TZID=Europe/Berlin keeps its instant and valid bytes across 4 zero-edit saves', () => {
  const seed = vtodoIcs('task-304-due-tzid', ['DUE;TZID=Europe/Berlin:20260815T140000']);
  assert.equal(storedInstant(seed, 'due'), '2026-08-15T12:00:00.000Z');

  zeroEditSaves(seed, 4).forEach((ics, i) => {
    assert.equal(storedLines(ics, 'DUE').length, 1, `save ${i + 1}: exactly one DUE line`);
    assertNoTzidOnUtc(ics, 'DUE');
    assert.equal(storedInstant(ics, 'due'), '2026-08-15T12:00:00.000Z',
      `save ${i + 1}: stored DUE drifted: ${storedLines(ics, 'DUE')[0]}`);
  });
});

test('DUE;TZID=America/New_York keeps its instant and valid bytes across 4 zero-edit saves', () => {
  const nyTz = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE'
  ];
  const seed = vtodoIcs('task-304-due-ny', ['DUE;TZID=America/New_York:20260815T090000'])
    .replace(BERLIN_VTIMEZONE.join('\r\n'), nyTz.join('\r\n'));
  assert.equal(storedInstant(seed, 'due'), '2026-08-15T13:00:00.000Z');

  zeroEditSaves(seed, 4).forEach((ics, i) => {
    assertNoTzidOnUtc(ics, 'DUE');
    assert.equal(storedInstant(ics, 'due'), '2026-08-15T13:00:00.000Z',
      `save ${i + 1}: stored DUE drifted: ${storedLines(ics, 'DUE')[0]}`);
  });
});

test('editing the due date of a TZID-anchored task stores exactly the new instant', () => {
  const seed = vtodoIcs('task-304-due-edit', ['DUE;TZID=Europe/Berlin:20260815T140000']);
  const task = parseICSToTask(seed);
  const ics = taskToICS({ ...task, due: '2026-08-20T07:30:00.000Z' }, seed);

  assertNoTzidOnUtc(ics, 'DUE');
  assert.equal(storedInstant(ics, 'due'), '2026-08-20T07:30:00.000Z');
});

// DTSTART;TZID + DURATION:PT5H. Berlin leaves summer time at 2026-10-25 03:00
// local, so the first fixture's 5 hours span the changeover and the second,
// one week earlier, is the non-spanning control. DURATION hours are exact
// time (RFC 5545 §3.3.6), so in both the deadline is DTSTART + 5 h.
const DURATION_CASES = [
  { label: 'DST-spanning', local: '20261024T220000', start: '2026-10-24T20:00:00.000Z', due: '2026-10-25T01:00:00.000Z' },
  { label: 'non-spanning control', local: '20261017T220000', start: '2026-10-17T20:00:00.000Z', due: '2026-10-18T01:00:00.000Z' }
];

for (const c of DURATION_CASES) {
  test(`DTSTART;TZID + DURATION:PT5H (${c.label}) keeps start, duration and deadline in the stored bytes across 4 saves`, () => {
    const seed = vtodoIcs(`task-304-dur-${c.local}`, [
      `DTSTART;TZID=Europe/Berlin:${c.local}`,
      'DURATION:PT5H'
    ]);
    assert.equal(storedInstant(seed, 'dtstart'), c.start);

    zeroEditSaves(seed, 4).forEach((ics, i) => {
      const tag = `${c.label}, save ${i + 1}`;
      assert.deepEqual(storedLines(ics, 'DURATION'), ['DURATION:PT5H'], `${tag}: DURATION must survive verbatim`);
      assert.deepEqual(storedLines(ics, 'DUE'), [], `${tag}: DUE must not be added next to DURATION`);
      assertNoTzidOnUtc(ics, 'DTSTART');
      assert.equal(storedInstant(ics, 'dtstart'), c.start,
        `${tag}: stored DTSTART drifted: ${storedLines(ics, 'DTSTART')[0]}`);

      const reread = parseICSToTask(ics);
      assert.equal(reread.due, c.due, `${tag}: deadline must be DTSTART + 5 h of real time`);
    });
  });
}
