const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndExpandEvent, buildVTimezoneBlock } = require('../utils/ical.js');

test('Issue #307 — Recurring TZID event DST transition expansion', async (t) => {

  await t.test('1. Europe/Berlin weekly event spanning DST spring-forward retains wall-clock time and weekday', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst-307-berlin-weekly
DTSTART;TZID=Europe/Berlin:20241020T090000
DTEND;TZID=Europe/Berlin:20241020T100000
RRULE:FREQ=WEEKLY
SUMMARY:Weekly Sunday Standup
END:VEVENT
END:VCALENDAR`;

    // Search range in March/April 2026 spanning DST transition on 2026-03-29
    const instances = parseAndExpandEvent(ics, '2026-03-20T00:00:00Z', '2026-04-10T23:59:59Z');

    assert.equal(instances.length, 3, 'Should expand to 3 Sunday instances in window');
    
    // Check that all 3 instances land on Sundays
    for (const inst of instances) {
      const d = new Date(inst.start);
      assert.equal(d.getUTCDay(), 0, `Instance start ${inst.start} must land on Sunday`);
    }

    // March 22 (CET / UTC+1): 09:00 -> 08:00 UTC
    assert.equal(instances[0].start, '2026-03-22T08:00:00.000Z');
    // March 29 (CEST / UTC+2): 09:00 -> 07:00 UTC
    assert.equal(instances[1].start, '2026-03-29T07:00:00.000Z');
    // April 05 (CEST / UTC+2): 09:00 -> 07:00 UTC
    assert.equal(instances[2].start, '2026-04-05T07:00:00.000Z');
  });

  await t.test('2. America/New_York daily event spanning US DST transition (March 8, 2026)', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst-307-ny-daily
DTSTART;TZID=America/New_York:20260306T090000
DTEND;TZID=America/New_York:20260306T100000
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Daily NY Standup
END:VEVENT
END:VCALENDAR`;

    const instances = parseAndExpandEvent(ics, '2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z');
    assert.equal(instances.length, 5);

    // March 6 (EST / UTC-5): 09:00 -> 14:00 UTC
    assert.equal(instances[0].start, '2026-03-06T14:00:00.000Z');
    // March 7 (EST / UTC-5): 09:00 -> 14:00 UTC
    assert.equal(instances[1].start, '2026-03-07T14:00:00.000Z');
    // March 8 (EDT / UTC-4): 09:00 -> 13:00 UTC (US spring-forward)
    assert.equal(instances[2].start, '2026-03-08T13:00:00.000Z');
    // March 9 (EDT / UTC-4): 09:00 -> 13:00 UTC
    assert.equal(instances[3].start, '2026-03-09T13:00:00.000Z');
    // March 10 (EDT / UTC-4): 09:00 -> 13:00 UTC
    assert.equal(instances[4].start, '2026-03-10T13:00:00.000Z');
  });

  await t.test('3. Australia/Sydney event spanning Southern Hemisphere DST transition (April 5, 2026)', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst-307-sydney-daily
DTSTART;TZID=Australia/Sydney:20260403T090000
DTEND;TZID=Australia/Sydney:20260403T100000
RRULE:FREQ=DAILY;COUNT=4
SUMMARY:Sydney Daily
END:VEVENT
END:VCALENDAR`;

    const instances = parseAndExpandEvent(ics, '2026-04-01T00:00:00Z', '2026-04-10T23:59:59Z');
    assert.equal(instances.length, 4);

    // April 3 (AEDT / UTC+11): 09:00 -> 2026-04-02T22:00:00Z
    assert.equal(instances[0].start, '2026-04-02T22:00:00.000Z');
    // April 4 (AEDT / UTC+11): 09:00 -> 2026-04-03T22:00:00Z
    assert.equal(instances[1].start, '2026-04-03T22:00:00.000Z');
    // April 5 (AEST / UTC+10, fall back): 09:00 -> 2026-04-04T23:00:00Z
    assert.equal(instances[2].start, '2026-04-04T23:00:00.000Z');
    // April 6 (AEST / UTC+10): 09:00 -> 2026-04-05T23:00:00Z
    assert.equal(instances[3].start, '2026-04-05T23:00:00.000Z');
  });

  await t.test('4. buildVTimezoneBlock generates accurate RRULEs for US, Europe, and Australia', () => {
    const nyBlock = buildVTimezoneBlock('America/New_York');
    assert.match(nyBlock, /BYMONTH=3;BYDAY=2SU/);
    assert.match(nyBlock, /BYMONTH=11;BYDAY=1SU/);

    const berlinBlock = buildVTimezoneBlock('Europe/Berlin');
    assert.match(berlinBlock, /BYMONTH=3;BYDAY=-1SU/);
    assert.match(berlinBlock, /BYMONTH=10;BYDAY=-1SU/);

    const sydneyBlock = buildVTimezoneBlock('Australia/Sydney');
    assert.match(sydneyBlock, /BYMONTH=4;BYDAY=1SU/);
    assert.match(sydneyBlock, /BYMONTH=10;BYDAY=1SU/);
  });
});
