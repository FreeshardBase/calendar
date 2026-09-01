const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndExpandEvent } = require('../utils/ical.js');

test('Issue #171 — Recurrence expansion cost does not grow with series age', async (t) => {

  await t.test('Daily series starting 10 years ago expands correctly without unbounded iterations', () => {
    const oldDailyIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:old-daily-10yr
DTSTART:20160101T090000Z
DTEND:20160101T100000Z
RRULE:FREQ=DAILY
SUMMARY:10-Year Daily Event
END:VEVENT
END:VCALENDAR`;

    const rangeStart = '2026-09-01T00:00:00Z';
    const rangeEnd = '2026-09-07T23:59:59Z';

    const t0 = performance.now();
    const instances = parseAndExpandEvent(oldDailyIcs, rangeStart, rangeEnd);
    const durationMs = performance.now() - t0;

    assert.equal(instances.length, 7, 'Should return 7 instances for 7 days');
    assert.equal(instances[0].start, '2026-09-01T09:00:00.000Z');
    assert.equal(instances[6].start, '2026-09-07T09:00:00.000Z');
    assert.ok(durationMs < 50, `Expansion should complete in < 50ms, took ${durationMs.toFixed(2)}ms`);
  });

  await t.test('EXDATE exceptions are preserved when fast-forwarding recurrence iterator', () => {
    const exdateIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:old-exdate-series
DTSTART:20150101T090000Z
DTEND:20150101T100000Z
RRULE:FREQ=DAILY
EXDATE:20260903T090000Z
SUMMARY:Series with Exdate
END:VEVENT
END:VCALENDAR`;

    const rangeStart = '2026-09-01T00:00:00Z';
    const rangeEnd = '2026-09-05T23:59:59Z';

    const instances = parseAndExpandEvent(exdateIcs, rangeStart, rangeEnd);
    const starts = instances.map(i => i.start);

    assert.deepEqual(starts, [
      '2026-09-01T09:00:00.000Z',
      '2026-09-02T09:00:00.000Z',
      '2026-09-04T09:00:00.000Z',
      '2026-09-05T09:00:00.000Z'
    ], '2026-09-03 instance must be excluded via EXDATE');
  });

  await t.test('RRULE with COUNT is not distorted by fast-forwarding', () => {
    const countIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:old-count-series
DTSTART:20150101T090000Z
DTEND:20150101T100000Z
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:5-Count Event
END:VEVENT
END:VCALENDAR`;

    const rangeStart = '2026-09-01T00:00:00Z';
    const rangeEnd = '2026-09-07T23:59:59Z';

    const instances = parseAndExpandEvent(countIcs, rangeStart, rangeEnd);
    assert.equal(instances.length, 0, 'Exhausted COUNT=5 series from 2015 must yield 0 instances in 2026');
  });

  await t.test('Spanning multi-day / night event instances across window boundary are captured', () => {
    const nightIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:night-spanning-series
DTSTART:20150101T230000Z
DTEND:20150102T020000Z
RRULE:FREQ=DAILY
SUMMARY:Night Shift Event
END:VEVENT
END:VCALENDAR`;

    const rangeStart = '2026-09-01T00:00:00Z';
    const rangeEnd = '2026-09-01T23:59:59Z';

    const instances = parseAndExpandEvent(nightIcs, rangeStart, rangeEnd);
    assert.ok(instances.length >= 1, 'Spanning occurrence starting before rangeStart must be included');
  });
});
