'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #217 — E2E Harness Hygiene, Trace Configuration, and Script Integration', async (t) => {
  const rootDir = path.join(__dirname, '../..');
  const configPath = path.join(rootDir, 'playwright.config.js');
  const pkgPath = path.join(rootDir, 'package.json');
  const justfilePath = path.join(rootDir, 'justfile');
  const specPath = path.join(rootDir, 'e2e/calendar.spec.js');

  await t.test('playwright.config.js trace setting must not be on-first-retry when retries is 0', () => {
    const configContent = fs.readFileSync(configPath, 'utf8');
    assert.strictEqual(
      configContent.includes("trace: 'on-first-retry'"),
      false,
      'playwright.config.js trace mode must not be on-first-retry when retries is 0'
    );
    assert.strictEqual(
      configContent.includes("trace: 'retain-on-failure'") || configContent.includes("trace: 'on'"),
      true,
      'playwright.config.js trace mode must be set to retain-on-failure or on'
    );
  });

  await t.test('package.json and justfile must include e2e test execution commands', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.strictEqual(
      typeof pkg.scripts['test:e2e'],
      'string',
      'package.json must contain a test:e2e script'
    );
    assert.strictEqual(
      typeof pkg.scripts['test:all'],
      'string',
      'package.json must contain a test:all script running unit and e2e tests'
    );

    const justfileContent = fs.readFileSync(justfilePath, 'utf8');
    assert.strictEqual(
      justfileContent.includes('ci: lint test test-e2e') || justfileContent.includes('ci: lint test-all') || justfileContent.includes('test-e2e'),
      true,
      'justfile ci recipe must include e2e test target execution'
    );
  });

  await t.test('e2e/calendar.spec.js must configure fixture setup and teardown hooks', () => {
    const specContent = fs.readFileSync(specPath, 'utf8');
    assert.strictEqual(
      specContent.includes('test.beforeEach'),
      true,
      'e2e spec must configure test.beforeEach fixture setup'
    );
    assert.strictEqual(
      specContent.includes('test.afterEach'),
      true,
      'e2e spec must configure test.afterEach teardown hook'
    );
  });
});
