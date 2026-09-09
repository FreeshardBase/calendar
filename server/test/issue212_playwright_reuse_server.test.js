'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #212 — Playwright webServer config must not set reuseExistingServer unconditionally to true', async () => {
  const configPath = path.join(__dirname, '../../playwright.config.js');
  const content = fs.readFileSync(configPath, 'utf8');

  // Verify webServer does not hardcode reuseExistingServer: true
  assert.strictEqual(
    content.includes('reuseExistingServer: true'),
    false,
    'playwright.config.js webServer should not hardcode reuseExistingServer: true unconditionally'
  );

  // Verify webServer specifies reuseExistingServer depending on process.env.CI
  assert.strictEqual(
    content.includes('reuseExistingServer: !process.env.CI'),
    true,
    'playwright.config.js webServer must set reuseExistingServer based on !process.env.CI'
  );
});
