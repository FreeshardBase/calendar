'use strict';

/**
 * Issue #221 — Daylight-Saving Changeover Event Saving Accuracy
 *
 * Requirements:
 *  1. getUtcDate(dateStr, timeStr, timeZone) must accurately compute the UTC Date
 *     object for local date/time inputs on daylight-saving transition days (spring/fall)
 *     when the time falls inside or near the offset transition window.
 *  2. On spring transition in Europe/Berlin (e.g. 2026-03-29), 01:30 CET (before 02:00 changeover, +1h offset)
 *     must map to 2026-03-29T00:30:00.000Z, NOT 2026-03-28T23:30:00.000Z (which was 1h off).
 *  3. On spring transition in Europe/Berlin, 03:30 CEST (after 02:00 changeover, +2h offset)
 *     must map to 2026-03-29T01:30:00.000Z.
 *  4. eventToICS must serialize an event scheduled at 01:30 CET on 2026-03-29 as
 *     DTSTART;TZID=Europe/Berlin:20260329T013000 without 1-hour time shifts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getUtcDate, eventToICS, parseICSToEvent } = require('../utils/ical');

test('Issue #221 — Daylight-Saving Changeover Event Save Accuracy', async (t) => {

  await t.test('getUtcDate computes accurate UTC Date on spring DST transition day', () => {
    // Europe/Berlin spring transition: 2026-03-29
    // 01:30 CET is before transition (offset +1). UTC should be 00:30.
    const preTransitionUtc = getUtcDate('2026-03-29', '01:30', 'Europe/Berlin');
    assert.equal(
      preTransitionUtc.toISOString(),
      '2026-03-29T00:30:00.000Z',
      '01:30 CET on 2026-03-29 must map to 00:30:00.000Z'
    );

    // 03:30 CEST is after transition (offset +2). UTC should be 01:30.
    const postTransitionUtc = getUtcDate('2026-03-29', '03:30', 'Europe/Berlin');
    assert.equal(
      postTransitionUtc.toISOString(),
      '2026-03-29T01:30:00.000Z',
      '03:30 CEST on 2026-03-29 must map to 01:30:00.000Z'
    );
  });

  await t.test('getUtcDate handles normal non-transition days accurately', () => {
    const utcDate = getUtcDate('2026-06-15', '10:00', 'Europe/Berlin');
    // Europe/Berlin in June is CEST (offset +2). UTC should be 08:00.
    assert.equal(
      utcDate.toISOString(),
      '2026-06-15T08:00:00.000Z',
      '10:00 CEST on June 15 must map to 08:00:00.000Z'
    );
  });

  await t.test('eventToICS serializes DST changeover event without 1-hour time shift', () => {
    const startUtc = getUtcDate('2026-03-29', '01:30', 'Europe/Berlin').toISOString();
    const endUtc   = getUtcDate('2026-03-29', '02:00', 'Europe/Berlin').toISOString();

    const event = {
      title: 'DST Changeover Sync',
      start: startUtc,
      end: endUtc,
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'Europe/Berlin',
      allDay: false
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('DTSTART;TZID=Europe/Berlin:20260329T013000'), `ICS must contain DTSTART 01:30 local time, got:\n${ics}`);
  });

  await t.test('roundtrip parseICSToEvent preserves start time and tzid across DST changeover', () => {
    const startUtc = getUtcDate('2026-03-29', '01:30', 'Europe/Berlin').toISOString();
    const event = {
      title: 'DST Changeover Roundtrip',
      start: startUtc,
      end: startUtc,
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'Europe/Berlin',
      allDay: false
    };

    const ics = eventToICS(event);
    const parsed = parseICSToEvent(ics);
    assert.equal(parsed.start, '2026-03-29T00:30:00.000Z');
    assert.equal(parsed.startTimeZone, 'Europe/Berlin');
  });

});
