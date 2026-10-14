const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseAndExpandEvent } = require('../utils/ical.js');

// Ground truth: iterate the same series from its true DTSTART, no fast-forward,
// no cap, and keep the occurrences overlapping [rangeStart, rangeEnd].
function groundTruth(ics, rangeStart, rangeEnd) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const ev = new ICAL.Event(comp.getFirstSubcomponent('vevent'));
  const startMs = new Date(rangeStart).getTime();
  const endMs = new Date(rangeEnd).getTime();
  const durMs = ev.duration.toSeconds() * 1000;
  const it = ev.iterator();
  const out = [];
  let next;
  while ((next = it.next())) {
    const s = next.toJSDate().getTime();
    if (s > endMs) break;
    if (s + durMs >= startMs) out.push(new Date(s).toISOString());
  }
  return out;
}

function series(dtstart, rrule, duration = 'PT1H') {
  return `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:issue171-${dtstart}-${rrule}
DTSTART:${dtstart}
DURATION:${duration}
SUMMARY:Test series
RRULE:${rrule}
END:VEVENT
END:VCALENDAR`;
}

function expandedStarts(ics, rangeStart, rangeEnd) {
  return parseAndExpandEvent(ics, rangeStart, rangeEnd).map(e => e.start);
}

test('Issue #171 — fast-forward matches un-fast-forwarded expansion', async (t) => {
  await t.test('FREQ=MONTHLY from the 31st lands on the 31st, not the 1st', () => {
    const ics = series('20150131T090000Z', 'FREQ=MONTHLY');
    assert.deepEqual(
      expandedStarts(ics, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
      ['2026-03-31T09:00:00.000Z']
    );
    assert.deepEqual(
      expandedStarts(ics, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'),
      ['2026-12-31T09:00:00.000Z']
    );
  });

  await t.test('FREQ=MONTHLY from the 29th, window March 2026 (rent reminder case)', () => {
    const ics = series('20150129T090000Z', 'FREQ=MONTHLY');
    assert.deepEqual(
      expandedStarts(ics, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
      ['2026-03-29T09:00:00.000Z']
    );
  });

  await t.test('FREQ=MONTHLY, DTSTART on days 29-31, INTERVAL 1/2/7, every month of 2026', () => {
    const mismatches = [];
    for (let month = 1; month <= 12; month++) {
      for (const day of [29, 30, 31]) {
        const d = new Date(Date.UTC(2015, month - 1, day));
        if (d.getUTCMonth() !== month - 1) continue; // no such date in 2015
        const dtstart = `2015${String(month).padStart(2, '0')}${day}T090000Z`;
        for (const interval of [1, 2, 7]) {
          const ics = series(dtstart, `FREQ=MONTHLY;INTERVAL=${interval}`);
          for (let wm = 0; wm < 12; wm++) {
            const ws = new Date(Date.UTC(2026, wm, 1)).toISOString();
            const we = new Date(Date.UTC(2026, wm + 1, 1)).toISOString();
            const got = expandedStarts(ics, ws, we);
            const want = groundTruth(ics, ws, we);
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              mismatches.push(`${dtstart} INTERVAL=${interval} ${ws.slice(0, 7)}: got ${got} want ${want}`);
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });

  await t.test('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO keeps the phase of the true DTSTART', () => {
    const ws = '2026-09-01T00:00:00Z';
    const we = '2026-10-13T00:00:00Z';
    for (const dtstart of ['20150105T090000Z', '20250901T090000Z', '20260824T090000Z']) {
      const ics = series(dtstart, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
      assert.deepEqual(expandedStarts(ics, ws, we), groundTruth(ics, ws, we), dtstart);
    }
    assert.deepEqual(
      expandedStarts(series('20150105T090000Z', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), ws, we),
      ['2026-09-14T09:00:00.000Z', '2026-09-28T09:00:00.000Z', '2026-10-12T09:00:00.000Z']
    );
  });

  await t.test('FREQ=DAILY;INTERVAL=7 from 2015 keeps its phase', () => {
    const ics = series('20150101T090000Z', 'FREQ=DAILY;INTERVAL=7');
    const ws = '2026-09-01T00:00:00Z';
    const we = '2026-09-15T00:00:00Z';
    assert.deepEqual(expandedStarts(ics, ws, we), ['2026-09-03T09:00:00.000Z', '2026-09-10T09:00:00.000Z']);
  });

  await t.test('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29 has no phantom March 1st in a non-leap year', () => {
    const ics = series('20150131T090000Z', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29');
    for (const [ws, we] of [
      ['2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'],
      ['2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z'],
      ['2028-02-01T00:00:00Z', '2028-04-01T00:00:00Z'],
      ['2031-02-01T00:00:00Z', '2031-04-01T00:00:00Z'],
    ]) {
      assert.deepEqual(expandedStarts(ics, ws, we), groundTruth(ics, ws, we), ws);
    }
    assert.deepEqual(expandedStarts(ics, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'), []);
  });

  await t.test('FREQ=YEARLY from Feb 29 matches ground truth in leap and non-leap years', () => {
    for (const rrule of ['FREQ=YEARLY', 'FREQ=YEARLY;INTERVAL=3']) {
      const ics = series('20160229T090000Z', rrule);
      for (const year of [2026, 2027, 2028, 2031, 2032]) {
        const ws = `${year}-02-01T00:00:00Z`;
        const we = `${year}-04-01T00:00:00Z`;
        assert.deepEqual(expandedStarts(ics, ws, we), groundTruth(ics, ws, we), `${rrule} ${year}`);
      }
    }
  });

  await t.test('FREQ=SECONDLY;INTERVAL=1 from 10 years ago is not starved by the iteration cap', () => {
    const ics = series('20160901T090000Z', 'FREQ=SECONDLY');
    const ws = '2026-09-01T09:00:00Z';
    const we = '2026-09-01T09:05:00Z';
    // A one-hour event recurring every second overlaps this window 500+ times;
    // the 500-instance cap applies, but the result must not be empty.
    // Ground truth by arithmetic (iterating ten years of seconds is too slow):
    // the first overlapping occurrence starts one DURATION before the window.
    const firstMs = new Date(ws).getTime() - 3600 * 1000;
    const want = Array.from({ length: 500 }, (_, i) => new Date(firstMs + i * 1000).toISOString());
    assert.deepEqual(expandedStarts(ics, ws, we), want);
  });

  await t.test('FREQ=SECONDLY;INTERVAL=7 from 10 years ago keeps its phase', () => {
    const dtstartMs = Date.UTC(2016, 8, 1, 9, 0, 0);
    const ics = series('20160901T090000Z', 'FREQ=SECONDLY;INTERVAL=7', 'PT1S');
    const ws = '2026-09-01T09:00:00Z';
    const we = '2026-09-01T09:01:00Z';
    // Arithmetic ground truth: occurrences at DTSTART + k*7s.
    const wsMs = new Date(ws).getTime();
    const weMs = new Date(we).getTime();
    const want = [];
    for (let s = dtstartMs + Math.ceil((wsMs - 1000 - dtstartMs) / 7000) * 7000; s <= weMs; s += 7000) {
      want.push(new Date(s).toISOString());
    }
    assert.ok(want.length >= 8, 'sanity: arithmetic ground truth has occurrences');
    assert.deepEqual(expandedStarts(ics, ws, we), want);
  });

  await t.test('FREQ=MINUTELY with a 3-hour DURATION includes occurrences that started before the window', () => {
    const ics = series('20160901T090000Z', 'FREQ=MINUTELY;INTERVAL=30', 'PT3H');
    const ws = '2026-09-01T00:00:00Z';
    const we = '2026-09-01T06:00:00Z';
    const got = expandedStarts(ics, ws, we);
    assert.deepEqual(got, groundTruth(ics, ws, we));
    assert.equal(got[0], '2026-08-31T21:00:00.000Z');
  });

  for (const rrule of ['FREQ=MINUTELY;INTERVAL=30', 'FREQ=MINUTELY;INTERVAL=7', 'FREQ=SECONDLY;INTERVAL=3600']) {
    await t.test(`${rrule} from 10 years ago returns the in-window occurrences`, () => {
      const ics = series('20160901T090000Z', rrule);
      const ws = '2026-09-01T00:00:00Z';
      const we = '2026-09-02T00:00:00Z';
      const want = groundTruth(ics, ws, we);
      assert.ok(want.length > 20, 'sanity: ground truth has occurrences');
      const t0 = performance.now();
      const got = expandedStarts(ics, ws, we);
      const ms = performance.now() - t0;
      assert.deepEqual(got, want);
      // Fast-forwarded expansion walks a couple of days, not ten years
      // (un-fast-forwarded this takes ~2 s).
      assert.ok(ms < 500, `expansion took ${ms.toFixed(1)} ms`);
    });
  }
});
