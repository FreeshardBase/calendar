'use strict';

/**
 * Issue #294 — HIGH (corrects the stated mechanism of #253):
 * The ICS writer cannot represent an instant inside a fall-back repeated hour as a local TZID wall-clock time,
 * so two instants an hour apart would be stored as identical bytes.
 *
 * Requirements:
 * 1. isTzidLossy must return true for ALL instants inside a fall-back repeated hour (e.g. both 00:30 UTC
 *    and 01:30 UTC on 2026-10-25 in Europe/Berlin, which both format to local wall-clock "02:30:00").
 * 2. eventToICS must format both instants using UTC ("DTSTART:20261025T003000Z" and "DTSTART:20261025T013000Z")
 *    so that two events an hour apart in the fall-back transition window do NOT produce identical bytes.
 * 3. Round-trip parsing parseICSToEvent must preserve both distinct UTC start instants.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventToICS, parseICSToEvent, isTzidLossy } = require('../utils/ical');

test('Issue #294 — ICS writer represents fall-back repeated hour instants as distinct UTC bytes', async (t) => {

  await t.test('isTzidLossy detects both 00:30 UTC and 01:30 UTC as lossy in Europe/Berlin fall-back transition', () => {
    // 00:30 UTC on 2026-10-25 is 02:30 CEST (first 02:30). Ambiguous local time -> lossy!
    assert.equal(isTzidLossy('2026-10-25T00:30:00.000Z', 'Europe/Berlin'), true, '00:30 UTC (02:30 CEST) must be lossy');

    // 01:30 UTC on 2026-10-25 is 02:30 CET (second 02:30). Ambiguous local time -> lossy!
    assert.equal(isTzidLossy('2026-10-25T01:30:00.000Z', 'Europe/Berlin'), true, '01:30 UTC (02:30 CET) must be lossy');

    // Normal non-transition date is not lossy
    assert.equal(isTzidLossy('2026-06-15T08:00:00.000Z', 'Europe/Berlin'), false, 'Normal summer date is not lossy');
  });

  await t.test('eventToICS formats two events an hour apart in fall-back repeated hour as distinct UTC bytes', () => {
    const event1 = {
      uid: 'issue294-event-1',
      title: 'First 02:30 Meeting',
      start: '2026-10-25T00:30:00.000Z',
      end:   '2026-10-25T01:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };

    const event2 = {
      uid: 'issue294-event-2',
      title: 'Second 02:30 Meeting',
      start: '2026-10-25T01:30:00.000Z',
      end:   '2026-10-25T02:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };

    const ics1 = eventToICS(event1);
    const ics2 = eventToICS(event2);

    assert.ok(ics1.includes('DTSTART:20261025T003000Z'), `Event 1 must format start in UTC, got:\n${ics1}`);
    assert.ok(ics2.includes('DTSTART:20261025T013000Z'), `Event 2 must format start in UTC, got:\n${ics2}`);

    const veventStart1 = ics1.split('BEGIN:VEVENT')[1].match(/DTSTART[:;].*/)[0];
    const veventStart2 = ics2.split('BEGIN:VEVENT')[1].match(/DTSTART[:;].*/)[0];

    assert.notEqual(
      veventStart1,
      veventStart2,
      'Two events an hour apart in fall-back repeated hour must not produce identical VEVENT DTSTART lines'
    );
  });

  await t.test('round-trip parseICSToEvent preserves both distinct UTC timestamps', () => {
    const event1 = {
      uid: 'issue294-rt-1',
      title: 'Event 1 RT',
      start: '2026-10-25T00:30:00.000Z',
      end:   '2026-10-25T01:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin'
    };

    const event2 = {
      uid: 'issue294-rt-2',
      title: 'Event 2 RT',
      start: '2026-10-25T01:30:00.000Z',
      end:   '2026-10-25T02:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin'
    };

    const parsed1 = parseICSToEvent(eventToICS(event1));
    const parsed2 = parseICSToEvent(eventToICS(event2));

    assert.equal(parsed1.start, '2026-10-25T00:30:00.000Z');
    assert.equal(parsed2.start, '2026-10-25T01:30:00.000Z');
    assert.notEqual(parsed1.start, parsed2.start);
  });

});
