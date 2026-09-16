const test = require('node:test');
const assert = require('node:assert/strict');
const { eventToICS, parseICSToEvent, updateWholeSeries } = require('../utils/ical');

test('Issue #325 — updateWholeSeries malformed TZID...Z prevention', async (t) => {
  await t.test('should not write DTSTART/DTEND with both TZID parameter and trailing Z', () => {
    const initialIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:issue325-test-1',
      'DTSTART;TZID=Europe/Berlin:20260610T100000',
      'DTEND;TZID=Europe/Berlin:20260610T110000',
      'SUMMARY:Original Title',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(initialIcs);
    const payloadWithNewTitle = {
      uid: ev.uid,
      title: 'Updated Title 1',
      start: ev.start,
      end: ev.end,
      startTimeZone: ev.startTimeZone,
      endTimeZone: ev.endTimeZone,
      allDay: ev.allDay
    };

    const out = updateWholeSeries(initialIcs, payloadWithNewTitle);

    assert.doesNotMatch(out, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/);
    assert.doesNotMatch(out, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/);
  });

  await t.test('should preserve exact parsed start time across 5 consecutive edits without cumulative timezone drift', () => {
    const initialIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:issue325-test-2',
      'DTSTART;TZID=Europe/Berlin:20260610T100000',
      'DTEND;TZID=Europe/Berlin:20260610T110000',
      'SUMMARY:Original Title',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    let currentIcs = initialIcs;
    const initialEv = parseICSToEvent(initialIcs);
    const initialStart = initialEv.start;

    for (let i = 1; i <= 5; i++) {
      const ev = parseICSToEvent(currentIcs);
      const payload = {
        uid: ev.uid,
        title: `Title Edit ${i}`,
        start: ev.start,
        end: ev.end,
        startTimeZone: ev.startTimeZone,
        endTimeZone: ev.endTimeZone,
        allDay: ev.allDay
      };
      currentIcs = updateWholeSeries(currentIcs, payload);

      assert.doesNotMatch(currentIcs, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/);
      assert.doesNotMatch(currentIcs, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/);

      const updatedEv = parseICSToEvent(currentIcs);
      assert.strictEqual(updatedEv.start, initialStart, `Start time drifted on edit ${i}`);
    }
  });

  await t.test('should clean malformed TZID...Z lines when eventToICS is called directly', () => {
    const rawIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:issue325-test-3',
      'DTSTART;TZID=Europe/Berlin:20260610T100000',
      'DTEND;TZID=Europe/Berlin:20260610T110000',
      'SUMMARY:Direct Edit',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(rawIcs);
    const out = eventToICS({
      uid: ev.uid,
      title: 'Direct Edit Title Changed',
      start: ev.start,
      end: ev.end,
      startTimeZone: ev.startTimeZone,
      endTimeZone: ev.endTimeZone
    }, rawIcs);

    assert.doesNotMatch(out, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/);
    assert.doesNotMatch(out, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/);
  });
});
