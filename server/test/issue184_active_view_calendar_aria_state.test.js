'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #184 — Active View & Calendar On/Off ARIA State Accessibility', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('index.html view tab buttons include aria-selected and aria-pressed attributes', () => {
    assert.ok(
      indexHtml.includes('id="view-month"') && indexHtml.includes('aria-selected="true"') && indexHtml.includes('aria-pressed="true"'),
      '#view-month must include aria-selected="true" and aria-pressed="true" as default active view'
    );
    assert.ok(
      indexHtml.includes('id="view-week"') && indexHtml.includes('aria-selected="false"') && indexHtml.includes('aria-pressed="false"'),
      '#view-week must include aria-selected="false" and aria-pressed="false"'
    );
  });

  await t.test('app.js view tab synchronization updates aria-selected and aria-pressed attributes', () => {
    assert.ok(
      appJs.includes("setAttribute('aria-selected'") || appJs.includes('setAttribute("aria-selected"'),
      'app.js view tab switcher must dynamically update aria-selected attribute'
    );
    assert.ok(
      appJs.includes("setAttribute('aria-pressed'") || appJs.includes('setAttribute("aria-pressed"'),
      'app.js view tab switcher must dynamically update aria-pressed attribute'
    );
  });

  await t.test('app.js calendar list items output role="checkbox" and aria-checked attribute', () => {
    assert.ok(
      appJs.includes('role="checkbox"'),
      'app.js calendar list items must specify role="checkbox"'
    );
    assert.ok(
      appJs.includes('aria-checked='),
      'app.js calendar list items must specify aria-checked attribute'
    );
  });
});
