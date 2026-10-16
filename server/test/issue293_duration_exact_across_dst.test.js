'use strict';

// Issue #293 facet A: DURATION on a DATE-TIME DTSTART is exact time for its
// hour/minute/second part (RFC 5545 §3.3.6/§3.8.2.5), so a PT5H event across a
// DST changeover must stay five real hours. Day/week parts stay nominal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, parseAndExpandEvent, eventToICS, updateWholeSeries } = require('../utils/ical');

const HOUR = 3600 * 1000;
const hours = (ev) => (new Date(ev.end) - new Date(ev.start)) / HOUR;

function fixture(date, duration, extra = []) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:dur293@example.com',
    'SUMMARY:Test User duration',
    `DTSTART;TZID=Europe/Berlin:${date}`,
    `DURATION:${duration}`,
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

test('PT5H spanning the autumn changeover is five exact hours', () => {
  const p = parseICSToEvent(fixture('20261024T230000', 'PT5H'));
  assert.equal(p.start, '2026-10-24T21:00:00.000Z');
  assert.equal(p.end, '2026-10-25T02:00:00.000Z');
  assert.equal(hours(p), 5);
});

test('PT5H spanning the spring changeover is five exact hours', () => {
  const p = parseICSToEvent(fixture('20260328T230000', 'PT5H'));
  assert.equal(p.start, '2026-03-28T22:00:00.000Z');
  assert.equal(p.end, '2026-03-29T03:00:00.000Z');
  assert.equal(hours(p), 5);
});

test('control: PT5H one week earlier, no changeover, is five hours', () => {
  const p = parseICSToEvent(fixture('20261018T230000', 'PT5H'));
  assert.equal(p.start, '2026-10-18T21:00:00.000Z');
  assert.equal(p.end, '2026-10-19T02:00:00.000Z');
  assert.equal(p.endTimeZone, 'Europe/Berlin');
});

test('P1D stays nominal: same wall clock next day, 25 real hours across fall-back', () => {
  const p = parseICSToEvent(fixture('20261024T120000', 'P1D'));
  assert.equal(p.start, '2026-10-24T10:00:00.000Z');
  assert.equal(p.end, '2026-10-25T11:00:00.000Z');
});

test('P1DT2H: day part nominal, hour part exact', () => {
  const p = parseICSToEvent(fixture('20261024T010000', 'P1DT2H'));
  // 24th 01:00 CEST + P1D = 25th 01:00 CEST (24th 23:00Z), + 2 exact hours = 25th 01:00Z
  // (all-nominal arithmetic would give wall clock 03:00 CET = 02:00Z)
  assert.equal(p.end, '2026-10-25T01:00:00.000Z');
});

test('saving the parsed event (modal payload without duration) stores the correct end', () => {
  const ics = fixture('20261024T230000', 'PT5H');
  const p = parseICSToEvent(ics);
  const payload = { uid: p.uid, title: 'edited', start: p.start, end: p.end, allDay: false,
    startTimeZone: p.startTimeZone, endTimeZone: p.endTimeZone };
  for (const out of [updateWholeSeries(ics, payload), eventToICS(payload, ics)]) {
    const reparsed = parseICSToEvent(out);
    assert.equal(reparsed.start, '2026-10-24T21:00:00.000Z');
    assert.equal(reparsed.end, '2026-10-25T02:00:00.000Z');
    assert.equal(hours(reparsed), 5);
  }
});

test('recurring PT5H: the occurrence crossing the changeover is five exact hours', () => {
  const ics = fixture('20261017T230000', 'PT5H', ['RRULE:FREQ=WEEKLY;COUNT=3']);
  const occ = parseAndExpandEvent(ics, '2026-10-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z');
  assert.equal(occ.length, 3);
  for (const o of occ) assert.equal(hours(o), 5, `occurrence ${o.start}`);
  assert.equal(occ[1].start, '2026-10-24T21:00:00.000Z');
  assert.equal(occ[1].end, '2026-10-25T02:00:00.000Z');
});
