'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #217 — package.json must include "test:e2e" script for Playwright execution', async () => {
  const pkgPath = path.join(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.ok(pkg.scripts, 'package.json must contain scripts section');
  assert.ok(pkg.scripts['test:e2e'], 'package.json must include test:e2e script');
  assert.strictEqual(
    pkg.scripts['test:e2e'],
    'playwright test',
    'package.json test:e2e script must execute playwright test'
  );
});

test('Issue #217 — playwright.config.js must not use trace: on-first-retry when retries is 0', async () => {
  const configPath = path.join(__dirname, '../../playwright.config.js');
  const content = fs.readFileSync(configPath, 'utf8');

  assert.strictEqual(
    content.includes("trace: 'on-first-retry'"),
    false,
    "playwright.config.js trace should not be set to 'on-first-retry' when retries is 0"
  );

  assert.strictEqual(
    content.includes("trace: 'retain-on-failure'"),
    true,
    "playwright.config.js trace must be set to 'retain-on-failure'"
  );
});

test('Issue #217 — e2e/calendar.spec.js must define a test.afterEach teardown hook fixture', async () => {
  const specPath = path.join(__dirname, '../../e2e/calendar.spec.js');
  const content = fs.readFileSync(specPath, 'utf8');

  assert.strictEqual(
    content.includes('test.afterEach('),
    true,
    'e2e/calendar.spec.js must define a test.afterEach teardown fixture'
  );
});
