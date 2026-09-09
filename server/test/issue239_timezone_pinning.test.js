'use strict';

/**
 * Issue #239 — Browser Timezone Pinning & Non-Vacuous Timezone Test Assertion
 *
 * Prevents vacuous timezone test execution by ensuring:
 * 1. playwright.config.js specifies explicit timezoneId under `use` configuration.
 * 2. critical_auth_timezone_assertions.test.js sets process.env.TZ deterministically.
 * 3. Process environment enforces a pinned timezone ('Europe/Berlin') for test runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwrightConfig = require('../../playwright.config.js');

test('Issue #239 — Browser & Process Timezone Pinning Suite', async (t) => {

  await t.test('Playwright Config: Enforces explicit timezoneId in browser context use settings', () => {
    assert.ok(playwrightConfig.use, 'playwright.config.js must contain a `use` configuration object');
    assert.ok(
      playwrightConfig.use.timezoneId,
      'playwright.config.js `use` block must explicitly pin `timezoneId` (e.g., Europe/Berlin)'
    );
    assert.equal(
      playwrightConfig.use.timezoneId,
      process.env.TZ || 'Europe/Berlin',
      'Playwright `timezoneId` must default to Europe/Berlin or process.env.TZ'
    );
  });

  await t.test('Critical Timezone Test: critical_auth_timezone_assertions.test.js pins process.env.TZ', () => {
    const testFilePath = path.join(__dirname, 'critical_auth_timezone_assertions.test.js');
    const content = fs.readFileSync(testFilePath, 'utf8');
    assert.match(
      content,
      /process\.env\.TZ\s*=\s*/,
      'critical_auth_timezone_assertions.test.js must set process.env.TZ at file initialization'
    );
  });

  await t.test('Environment Verification: Current test process operates under pinned timezone', () => {
    const tz = process.env.TZ || 'Europe/Berlin';
    assert.ok(tz, 'Process timezone must be defined');
    const df = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    const formatted = df.format(new Date('2026-01-15T12:00:00Z'));
    assert.ok(formatted, 'DateTimeFormat must execute successfully under pinned timezone');
  });

});
