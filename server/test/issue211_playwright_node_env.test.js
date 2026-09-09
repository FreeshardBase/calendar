'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #211 — Playwright webServer config must not run under NODE_ENV=test', async () => {
  const configPath = path.join(__dirname, '../../playwright.config.js');
  const content = fs.readFileSync(configPath, 'utf8');

  // Verify webServer command does not set NODE_ENV=test
  assert.strictEqual(
    content.includes('NODE_ENV=test'),
    false,
    'playwright.config.js webServer command should not run under NODE_ENV=test'
  );

  // Verify webServer command specifies NODE_ENV=production
  assert.strictEqual(
    content.includes('NODE_ENV=production'),
    true,
    'playwright.config.js webServer command must specify NODE_ENV=production'
  );

  // Verify webServer command specifies a secure SESSION_SECRET
  assert.strictEqual(
    content.includes('SESSION_SECRET='),
    true,
    'playwright.config.js webServer command must specify SESSION_SECRET'
  );
});
