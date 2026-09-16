'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave, updateWholeSeries } = require('../utils/ical');

test('Issue #293 — DURATION to DTEND Silent Conversion & Length Error Prevention', async (t) => {
  await t.test('parseICSToEvent extracts duration and inherits endTimeZone from startTimeZone when DTEND is absent', () => {
    const durationIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:duration-test-293',
      'SUMMARY:Duration Event Test',
      'DTSTART;TZID=America/Denver:20260601T100000',
      'DURATION:PT1H',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const parsed = parseICSToEvent(durationIcs);
    assert.ok(parsed, 'parsed event should not be null');
    assert.equal(parsed.start, '2026-06-01T16:00:00.000Z');
    assert.equal(parsed.end, '2026-06-01T17:00:00.000Z');
    assert.equal(parsed.startTimeZone, 'America/Denver');
    assert.equal(parsed.endTimeZone, 'America/Denver', 'endTimeZone should inherit startTimeZone when derived from DURATION');
    assert.equal(parsed.duration, 'PT1H', 'duration property should be extracted');
  });

  await t.test('eventToICS serializes DURATION without writing conflicting DTEND or un-qualified UTC DTEND', () => {
    const event = {
      uid: 'duration-test-293',
      title: 'Duration Event Test',
      start: '2026-06-01T16:00:00.000Z',
      end: '2026-06-01T17:00:00.000Z',
      startTimeZone: 'America/Denver',
      endTimeZone: 'America/Denver',
      duration: 'PT1H',
      allDay: false
    };

    const outputIcs = eventToICS(event);
    assert.match(outputIcs, /DURATION:PT1H/);
    assert.doesNotMatch(outputIcs, /DTEND/, 'RFC 5545: VEVENT MUST NOT include both DTEND and DURATION');
  });

  await t.test('updateWholeSeries removes DURATION when converting event to explicit DTEND', () => {
    const durationIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:duration-test-293',
      'SUMMARY:Duration Event Test',
      'DTSTART;TZID=America/Denver:20260601T100000',
      'DURATION:PT1H',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatePayload = {
      uid: 'duration-test-293',
      title: 'Explicit DTEND Event',
      start: '2026-06-01T16:00:00.000Z',
      end: '2026-06-01T17:00:00.000Z',
      startTimeZone: 'America/Denver',
      endTimeZone: 'America/Denver',
      allDay: false
    };

    const updatedIcs = updateWholeSeries(durationIcs, updatePayload);
    assert.match(updatedIcs, /DTSTART;TZID=America\/Denver:20260601T100000/);
    assert.match(updatedIcs, /DTEND;TZID=America\/Denver:20260601T110000/, 'DTEND must retain America/Denver TZID to prevent length error');
    assert.doesNotMatch(updatedIcs, /DURATION:/, 'DURATION property must be purged when explicit DTEND is set');
  });

  await t.test('isNoOpEventSave returns true for duration events and 5 roundtrips preserve duration and start/end', () => {
    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:duration-roundtrip-293',
      'SUMMARY:Roundtrip Duration',
      'DTSTART;TZID=America/Denver:20260601T100000',
      'DURATION:PT1H',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    for (let i = 0; i < 5; i++) {
      const parsed = parseICSToEvent(ics);
      assert.equal(parsed.start, '2026-06-01T16:00:00.000Z', `Iteration ${i} start`);
      assert.equal(parsed.end, '2026-06-01T17:00:00.000Z', `Iteration ${i} end`);
      assert.equal(isNoOpEventSave(ics, parsed), true, `Iteration ${i} isNoOp`);
      ics = eventToICS(parsed, ics);
      assert.match(ics, /DURATION:PT1H/, `Iteration ${i} DURATION match`);
      assert.doesNotMatch(ics, /DTEND/, `Iteration ${i} DTEND exclusion`);
    }
  });
});
