'use strict';

// Issue #212: CI must start its own server under test, never attach to whatever already listens on
// the port; a local run may reuse a running dev server. The config is loaded in a fresh process,
// as the Playwright runner does, with and without CI set.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(__dirname, '../../playwright.config.js');

function reuseExistingServer(ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  const out = execFileSync(process.execPath, ['-e',
    `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG_PATH)}).webServer.reuseExistingServer))`],
  { env, encoding: 'utf8' });
  return JSON.parse(out);
}

test('Issue #212 — CI never reuses an already running server', () => {
  assert.equal(reuseExistingServer('true'), false);
  assert.equal(reuseExistingServer('1'), false);
});

test('Issue #212 — a local run reuses a running server', () => {
  assert.equal(reuseExistingServer(undefined), true);
});
