'use strict';

/**
 * Issue #253 — MEDIUM: On a changeover day the stored DTEND can collapse onto DTSTART, producing a zero-length event
 *
 * Requirements:
 *  1. When an event occurs during a fall-back DST transition (e.g. Europe/Berlin on 2026-10-25)
 *     where start is 02:30 CEST (00:30 UTC) and end is 02:30 CET (01:30 UTC), naive local wall-clock
 *     formatting for DTSTART and DTEND would produce identical strings ("20261025T023000").
 *  2. eventToICS must detect when a TZID local time string is lossy/ambiguous due to the fall-back hour
 *     or when DTEND <= DTSTART in local wall-clock representation, and fall back to UTC formatting
 *     ("DTSTART:20261025T003000Z" or "DTEND:20261025T013000Z") to prevent DTEND from collapsing onto DTSTART.
 *  3. Round-trip parsing parseICSToEvent(eventToICS(event)) must yield non-zero duration (end > start)
 *     matching the original 1-hour interval.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventToICS, parseICSToEvent, isTzidLossy } = require('../utils/ical');

test('Issue #253 — Prevent DTEND collapse onto DTSTART on DST fall-back changeover day', async (t) => {

  await t.test('isTzidLossy accurately detects ambiguous wall-clock times in fall-back transition window', () => {
    // 00:30 UTC on 2026-10-25 is 02:30 CEST (first 02:30). Wall-clock "02:30" parses back to 01:30 UTC. Lossy!
    assert.equal(isTzidLossy('2026-10-25T00:30:00.000Z', 'Europe/Berlin'), true, '02:30 CEST is lossy');

    // 01:30 UTC on 2026-10-25 is 02:30 CET (second 02:30). Ambiguous local time -> lossy! (Corrected by Issue #294)
    assert.equal(isTzidLossy('2026-10-25T01:30:00.000Z', 'Europe/Berlin'), true, '02:30 CET is lossy');

    // Normal non-transition date is not lossy
    assert.equal(isTzidLossy('2026-06-15T08:00:00.000Z', 'Europe/Berlin'), false, 'Normal summer date is not lossy');
  });

  await t.test('eventToICS uses UTC formatting for ambiguous start/end to prevent collapse on fall-back changeover', () => {
    // 2026-10-25 Europe/Berlin fall transition:
    // 02:30 CEST (UTC+2) = 2026-10-25T00:30:00.000Z
    // 02:30 CET  (UTC+1) = 2026-10-25T01:30:00.000Z (1 hour duration)
    const event = {
      uid: 'dst-fallback-collapse-test-253',
      title: 'DST Fallback Meeting',
      start: '2026-10-25T00:30:00.000Z',
      end:   '2026-10-25T01:30:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };

    const ics = eventToICS(event);

    // DTSTART must use UTC formatting to prevent 00:30 UTC from shifting to 01:30 UTC
    assert.ok(ics.includes('DTSTART:20261025T003000Z'), `ICS must format start in UTC when TZID is lossy, got:\n${ics}`);
    assert.ok(!ics.includes('DTSTART;TZID=Europe/Berlin:20261025T023000\nDTEND;TZID=Europe/Berlin:20261025T023000'), 'DTSTART and DTEND must not collapse to identical local strings');
  });

  await t.test('roundtrip parseICSToEvent preserves 1-hour duration without zero-length collapse', () => {
    const event = {
      uid: 'dst-fallback-roundtrip-test-253',
      title: 'DST Fallback Roundtrip',
      start: '2026-10-25T00:30:00.000Z',
      end:   '2026-10-25T01:30:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };

    const ics = eventToICS(event);
    const parsed = parseICSToEvent(ics);

    assert.ok(parsed, 'parsed event must not be null');
    assert.equal(parsed.start, '2026-10-25T00:30:00.000Z', 'parsed start instant must match 00:30 UTC');
    assert.equal(parsed.end, '2026-10-25T01:30:00.000Z', 'parsed end instant must match 01:30 UTC');

    const durationMs = new Date(parsed.end).getTime() - new Date(parsed.start).getTime();
    assert.equal(durationMs, 3600000, 'event duration must be exactly 1 hour (3600000 ms), not 0 ms zero-length');
  });

});
