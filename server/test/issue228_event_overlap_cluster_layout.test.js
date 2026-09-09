'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');

test('Issue #228 — Event Overlap Cluster Layout Suite', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('public/js/calendar.js exports layoutEvents function', () => {
    assert.ok(
      /export\s+function\s+layoutEvents/.test(calendarJs),
      'public/js/calendar.js must export layoutEvents'
    );
  });

  const layoutMatch = calendarJs.match(/export\s+function\s+layoutEvents\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
  assert.ok(layoutMatch, 'layoutEvents function definition must exist in calendar.js');

  const sortEventsMatch = calendarJs.match(/export\s+function\s+sortEvents\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
  assert.ok(sortEventsMatch, 'sortEvents function definition must exist in calendar.js');

  // Create isolated evaluator for layoutEvents and sortEvents
  const evalLayout = new Function('events', `
    ${sortEventsMatch[0].replace('export ', '')}
    ${layoutMatch[0].replace('export ', '')}
    return layoutEvents(events);
  `);

  await t.test('isolated non-overlapping events each receive totalCols: 1', () => {
    const events = [
      { uid: 'ev1', start: '2026-09-09T09:00:00Z', end: '2026-09-09T10:00:00Z', title: 'Morning' },
      { uid: 'ev2', start: '2026-09-09T11:00:00Z', end: '2026-09-09T12:00:00Z', title: 'Noon' },
      { uid: 'ev3', start: '2026-09-09T14:00:00Z', end: '2026-09-09T15:00:00Z', title: 'Afternoon' }
    ];

    const result = evalLayout(events);
    assert.equal(result.length, 3);
    for (const item of result) {
      assert.equal(item.totalCols, 1, `Event ${item.ev.uid} should have totalCols = 1`);
      assert.equal(item.col, 0, `Event ${item.ev.uid} should be in col 0`);
    }
  });

  await t.test('events in day are not squeezed by worst overlap of unrelated time clusters', () => {
    const events = [
      // Cluster 1: 3-way overlap (totalCols should be 3 for cluster 1)
      { uid: 'c1_ev1', start: '2026-09-09T09:00:00Z', end: '2026-09-09T10:00:00Z', title: 'A' },
      { uid: 'c1_ev2', start: '2026-09-09T09:15:00Z', end: '2026-09-09T09:45:00Z', title: 'B' },
      { uid: 'c1_ev3', start: '2026-09-09T09:30:00Z', end: '2026-09-09T10:15:00Z', title: 'C' },
      // Cluster 2: isolated event in afternoon (totalCols should be 1, NOT 3)
      { uid: 'c2_ev1', start: '2026-09-09T14:00:00Z', end: '2026-09-09T15:00:00Z', title: 'D' }
    ];

    const result = evalLayout(events);
    const byUid = new Map(result.map(r => [r.ev.uid, r]));

    assert.equal(byUid.get('c1_ev1').totalCols, 3);
    assert.equal(byUid.get('c1_ev2').totalCols, 3);
    assert.equal(byUid.get('c1_ev3').totalCols, 3);

    // D is isolated: must have totalCols = 1 and col = 0
    assert.equal(byUid.get('c2_ev1').totalCols, 1, 'Afternoon isolated event must have totalCols = 1');
    assert.equal(byUid.get('c2_ev1').col, 0, 'Afternoon isolated event must be in col 0');
  });

  await t.test('chain overlapping events belong to same cluster and compute cluster totalCols', () => {
    const events = [
      { uid: 'a', start: '2026-09-09T09:00:00Z', end: '2026-09-09T10:00:00Z', title: 'A' },
      { uid: 'b', start: '2026-09-09T09:30:00Z', end: '2026-09-09T10:30:00Z', title: 'B' },
      { uid: 'c', start: '2026-09-09T10:00:00Z', end: '2026-09-09T11:00:00Z', title: 'C' }
    ];

    const result = evalLayout(events);
    const byUid = new Map(result.map(r => [r.ev.uid, r]));

    assert.equal(byUid.get('a').totalCols, 2);
    assert.equal(byUid.get('b').totalCols, 2);
    assert.equal(byUid.get('c').totalCols, 2);

    assert.equal(byUid.get('a').col, 0);
    assert.equal(byUid.get('b').col, 1);
    assert.equal(byUid.get('c').col, 0); // Reuses col 0 since A ended at 10:00
  });
});
