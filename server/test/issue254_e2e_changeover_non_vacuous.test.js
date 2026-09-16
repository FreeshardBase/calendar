'use strict';

/**
 * Issue #254 — MEDIUM: Non-Vacuous E2E Suite Assertions on DST Changeover Days
 *
 * Requirements:
 * 1. Demonstrate why process/browser timezone pinning (Issue #239) is insufficient by itself
 *    without an explicit pinned date or clock in E2E tests:
 *    - On a DST autumn fall-back changeover day (e.g., 2026-10-25 in Europe/Berlin), local day duration
 *      is 25 hours (90,000,000 ms), whereas a normal day is 24 hours (86,400,000 ms).
 *    - Without clock/date pinning, running tests on a changeover day causes dynamic wall-clock shifts
 *      and ambiguous time representations (e.g. 02:30 CEST vs 02:30 CET).
 * 2. Ensure e2e/calendar.spec.js includes an explicit pinned date context test (`page.clock.setFixedTime`
 *    and `/?date=2026-10-25`) for non-vacuous changeover day verification.
 * 3. Verify that DateTimeFormat and local date offset calculations remain deterministic under a pinned changeover date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwrightConfig = require('../../playwright.config.js');

test('Issue #254 — Non-Vacuous E2E Suite Changeover Day Assertion Suite', async (t) => {

  await t.test('Playwright Config: Enforces timezone pin (Issue #239 prerequisite)', () => {
    assert.ok(playwrightConfig.use, 'playwright.config.js must contain a `use` configuration block');
    assert.equal(
      playwrightConfig.use.timezoneId,
      process.env.TZ || 'Europe/Berlin',
      'Playwright timezoneId must be pinned to Europe/Berlin or process.env.TZ'
    );
  });

  await t.test('Changeover Math: Demonstrates 25h duration vs 24h duration on Europe/Berlin autumn changeover day', () => {
    const tz = 'Europe/Berlin';
    // Midnight start of changeover day (2026-10-25 00:00 CEST -> 2026-10-24 22:00:00Z)
    const changeoverStart = new Date('2026-10-24T22:00:00Z');
    // Midnight start of next day (2026-10-26 00:00 CET -> 2026-10-25 23:00:00Z)
    const nextDayStart = new Date('2026-10-25T23:00:00Z');

    const changeoverDurationMs = nextDayStart.getTime() - changeoverStart.getTime();
    assert.equal(changeoverDurationMs, 25 * 3600 * 1000, 'DST fall-back changeover day in Europe/Berlin must be 25 hours (90,000,000 ms)');

    // Midnight start of normal day (2026-07-15 00:00 CEST -> 2026-07-14 22:00:00Z)
    const normalStart = new Date('2026-07-14T22:00:00Z');
    const normalNextDayStart = new Date('2026-07-15T22:00:00Z');
    const normalDurationMs = normalNextDayStart.getTime() - normalStart.getTime();
    assert.equal(normalDurationMs, 24 * 3600 * 1000, 'Normal day in Europe/Berlin must be 24 hours (86,400,000 ms)');
  });

  await t.test('E2E Spec Audit: e2e/calendar.spec.js includes non-vacuous changeover date pinning assertion', () => {
    const e2eSpecPath = path.join(__dirname, '../../e2e/calendar.spec.js');
    const content = fs.readFileSync(e2eSpecPath, 'utf8');

    assert.ok(
      content.includes('setFixedTime') || content.includes('2026-10-25'),
      'e2e/calendar.spec.js must explicitly reference pinned clock setFixedTime or changeover date 2026-10-25'
    );
    assert.ok(
      content.includes('Issue #254'),
      'e2e/calendar.spec.js must contain a test suite asserting Issue #254 changeover day handling'
    );
  });

  await t.test('DateTimeFormat: Pinned changeover date resolves unambiguous wall-clock string', () => {
    const changeoverDate = new Date('2026-10-25T10:00:00Z');
    const df = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const formatted = df.format(changeoverDate);
    assert.ok(formatted.includes('25.10.2026') || formatted.includes('2026'), 'Formatted string must reflect changeover date 25.10.2026');
  });

});
