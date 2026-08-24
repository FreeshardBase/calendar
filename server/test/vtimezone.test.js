'use strict';

/**
 * Issue #52 — VTIMEZONE Registration & Cumulative Timezone Drift Fix
 *
 * Requirements:
 *  1. eventToICS must embed a VTIMEZONE component whenever startTimeZone or
 *     endTimeZone is set (a TZID without a matching VTIMEZONE block causes
 *     ical.js to fall back to UTC, producing cumulative drift).
 *  2. buildVTimezoneBlock(tzid) must return a standards-compliant
 *     BEGIN:VTIMEZONE…END:VTIMEZONE string.
 *  3. Parse-roundtrip of a TZID-qualified event must recover the exact local
 *     wall-clock time — no UTC drift.
 *  4. UTC-only (floating / Z-suffixed) events must be unaffected and must NOT
 *     gain a spurious VTIMEZONE block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');

const {
  eventToICS,
  parseICSToEvent,
  buildVTimezoneBlock
} = require('../utils/ical');

// ── helpers ───────────────────────────────────────────────────────────────────

function parseIcs(icsStr) {
  const comp = new ICAL.Component(ICAL.parse(icsStr));
  return comp;
}

// ── test suite ────────────────────────────────────────────────────────────────

test('Issue #52 — VTIMEZONE Registration & Cumulative Timezone Drift Fix', async (t) => {

  // ── 1. buildVTimezoneBlock ──────────────────────────────────────────────────

  await t.test('buildVTimezoneBlock is exported from ical.js', () => {
    assert.equal(typeof buildVTimezoneBlock, 'function',
      'buildVTimezoneBlock must be exported from server/utils/ical.js');
  });

  await t.test('buildVTimezoneBlock returns a string with correct structure', () => {
    const block = buildVTimezoneBlock('Europe/Berlin');
    assert.equal(typeof block, 'string');
    assert.ok(block.includes('BEGIN:VTIMEZONE'), 'must open VTIMEZONE');
    assert.ok(block.includes('END:VTIMEZONE'),   'must close VTIMEZONE');
    assert.ok(block.includes('TZID:Europe/Berlin'), 'must embed the TZID');
  });

  await t.test('buildVTimezoneBlock returns a parseable VTIMEZONE via ical.js', () => {
    const block = buildVTimezoneBlock('America/New_York');
    // Wrap it in a VCALENDAR so ical.js can parse it stand-alone
    const wrapper = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block}\r\nEND:VCALENDAR\r\n`;
    const comp = parseIcs(wrapper);
    const vtimezone = comp.getFirstSubcomponent('vtimezone');
    assert.ok(vtimezone, 'ical.js must find a vtimezone subcomponent');
    const tzid = vtimezone.getFirstPropertyValue('tzid');
    assert.equal(String(tzid), 'America/New_York');
  });

  await t.test('buildVTimezoneBlock includes at least one STANDARD or DAYLIGHT sub-component', () => {
    const block = buildVTimezoneBlock('Europe/Berlin');
    const hasStandard = block.includes('BEGIN:STANDARD');
    const hasDaylight = block.includes('BEGIN:DAYLIGHT');
    assert.ok(hasStandard || hasDaylight,
      'VTIMEZONE must contain at least one STANDARD or DAYLIGHT sub-component');
  });

  // ── 2. eventToICS VTIMEZONE embedding ──────────────────────────────────────

  await t.test('eventToICS embeds VTIMEZONE block when startTimeZone is set', () => {
    const event = {
      uid: 'tz-embed-test-001',
      title: 'Berlin Meeting',
      start: '2026-03-15T09:00:00.000Z',
      end:   '2026-03-15T10:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };
    const ics = eventToICS(event);
    assert.ok(ics.includes('BEGIN:VTIMEZONE'),
      'eventToICS must include BEGIN:VTIMEZONE when startTimeZone is set');
    assert.ok(ics.includes('TZID:Europe/Berlin'),
      'VTIMEZONE block must specify TZID:Europe/Berlin');
    assert.ok(ics.includes('END:VTIMEZONE'),
      'VTIMEZONE block must be properly closed');
  });

  await t.test('eventToICS places VTIMEZONE before the VEVENT block', () => {
    const event = {
      uid: 'tz-order-test-002',
      title: 'Order Test',
      start: '2026-06-01T14:00:00.000Z',
      end:   '2026-06-01T15:00:00.000Z',
      allDay: false,
      startTimeZone: 'America/New_York',
      endTimeZone:   'America/New_York'
    };
    const ics = eventToICS(event);
    const vtimezonePos = ics.indexOf('BEGIN:VTIMEZONE');
    const veventPos    = ics.indexOf('BEGIN:VEVENT');
    assert.ok(vtimezonePos < veventPos,
      'VTIMEZONE block must appear before VEVENT in the ICS output');
  });

  await t.test('eventToICS with different start and end timezones embeds both VTIMEZONE blocks', () => {
    const event = {
      uid: 'tz-dual-test-003',
      title: 'Cross-TZ Event',
      start: '2026-06-01T06:00:00.000Z',
      end:   '2026-06-01T14:00:00.000Z',
      allDay: false,
      startTimeZone: 'America/Los_Angeles',
      endTimeZone:   'Europe/London'
    };
    const ics = eventToICS(event);
    assert.ok(ics.includes('TZID:America/Los_Angeles'), 'must contain LA VTIMEZONE');
    assert.ok(ics.includes('TZID:Europe/London'),       'must contain London VTIMEZONE');
  });

  await t.test('eventToICS with no timezone set does NOT add VTIMEZONE', () => {
    const event = {
      uid: 'utc-only-test-004',
      title: 'UTC Event',
      start: '2026-01-01T10:00:00.000Z',
      end:   '2026-01-01T11:00:00.000Z',
      allDay: false
      // No startTimeZone / endTimeZone
    };
    const ics = eventToICS(event);
    assert.ok(!ics.includes('BEGIN:VTIMEZONE'),
      'UTC-only events must NOT have a spurious VTIMEZONE block');
  });

  await t.test('eventToICS with allDay event does NOT add VTIMEZONE', () => {
    const event = {
      uid: 'allday-test-005',
      title: 'All Day',
      start: '2026-05-10T00:00:00.000Z',
      end:   '2026-05-11T00:00:00.000Z',
      allDay: true
    };
    const ics = eventToICS(event);
    assert.ok(!ics.includes('BEGIN:VTIMEZONE'),
      'All-day events must NOT have a spurious VTIMEZONE block');
  });

  // ── 3. Parse-roundtrip timezone drift regression ────────────────────────────

  await t.test('parse-roundtrip: TZID event round-trips without UTC drift', () => {
    // 09:00 Europe/Berlin on 2026-03-15 = 08:00 UTC (CET, UTC+1)
    const event = {
      uid: 'drift-rt-test-006',
      title: 'Drift Test',
      start: '2026-03-15T08:00:00.000Z',  // 09:00 CET stored as UTC
      end:   '2026-03-15T09:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };
    const ics = eventToICS(event);

    // Re-parse the ICS we just produced
    const comp = parseIcs(ics);
    const vevent = comp.getFirstSubcomponent('vevent');
    assert.ok(vevent, 'parsed ICS must contain a VEVENT');

    const dtstart = vevent.getFirstPropertyValue('dtstart');
    assert.ok(dtstart, 'DTSTART must be present');

    // Convert back to UTC — must match original instant
    const roundTrippedUtc = dtstart.toJSDate().toISOString();
    assert.equal(roundTrippedUtc, '2026-03-15T08:00:00.000Z',
      'Round-tripped UTC instant must match original — no drift allowed');
  });

  await t.test('parse-roundtrip: summer time (MESZ/CEST) round-trips without drift', () => {
    // 10:00 Europe/Berlin on 2026-07-20 = 08:00 UTC (CEST, UTC+2)
    const event = {
      uid: 'summer-drift-test-007',
      title: 'Summer Event',
      start: '2026-07-20T08:00:00.000Z',  // 10:00 CEST
      end:   '2026-07-20T09:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone:   'Europe/Berlin'
    };
    const ics = eventToICS(event);

    const comp = parseIcs(ics);
    const vevent = comp.getFirstSubcomponent('vevent');
    const dtstart = vevent.getFirstPropertyValue('dtstart');
    const roundTrippedUtc = dtstart.toJSDate().toISOString();
    assert.equal(roundTrippedUtc, '2026-07-20T08:00:00.000Z',
      'Summer CEST round-trip must preserve UTC instant — no DST drift');
  });

  await t.test('parse-roundtrip: America/New_York EST event round-trips without drift', () => {
    // 09:00 America/New_York on 2026-01-10 = 14:00 UTC (EST, UTC-5)
    const event = {
      uid: 'nyc-drift-test-008',
      title: 'NYC Meeting',
      start: '2026-01-10T14:00:00.000Z',  // 09:00 EST
      end:   '2026-01-10T15:00:00.000Z',
      allDay: false,
      startTimeZone: 'America/New_York',
      endTimeZone:   'America/New_York'
    };
    const ics = eventToICS(event);
    const comp = parseIcs(ics);
    const vevent = comp.getFirstSubcomponent('vevent');
    const dtstart = vevent.getFirstPropertyValue('dtstart');
    const roundTrippedUtc = dtstart.toJSDate().toISOString();
    assert.equal(roundTrippedUtc, '2026-01-10T14:00:00.000Z',
      'America/New_York round-trip must preserve UTC instant — no drift');
  });

  // ── 4. VTIMEZONE deduplication ─────────────────────────────────────────────

  await t.test('eventToICS deduplicates VTIMEZONE when start and end timezone are identical', () => {
    const event = {
      uid: 'dedup-test-009',
      title: 'Dedup Test',
      start: '2026-09-01T10:00:00.000Z',
      end:   '2026-09-01T11:00:00.000Z',
      allDay: false,
      startTimeZone: 'Asia/Tokyo',
      endTimeZone:   'Asia/Tokyo'
    };
    const ics = eventToICS(event);
    // Count occurrences of BEGIN:VTIMEZONE
    const matches = ics.match(/BEGIN:VTIMEZONE/g) || [];
    assert.equal(matches.length, 1,
      'Identical start/end timezones must yield exactly one VTIMEZONE block');
  });

});
