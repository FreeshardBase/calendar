'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave, parseAndExpandEvent } = require('../utils/ical');

test('Issue #55 — All-Day Event Cumulative Shift & Round-Trip Preservation', async (t) => {
  await t.test('parseICSToEvent parses VALUE=DATE as UTC midnight ISO without timezone shift', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-test-1',
      'SUMMARY:Ganztägiges Event',
      'DTSTART;VALUE=DATE:20260824',
      'DTEND;VALUE=DATE:20260825',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const event = parseICSToEvent(ics);
    assert.equal(event.allDay, true);
    assert.equal(event.start, '2026-08-24T00:00:00.000Z');
    assert.equal(event.end, '2026-08-25T00:00:00.000Z');
  });

  await t.test('eventToICS serializes UTC ISO start/end back to exact VALUE=DATE without drift', () => {
    const event = {
      uid: 'allday-test-1',
      title: 'Ganztägiges Event',
      start: '2026-08-24T00:00:00.000Z',
      end: '2026-08-25T00:00:00.000Z',
      allDay: true
    };

    const outputIcs = eventToICS(event);
    assert.match(outputIcs, /DTSTART;VALUE=DATE:20260824/);
    assert.match(outputIcs, /DTEND;VALUE=DATE:20260825/);
  });

  await t.test('10 cumulative round-trips produce zero day shift', () => {
    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-drift-check',
      'SUMMARY:No Drift',
      'DTSTART;VALUE=DATE:20260824',
      'DTEND;VALUE=DATE:20260825',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    for (let i = 0; i < 10; i++) {
      const parsed = parseICSToEvent(ics);
      assert.equal(parsed.start, '2026-08-24T00:00:00.000Z', `Failed on iteration ${i} start`);
      assert.equal(parsed.end, '2026-08-25T00:00:00.000Z', `Failed on iteration ${i} end`);
      ics = eventToICS(parsed);
      assert.match(ics, /DTSTART;VALUE=DATE:20260824/, `Failed on iteration ${i} DTSTART match`);
      assert.match(ics, /DTEND;VALUE=DATE:20260825/, `Failed on iteration ${i} DTEND match`);
    }
  });

  await t.test('isNoOpEventSave returns true for all-day event round-trip', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-noop-check',
      'SUMMARY:No-Op AllDay',
      'DTSTART;VALUE=DATE:20260824',
      'DTEND;VALUE=DATE:20260825',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const parsed = parseICSToEvent(existingIcs);
    const isNoOp = isNoOpEventSave(existingIcs, parsed);
    assert.equal(isNoOp, true);
  });

  await t.test('parseAndExpandEvent returns UTC midnight ISO for all-day instances', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-expand-check',
      'SUMMARY:AllDay Series',
      'DTSTART;VALUE=DATE:20260824',
      'DTEND;VALUE=DATE:20260825',
      'RRULE:FREQ=DAILY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const instances = parseAndExpandEvent(ics, '2026-08-20T00:00:00Z', '2026-08-30T00:00:00Z');
    assert.equal(instances.length, 3);
    assert.equal(instances[0].start, '2026-08-24T00:00:00.000Z');
    assert.equal(instances[0].end, '2026-08-25T00:00:00.000Z');
    assert.equal(instances[1].start, '2026-08-25T00:00:00.000Z');
    assert.equal(instances[1].end, '2026-08-26T00:00:00.000Z');
  });
});
