'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');
const calendarJsContent = fs.readFileSync(calendarJsPath, 'utf8');

// Strip top-level import statement, export keywords, and extract getDateRange
const sanitizedJs = calendarJsContent
  .replace(/^import\s+[\s\S]*?;/m, '')
  .replace(/export\s+/g, '');

const evaluator = new Function(`
  ${sanitizedJs}
  return { getDateRange };
`);

const { getDateRange } = evaluator();

describe('Issue #161 — Month Grid Date Range Alignment', () => {
  test('getDateRange for month starts on Monday matching Monday-start month grid', () => {
    // October 2026: Oct 1 is Thursday. Monday start of grid is Sep 28, 2026.
    const date = new Date(2026, 9, 1);
    const { start, end } = getDateRange('month', date);

    assert.strictEqual(start.getDay(), 1, 'Month range start must be a Monday (getDay() === 1)');
    assert.strictEqual(start.getFullYear(), 2026);
    assert.strictEqual(start.getMonth(), 8); // September
    assert.strictEqual(start.getDate(), 28);
  });

  test('getDateRange for month ends 42 days (6 full weeks) after Monday start', () => {
    // October 2026: grid spans 42 cells from Sep 28, 2026 to Nov 8, 2026.
    const date = new Date(2026, 9, 1);
    const { start, end } = getDateRange('month', date);

    assert.strictEqual(end.getDay(), 0, 'Month range end must be a Sunday (getDay() === 0)');
    assert.strictEqual(end.getFullYear(), 2026);
    assert.strictEqual(end.getMonth(), 10); // November
    assert.strictEqual(end.getDate(), 8);
    assert.strictEqual(end.getHours(), 23);
    assert.strictEqual(end.getMinutes(), 59);
    assert.strictEqual(end.getSeconds(), 59);
  });

  test('getDateRange for month starting on Sunday includes leading Monday from previous month', () => {
    // November 2026: Nov 1 is Sunday. Monday start of grid is Oct 26, 2026.
    const date = new Date(2026, 10, 1);
    const { start, end } = getDateRange('month', date);

    assert.strictEqual(start.getDay(), 1);
    assert.strictEqual(start.getFullYear(), 2026);
    assert.strictEqual(start.getMonth(), 9); // October
    assert.strictEqual(start.getDate(), 26);

    // End should be Dec 6, 2026 (Sunday)
    assert.strictEqual(end.getDay(), 0);
    assert.strictEqual(end.getMonth(), 11); // December
    assert.strictEqual(end.getDate(), 6);
  });
});
