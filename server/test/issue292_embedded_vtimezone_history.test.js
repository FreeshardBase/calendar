'use strict';

/**
 * Issue #292: ical.js resolves TZIDs through one process-wide registry where the
 * first registration wins. Calendars exported by other clients often embed a
 * VTIMEZONE that carries only the current rule. For an IANA TZID that lossy
 * block must not become the zone's definition, or every historical event in
 * that zone (from any calendar) is read with today's rule. Runs in its own
 * process so the registry starts empty.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent } = require('../utils/ical');

test('Issue #292 — an embedded current-rule-only VTIMEZONE does not override tzdata for an IANA TZID', () => {
  const imported = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//EN',
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:issue292-embedded@example.com',
    'SUMMARY:Test User handover',
    'DTSTART;TZID=America/New_York:20050403T010000',
    'DTEND;TZID=America/New_York:20050403T050000',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const ev = parseICSToEvent(imported);
  assert.equal(ev.start, '2005-04-03T06:00:00.000Z');
  assert.equal(ev.end, '2005-04-03T09:00:00.000Z');
  assert.equal((new Date(ev.end) - new Date(ev.start)) / 3600000, 3);
});
