'use strict';

/**
 * Issue #203 — VTIMEZONE Registration, Timezone Drift Prevention & Warning Log Channel
 *
 * Requirements:
 *  1. parseICSToEvent and parseAndExpandEvent must register all embedded VTIMEZONE
 *     components from incoming ICS strings into ICAL.TimezoneService.
 *  2. buildVTimezoneBlock(tzid) must validate IANA timezones using Intl.DateTimeFormat.
 *     If an invalid or unsupported timezone is provided, it must log a warning and return null
 *     rather than generating a corrupt 0-offset VTIMEZONE block.
 *  3. eventToICS with an invalid timezone must handle the invalid timezone gracefully without
 *     emitting a spurious 0-offset VTIMEZONE component.
 *  4. Event parsing and re-serialization roundtrip of TZID-qualified events must maintain
 *     exact UTC instants without cumulative timezone drift.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');

const {
  eventToICS,
  parseICSToEvent,
  parseAndExpandEvent,
  buildVTimezoneBlock,
  isValidTimezone
} = require('../utils/ical');

test('Issue #203 — VTIMEZONE Registration & Timezone Drift Error Channel', async (t) => {

  await t.test('isValidTimezone correctly validates IANA timezones', () => {
    assert.equal(isValidTimezone('Europe/Berlin'), true, 'Europe/Berlin is valid');
    assert.equal(isValidTimezone('America/New_York'), true, 'America/New_York is valid');
    assert.equal(isValidTimezone('Asia/Tokyo'), true, 'Asia/Tokyo is valid');
    assert.equal(isValidTimezone('UTC'), true, 'UTC is valid');

    assert.equal(isValidTimezone('Invalid/Timezone_XYZ'), false, 'Invalid timezone must return false');
    assert.equal(isValidTimezone(''), false, 'Empty string must return false');
    assert.equal(isValidTimezone(null), false, 'Null must return false');
  });

  await t.test('buildVTimezoneBlock logs warning and returns null for invalid IANA timezones', () => {
    let warningLogged = false;
    const origWarn = console.warn;
    console.warn = (...args) => {
      if (args.some(a => String(a).includes('[timezone]'))) warningLogged = true;
      origWarn(...args);
    };

    try {
      const block = buildVTimezoneBlock('Invalid/Timezone_XYZ');
      assert.equal(block, null, 'buildVTimezoneBlock must not fabricate a 0-offset block for an invalid timezone');
      assert.ok(warningLogged, 'Must log warning when buildVTimezoneBlock receives invalid timezone');
    } finally {
      console.warn = origWarn;
    }
  });

  await t.test('eventToICS update path (existing ICS) neither embeds nor registers a VTIMEZONE for an invalid TZID', () => {
    const tzid = 'Invalid/Update_Path_203';
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:update-path-203',
      'DTSTAMP:20260101T000000Z',
      'SUMMARY:Existing Event',
      'DTSTART:20260601T100000Z',
      'DTEND:20260601T110000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    const incoming = {
      uid: 'update-path-203',
      title: 'Existing Event',
      start: '2026-06-01T10:00:00.000Z',
      end: '2026-06-01T11:00:00.000Z',
      allDay: false,
      startTimeZone: tzid,
      endTimeZone: tzid
    };

    assert.ok(!ICAL.TimezoneService.has(tzid), 'TZID must not be pre-registered');
    const ics = eventToICS(incoming, existingIcs);

    // Prove the update path was taken (fresh-build path uses the Freeshard PRODID).
    assert.ok(ics.includes('PRODID:-//Test//EN'), 'Must take the existing-ICS update path');
    assert.ok(!ics.includes('BEGIN:VTIMEZONE'), 'Must NOT embed a VTIMEZONE for an invalid TZID');
    assert.ok(!ics.includes(tzid), 'Invalid TZID must not appear anywhere in the stored ICS');
    assert.ok(!ICAL.TimezoneService.has(tzid), 'Invalid TZID must not be registered process-wide');

    // A later read of an ICS carrying that TZID must not launder it into the event model.
    const parsed = parseICSToEvent([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
      'BEGIN:VEVENT', 'UID:launder-203', 'SUMMARY:Later',
      `DTSTART;TZID=${tzid}:20260601T100000`,
      `DTEND;TZID=${tzid}:20260601T110000`,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n'));
    assert.notEqual(parsed.startTimeZone, tzid, 'Bogus TZID must not be laundered into startTimeZone');

    // Valid zones on the update path are still embedded and correct.
    const ok = eventToICS({ ...incoming, startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin' }, existingIcs);
    assert.ok(ok.includes('TZID:Europe/Berlin'), 'Valid TZID must still get a VTIMEZONE on the update path');
    assert.equal(parseICSToEvent(ok).start, '2026-06-01T10:00:00.000Z');
  });

  await t.test('parseICSToEvent registers embedded VTIMEZONE into ICAL.TimezoneService', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Custom/Test_Zone_203',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0200',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:embed-vtz-test-203',
      'SUMMARY:Embedded VTZ Test',
      'DTSTART;TZID=Custom/Test_Zone_203:20260601T100000',
      'DTEND;TZID=Custom/Test_Zone_203:20260601T110000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    assert.ok(!ICAL.TimezoneService.has('Custom/Test_Zone_203'), 'TZID should not be pre-registered');

    const event = parseICSToEvent(ics);
    assert.ok(event, 'Event must be parsed');
    assert.ok(ICAL.TimezoneService.has('Custom/Test_Zone_203'),
      'parseICSToEvent must register embedded VTIMEZONE into ICAL.TimezoneService');

    // 10:00 at +0200 offset = 08:00:00Z
    assert.equal(event.start, '2026-06-01T08:00:00.000Z',
      'Start time must resolve against embedded VTIMEZONE offset without drift');
  });

  await t.test('parseAndExpandEvent registers embedded VTIMEZONE before expanding recurrences', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Custom/Expand_Zone_203',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:expand-vtz-test-203',
      'SUMMARY:Recurring VTZ Test',
      'RRULE:FREQ=DAILY;COUNT=2',
      'DTSTART;TZID=Custom/Expand_Zone_203:20260601T090000',
      'DTEND;TZID=Custom/Expand_Zone_203:20260601T100000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const instances = parseAndExpandEvent(ics, '2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z');
    assert.ok(ICAL.TimezoneService.has('Custom/Expand_Zone_203'),
      'parseAndExpandEvent must register embedded VTIMEZONE into ICAL.TimezoneService');
    assert.equal(instances.length, 2, 'Must expand 2 occurrences');
    // 09:00 at +0100 = 08:00Z
    assert.equal(instances[0].start, '2026-06-01T08:00:00.000Z');
  });

  await t.test('eventToICS with invalid timezone omits VTIMEZONE block and logs warning', () => {
    let warningLogged = false;
    const origWarn = console.warn;
    console.warn = (...args) => {
      if (args.some(a => String(a).includes('[timezone]'))) warningLogged = true;
      origWarn(...args);
    };

    try {
      const event = {
        uid: 'invalid-tz-test-203',
        title: 'Invalid TZ Event',
        start: '2026-06-01T10:00:00.000Z',
        end: '2026-06-01T11:00:00.000Z',
        allDay: false,
        startTimeZone: 'Invalid/Timezone_XYZ'
      };

      const ics = eventToICS(event);
      assert.ok(!ics.includes('BEGIN:VTIMEZONE'), 'Must NOT emit VTIMEZONE block for invalid timezone');
      assert.ok(!ics.includes('TZID=Invalid/Timezone_XYZ'), 'Must NOT emit invalid TZID parameter');
      assert.ok(warningLogged, 'Must log timezone warning');
    } finally {
      console.warn = origWarn;
    }
  });

  await t.test('roundtrip serialization of TZID event maintains exact UTC instant without drift', () => {
    const initialEvent = {
      uid: 'roundtrip-tz-203',
      title: 'Roundtrip Test',
      start: '2026-03-15T08:00:00.000Z', // 09:00 CET
      end: '2026-03-15T09:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'Europe/Berlin'
    };

    // 1st serialization
    const ics1 = eventToICS(initialEvent);
    // Parse back
    const parsed1 = parseICSToEvent(ics1);
    assert.equal(parsed1.start, '2026-03-15T08:00:00.000Z', '1st parse start must match');

    // 2nd serialization
    const ics2 = eventToICS(parsed1, ics1);
    // Parse back
    const parsed2 = parseICSToEvent(ics2);
    assert.equal(parsed2.start, '2026-03-15T08:00:00.000Z', '2nd parse start must match — 0 cumulative drift');
  });
});
