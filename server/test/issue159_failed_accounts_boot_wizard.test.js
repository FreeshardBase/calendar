'use strict';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

describe('Issue #159 — Failed /api/accounts at boot does not show first-run setup wizard', () => {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('app.js does not invoke showOnboarding() in boot error catch block', () => {
    // Extract boot function body
    const bootMatch = appJsContent.match(/async function boot\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(bootMatch, 'boot() function must exist in app.js');

    const bootBody = bootMatch[1];
    const catchMatch = bootBody.match(/catch\s*\(([^)]+)\)\s*\{([\s\S]*?)\}/);
    assert.ok(catchMatch, 'boot() must contain a catch block');

    const catchBody = catchMatch[2];
    assert.strictEqual(
      catchBody.includes('showOnboarding()'),
      false,
      'boot() catch block must NOT call showOnboarding() when account fetching fails'
    );
  });

  test('boot error handler shows app shell and displays an error toast/status', () => {
    const bootMatch = appJsContent.match(/async function boot\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(bootMatch, 'boot() function must exist in app.js');
    const bootBody = bootMatch[1];
    const catchMatch = bootBody.match(/catch\s*\(([^)]+)\)\s*\{([\s\S]*?)\}/);
    assert.ok(catchMatch, 'boot() must contain a catch block');

    const catchBody = catchMatch[2];
    assert.ok(catchBody.includes('hideLoading()'), 'boot() catch block must hide loading screen');
    assert.ok(catchBody.includes('showApp()'), 'boot() catch block must present app shell');
    assert.ok(catchBody.includes('showToast'), 'boot() catch block must notify user via error toast');
  });
});
