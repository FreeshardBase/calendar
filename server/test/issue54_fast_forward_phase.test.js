const test = require('node:test');
const assert = require('node:assert');
const { parseAndExpandEvent } = require('../utils/ical');

test('Issue #54 fast-forward preserves recurrence phase', async (t) => {
  // We simulate the table from the reviewer:
  // Query range August 2026: 2026-08-01 to 2026-09-01
  const startObj = new Date('2026-08-01T00:00:00Z');
  const endObj = new Date('2026-09-01T00:00:00Z');

  await t.test('FREQ=MONTHLY;INTERVAL=3', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-1
DTSTART:20200205T090000Z
DTEND:20200205T100000Z
SUMMARY:Quarterly
RRULE:FREQ=MONTHLY;INTERVAL=3
END:VEVENT
END:VCALENDAR`;
    const expanded = parseAndExpandEvent(ics, startObj, endObj, 'test-tz');
    assert.strictEqual(expanded.length, 1, 'Should have exactly 1 occurrence');
    assert.strictEqual(expanded[0].start, '2026-08-05T09:00:00.000Z');
  });

  await t.test('FREQ=WEEKLY;INTERVAL=2', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-2
DTSTART:20100101T090000Z
DTEND:20100101T100000Z
SUMMARY:Fortnightly
RRULE:FREQ=WEEKLY;INTERVAL=2
END:VEVENT
END:VCALENDAR`;
    const expanded = parseAndExpandEvent(ics, startObj, endObj, 'test-tz');
    const dates = expanded.map(e => e.start.substring(0, 10));
    // 2010-01-01 is a Friday.
    // 2026-08-07 is a Friday.
    assert.deepStrictEqual(dates, ['2026-08-07', '2026-08-21']);
  });
});
