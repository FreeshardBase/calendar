'use strict';

/**
 * Issue #292 (follow-up): the VTIMEZONE built for an IANA TZID must reflect the
 * zone's rule in the event's own year, not one probe year's rule projected over
 * all time. Each arm asserts the true instants (cross-checked against tzdata via
 * Intl) and the duration across five zero-edit saves; the non-spanning and
 * current-year arms are controls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS } = require('../utils/ical');

function ics(uid, tzid, start, end) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'SUMMARY:Test User shift',
    `DTSTART;TZID=${tzid}:${start}`,
    `DTEND;TZID=${tzid}:${end}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

const ARMS = [
  // Pre-2007 US rule: DST began on the first Sunday of April.
  { name: 'New York spring 2005', tzid: 'America/New_York', start: '20050403T010000', end: '20050403T050000',
    utcStart: '2005-04-03T06:00:00.000Z', utcEnd: '2005-04-03T09:00:00.000Z', hours: 3 },
  // Pre-2007 US rule: DST ended on the last Sunday of October.
  { name: 'New York autumn 2005', tzid: 'America/New_York', start: '20051030T000000', end: '20051030T050000',
    utcStart: '2005-10-30T04:00:00.000Z', utcEnd: '2005-10-30T10:00:00.000Z', hours: 6 },
  // Non-spanning control in the same zone and year (EDT, 2007 rule would also say EDT).
  { name: 'New York 2005 control', tzid: 'America/New_York', start: '20050710T010000', end: '20050710T040000',
    utcStart: '2005-07-10T05:00:00.000Z', utcEnd: '2005-07-10T08:00:00.000Z', hours: 3 },
  // 2005-03-13 is the second Sunday of March: no transition under the 2005 rule.
  { name: 'New York 13 Mar 2005 (2007-rule date, no transition)', tzid: 'America/New_York',
    start: '20050313T010000', end: '20050313T050000',
    utcStart: '2005-03-13T06:00:00.000Z', utcEnd: '2005-03-13T10:00:00.000Z', hours: 4 },
  // Current-rule control.
  { name: 'New York spring 2026', tzid: 'America/New_York', start: '20260308T010000', end: '20260308T050000',
    utcStart: '2026-03-08T06:00:00.000Z', utcEnd: '2026-03-08T09:00:00.000Z', hours: 3 },
  // Brazil abolished DST in 2019; 2018 still fell back on 2019-02-17 and sprang forward on 2018-11-04.
  { name: 'Sao Paulo spring 2018', tzid: 'America/Sao_Paulo', start: '20181103T230000', end: '20181104T040000',
    utcStart: '2018-11-04T02:00:00.000Z', utcEnd: '2018-11-04T06:00:00.000Z', hours: 4 },
  { name: 'Sao Paulo 2026 control', tzid: 'America/Sao_Paulo', start: '20261103T230000', end: '20261104T040000',
    utcStart: '2026-11-04T02:00:00.000Z', utcEnd: '2026-11-04T07:00:00.000Z', hours: 5 },
  // Half-hour transition.
  { name: 'Lord Howe spring 2026', tzid: 'Australia/Lord_Howe', start: '20261004T010000', end: '20261004T040000',
    utcStart: '2026-10-03T14:30:00.000Z', utcEnd: '2026-10-03T17:00:00.000Z', hours: 2.5 },
  // Berlin before 1996 fell back on the last Sunday of September.
  { name: 'Berlin autumn 1990', tzid: 'Europe/Berlin', start: '19900929T230000', end: '19900930T040000',
    utcStart: '1990-09-29T21:00:00.000Z', utcEnd: '1990-09-30T03:00:00.000Z', hours: 6 },
];

test('Issue #292 — TZID offsets follow the rule in force in the event\'s own year', async (t) => {
  for (const arm of ARMS) {
    await t.test(arm.name, () => {
      let current = ics(`issue292-history-${arm.start}@example.com`, arm.tzid, arm.start, arm.end);
      for (let save = 0; save <= 4; save++) {
        const ev = parseICSToEvent(current);
        assert.equal(ev.start, arm.utcStart, `save ${save}: start`);
        assert.equal(ev.end, arm.utcEnd, `save ${save}: end`);
        const hours = (new Date(ev.end) - new Date(ev.start)) / 3600000;
        assert.equal(hours, arm.hours, `save ${save}: duration`);
        current = eventToICS(ev, current);
      }
    });
  }
});

test('Issue #292 — fixtures agree with the platform tzdata', () => {
  // Guards the fixtures themselves: each expected UTC instant renders as the
  // fixture's wall clock in its zone.
  for (const arm of ARMS) {
    for (const [wall, utc] of [[arm.start, arm.utcStart], [arm.end, arm.utcEnd]]) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: arm.tzid, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(new Date(utc));
      const get = (type) => parts.find(p => p.type === type).value;
      const rendered = `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
      assert.equal(rendered, wall, `${arm.name}: ${utc} in ${arm.tzid}`);
    }
  }
});
