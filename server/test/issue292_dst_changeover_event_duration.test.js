'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave } = require('../utils/ical');

test('Issue #292 — Event Spanning DST Changeover Duration & Zero-Edit Save Preservation', async (t) => {
  await t.test('Spring DST transition event duration and dates are preserved across zero-edit save', () => {
    // Spring DST changeover in Europe/Berlin: 2026-03-29 02:00 CET (+1) -> 03:00 CEST (+2)
    // DTSTART: 01:30 CET (00:30 UTC)
    // DTEND: 03:30 CEST (01:30 UTC)
    // Real duration: 60 minutes (1 hour)
    const springIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue292-spring-span',
      'SUMMARY:Spring DST Shift',
      'DTSTART;TZID=Europe/Berlin:20260329T013000',
      'DTEND;TZID=Europe/Berlin:20260329T033000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(springIcs);
    assert.ok(ev, 'Event should be parsed');
    assert.strictEqual(ev.start, '2026-03-29T00:30:00.000Z');
    assert.strictEqual(ev.end, '2026-03-29T01:30:00.000Z');

    const initialDurationMs = new Date(ev.end).getTime() - new Date(ev.start).getTime();
    assert.strictEqual(initialDurationMs, 3600000, 'Original parsed duration must be 60 minutes');

    // Zero-edit save
    const savedIcs = eventToICS(ev, springIcs);
    const reParsed = parseICSToEvent(savedIcs);

    assert.ok(reParsed, 'Saved event should be parsed');
    assert.strictEqual(reParsed.start, ev.start, 'Start timestamp must not drift on zero-edit save');
    assert.strictEqual(reParsed.end, ev.end, 'End timestamp must not collapse or stretch on zero-edit save');

    const savedDurationMs = new Date(reParsed.end).getTime() - new Date(reParsed.start).getTime();
    assert.strictEqual(savedDurationMs, initialDurationMs, 'Event duration must be preserved across zero-edit save');

    assert.strictEqual(isNoOpEventSave(springIcs, ev), true, 'isNoOpEventSave should return true');
  });

  await t.test('Fall DST transition event duration and dates are preserved across zero-edit save', () => {
    // Fall DST changeover in Europe/Berlin: 2026-10-25 03:00 CEST (+2) -> 02:00 CET (+1)
    // DTSTART: 00:00 CEST (2026-10-24T22:00:00.000Z)
    // DTEND: 05:00 CET (2026-10-25T04:00:00.000Z)
    // Real duration: 6 hours (21600000 ms)
    const fallIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue292-fall-span',
      'SUMMARY:Fall DST Shift',
      'DTSTART;TZID=Europe/Berlin:20261025T000000',
      'DTEND;TZID=Europe/Berlin:20261025T050000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(fallIcs);
    assert.ok(ev, 'Event should be parsed');
    assert.strictEqual(ev.start, '2026-10-24T22:00:00.000Z');
    assert.strictEqual(ev.end, '2026-10-25T04:00:00.000Z');

    const initialDurationMs = new Date(ev.end).getTime() - new Date(ev.start).getTime();
    assert.strictEqual(initialDurationMs, 21600000, 'Original parsed duration must be 6 hours');

    const savedIcs = eventToICS(ev, fallIcs);
    const reParsed = parseICSToEvent(savedIcs);

    assert.strictEqual(reParsed.start, ev.start, 'Start timestamp must not drift on zero-edit save');
    assert.strictEqual(reParsed.end, ev.end, 'End timestamp must not stretch or compress on zero-edit save');

    const savedDurationMs = new Date(reParsed.end).getTime() - new Date(reParsed.start).getTime();
    assert.strictEqual(savedDurationMs, initialDurationMs, 'Event duration must be preserved across zero-edit save');
  });

  await t.test('Multiple consecutive saves do not drift or alter duration', () => {
    const springIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'UID:issue292-multi-save',
      'SUMMARY:Multi Save DST Test',
      'DTSTART;TZID=Europe/Berlin:20260329T013000',
      'DTEND;TZID=Europe/Berlin:20260329T033000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    let currentIcs = springIcs;
    const initialEv = parseICSToEvent(springIcs);

    for (let i = 1; i <= 5; i++) {
      const ev = parseICSToEvent(currentIcs);
      assert.strictEqual(ev.start, initialEv.start, `Iteration ${i}: start timestamp changed`);
      assert.strictEqual(ev.end, initialEv.end, `Iteration ${i}: end timestamp changed`);
      currentIcs = eventToICS(ev, currentIcs);
    }
  });
});
