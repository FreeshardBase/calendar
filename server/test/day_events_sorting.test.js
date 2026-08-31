'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');

test('Issue #107 — Day Events Sorting & Overflow Selection Suite', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('calendar.js exports or implements sortEvents function', () => {
    assert.ok(
      calendarJs.includes('sortEvents'),
      'public/js/calendar.js must implement sortEvents for deterministic event order'
    );
  });

  await t.test('eventsForDay uses sortEvents so dayEvents are deterministically ordered', () => {
    assert.ok(
      /function eventsForDay[\s\S]*?return\s+sortEvents\(/.test(calendarJs),
      'eventsForDay must return sorted events using sortEvents'
    );
  });

  await t.test('sortEvents orders allDay events first, then start time, then end time, then title', () => {
    // Extract sortEvents implementation or test via evaluation
    const sortEventsMatch = calendarJs.match(/export\s+function\s+sortEvents\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
    assert.ok(sortEventsMatch, 'sortEvents function body must exist in calendar.js');

    // Create a standalone evaluator for sortEvents logic
    const sortFn = new Function('events', `
      ${sortEventsMatch[0].replace('export ', '')}
      return sortEvents(events);
    `);

    const rawEvents = [
      { uid: '1', title: 'Late Meeting', start: '2026-09-01T18:00:00Z', end: '2026-09-01T19:00:00Z', allDay: false },
      { uid: '2', title: 'All Day Event 2', start: '2026-09-01T00:00:00Z', allDay: true },
      { uid: '3', title: 'Morning Standup', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z', allDay: false },
      { uid: '4', title: 'All Day Event 1', start: '2026-09-01T00:00:00Z', allDay: true },
      { uid: '5', title: 'Noon Workshop', start: '2026-09-01T12:00:00Z', end: '2026-09-01T13:00:00Z', allDay: false },
      { uid: '6', title: 'Breakfast', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z', allDay: false }
    ];

    const sorted = sortFn(rawEvents);
    const sortedTitles = sorted.map(e => e.title);

    assert.deepEqual(sortedTitles, [
      'All Day Event 1',
      'All Day Event 2',
      'Breakfast',
      'Morning Standup',
      'Noon Workshop',
      'Late Meeting'
    ], 'Events must be sorted with all-day events first, then start time, then title');
  });
});
