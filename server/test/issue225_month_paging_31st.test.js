'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load calendar.js as CommonJS by stripping ES module syntax
const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');
let calendarSrc = fs.readFileSync(calendarJsPath, 'utf8');
calendarSrc = calendarSrc
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/^import\s+.*?;?\s*$/gm, '');

const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', calendarSrc + '\nmodule.exports = { navigate };')(mod, mod.exports);
const { navigate } = mod.exports;

describe('Issue #225 — Month paging from 31st does not skip a month', () => {
  test('forward from Jan 31 lands in February, not March (non-leap year)', () => {
    const jan31 = new Date(2026, 0, 31);
    const result = navigate('month', jan31, +1);
    assert.strictEqual(result.getMonth(), 1, 'Expected February (index 1)');
    assert.strictEqual(result.getFullYear(), 2026);
    assert.ok(result.getDate() <= 28, `Day ${result.getDate()} must be ≤ 28 for Feb 2026`);
  });

  test('forward from Jan 31 in leap year lands in Feb with day 29', () => {
    const jan31 = new Date(2028, 0, 31);
    const result = navigate('month', jan31, +1);
    assert.strictEqual(result.getMonth(), 1);
    assert.strictEqual(result.getFullYear(), 2028);
    assert.strictEqual(result.getDate(), 29);
  });

  test('backward from Mar 31 lands in February, not March', () => {
    const mar31 = new Date(2026, 2, 31);
    const result = navigate('month', mar31, -1);
    assert.strictEqual(result.getMonth(), 1);
    assert.ok(result.getDate() <= 28);
  });

  test('forward from Feb 28 to March preserves day 28 (no spurious clamp)', () => {
    const feb28 = new Date(2026, 1, 28);
    const result = navigate('month', feb28, +1);
    assert.strictEqual(result.getMonth(), 2);
    assert.strictEqual(result.getDate(), 28);
  });

  test('agenda view forward from Jan 31 lands in February', () => {
    const jan31 = new Date(2026, 0, 31);
    const result = navigate('agenda', jan31, +1);
    assert.strictEqual(result.getMonth(), 1);
  });

  test('multi-step: Jan 31 → Feb → Mar arrives in March not April', () => {
    const jan31 = new Date(2026, 0, 31);
    const feb = navigate('month', jan31, +1);
    const mar = navigate('month', feb, +1);
    assert.strictEqual(mar.getMonth(), 2);
    assert.strictEqual(mar.getDate(), 28);
  });

  test('static audit: navigate() uses daysInTarget clamping, not bare setMonth', () => {
    const src = fs.readFileSync(calendarJsPath, 'utf8');
    assert.ok(
      src.includes('daysInTarget') && src.includes('Math.min'),
      'navigate() must clamp via daysInTarget + Math.min'
    );
    assert.ok(
      !(/case 'month':\s*d\.setMonth/).test(src),
      'navigate() must not use bare setMonth on month case'
    );
  });
});
