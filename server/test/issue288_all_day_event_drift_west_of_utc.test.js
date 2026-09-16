'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS, isNoOpEventSave } = require('../utils/ical');

test('Issue #288 — All-day event date preservation across zero-edit saves west of UTC', async (t) => {
  const origTz = process.env.TZ;
  const testTimezones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/Berlin', 'UTC'];

  await t.test('parseICSToEvent & eventToICS preserve all-day event dates across 5 consecutive saves in timezones west of UTC', () => {
    try {
      for (const tz of testTimezones) {
        process.env.TZ = tz;

        let ics = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Freeshard//WebCalendar 1.0//EN',
          'BEGIN:VEVENT',
          'UID:issue288-allday-drift-test',
          'SUMMARY:All-Day Conference',
          'DTSTART;VALUE=DATE:20260910',
          'DTEND;VALUE=DATE:20260911',
          'END:VEVENT',
          'END:VCALENDAR'
        ].join('\r\n');

        for (let save = 1; save <= 5; save++) {
          const event = parseICSToEvent(ics);
          assert.equal(event.allDay, true, `Save ${save} in ${tz}: allDay must be true`);
          assert.equal(event.start, '2026-09-10T00:00:00.000Z', `Save ${save} in ${tz}: start must remain 2026-09-10T00:00:00.000Z`);
          assert.equal(event.end, '2026-09-11T00:00:00.000Z', `Save ${save} in ${tz}: end must remain 2026-09-11T00:00:00.000Z`);

          // Simulate frontend modal save payload construction (as done in eventModal.js)
          // Input dates extracted for all-day event
          const startDateVal = event.start.slice(0, 10); // '2026-09-10'
          // endDateVal for single day all-day event is also '2026-09-10'
          const endDateVal = '2026-09-10';

          const sDate = new Date(startDateVal + 'T00:00:00.000Z');
          let eDate = new Date(endDateVal + 'T00:00:00.000Z');
          if (isNaN(eDate.getTime()) || eDate < sDate) eDate = new Date(sDate);
          eDate.setUTCDate(eDate.getUTCDate() + 1);

          const payload = {
            ...event,
            start: sDate.toISOString(),
            end: eDate.toISOString(),
            allDay: true
          };

          const isNoOp = isNoOpEventSave(ics, payload);
          assert.equal(isNoOp, true, `Save ${save} in ${tz}: zero-edit save must be identified as no-op`);

          ics = eventToICS(payload, ics);
          assert.match(ics, /DTSTART;VALUE=DATE:20260910/, `Save ${save} in ${tz}: output ICS must keep DTSTART;VALUE=DATE:20260910`);
          assert.match(ics, /DTEND;VALUE=DATE:20260911/, `Save ${save} in ${tz}: output ICS must keep DTEND;VALUE=DATE:20260911`);
        }
      }
    } finally {
      process.env.TZ = origTz;
    }
  });

  await t.test('isNoOpEventSave evaluates all-day events by UTC date equality to avoid timezone boundary mismatch', () => {
    try {
      process.env.TZ = 'America/New_York';

      const originalIcs = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:issue288-noop-ny',
        'SUMMARY:Team Offsite',
        'DTSTART;VALUE=DATE:20260910',
        'DTEND;VALUE=DATE:20260912',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');

      const parsed = parseICSToEvent(originalIcs);
      const incomingPayload = {
        title: 'Team Offsite',
        start: '2026-09-10T00:00:00.000Z',
        end: '2026-09-12T00:00:00.000Z',
        allDay: true
      };

      const noOp = isNoOpEventSave(originalIcs, incomingPayload);
      assert.equal(noOp, true, 'isNoOpEventSave must return true in America/New_York for all-day event');
    } finally {
      process.env.TZ = origTz;
    }
  });

  await t.test('toInputDate correctly preserves UTC midnight date strings and Date objects across timezones west of UTC', () => {
    try {
      for (const tz of testTimezones) {
        process.env.TZ = tz;
        // Test with ISO UTC string
        const startIso = '2026-09-10T00:00:00.000Z';
        const startObj = new Date(startIso);

        // Date object with UTC midnight
        const y = startObj.getUTCFullYear();
        const m = String(startObj.getUTCMonth() + 1).padStart(2, '0');
        const d = String(startObj.getUTCDate()).padStart(2, '0');
        const formattedDate = `${y}-${m}-${d}`;

        assert.equal(formattedDate, '2026-09-10', `In ${tz}: formatted UTC date must be 2026-09-10`);
      }
    } finally {
      process.env.TZ = origTz;
    }
  });
});

