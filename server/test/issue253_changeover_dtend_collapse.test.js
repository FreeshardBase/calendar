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
const { eventToICS, parseICSToEvent, isTzidLossy, getUtcDate } = require('../utils/ical');

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

  // The form path from the issue: the user types a time, the client resolves it
  // with getUtcDate, the server stores it and reads its own file back.
  function wallClock(iso, tz) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(iso));
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
  }

  const formCases = [
    // [zone, date, start, end] — changeover days and the issue's controls
    ['Europe/Berlin', '2026-10-25', '01:00', '02:00'],
    ['Europe/Berlin', '2026-11-01', '01:00', '02:00'],
    ['Europe/Berlin', '2026-10-25', '00:00', '01:00'],
    ['Europe/Berlin', '2026-03-29', '03:00', '04:00'],
    ['America/New_York', '2026-10-25', '03:00', '04:00'],
    ['America/New_York', '2026-11-01', '00:30', '01:00'],
    ['America/New_York', '2026-11-01', '03:00', '04:00'],
    ['Australia/Sydney', '2026-04-05', '01:00', '01:30'],
    ['Australia/Sydney', '2026-10-04', '03:00', '04:00'],
  ];

  for (const [tz, date, startTime, endTime] of formCases) {
    await t.test(`form entry ${date} ${startTime}-${endTime} ${tz} reads back with the entered instants and wall clock`, () => {
      const start = getUtcDate(date, startTime, tz).toISOString();
      const end = getUtcDate(date, endTime, tz).toISOString();
      const ics = eventToICS({
        uid: `form-${tz}-${date}-${startTime}@example.com`, title: 'Form entry',
        start, end, allDay: false, startTimeZone: tz, endTimeZone: tz
      });
      const parsed = parseICSToEvent(ics);

      assert.equal(parsed.start, start, `start instant drifted on read-back:\n${ics}`);
      assert.equal(parsed.end, end, `end instant drifted on read-back:\n${ics}`);
      assert.ok(new Date(parsed.end) > new Date(parsed.start), 'event must not be zero-length');
      assert.equal(parsed.startTimeZone, tz);
      assert.equal(parsed.endTimeZone, tz, 'end must be shown in the event zone, not browser-local time');
      assert.equal(wallClock(parsed.start, parsed.startTimeZone), `${date} ${startTime}`, 'reopened start field');
    });
  }

  await t.test('a genuine hour wholly before the Berlin fall-back (23:00Z-00:00Z) round-trips as one hour', () => {
    const event = {
      uid: 'dst-before-fallback-253@example.com', title: 'Before fall-back',
      start: '2026-10-24T23:00:00.000Z', end: '2026-10-25T00:00:00.000Z',
      allDay: false, startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin'
    };
    const parsed = parseICSToEvent(eventToICS(event));
    assert.equal(parsed.start, event.start);
    assert.equal(parsed.end, event.end);
  });

});
