'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #266 — Event Popover Accessibility & Announcement', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('index.html declares #event-popover with role="dialog" instead of role="tooltip"', () => {
    assert.ok(
      indexHtml.includes('id="event-popover"') && indexHtml.includes('role="dialog"'),
      '#event-popover must declare role="dialog"'
    );
    assert.ok(
      !indexHtml.includes('id="event-popover" role="tooltip"') &&
      !indexHtml.includes('role="tooltip" id="event-popover"'),
      '#event-popover must not declare role="tooltip"'
    );
  });

  await t.test('index.html #event-popover has accessible name attribute (aria-labelledby or aria-label)', () => {
    assert.ok(
      indexHtml.includes('aria-labelledby="popover-title"') || indexHtml.includes('aria-label="Termindetails"'),
      '#event-popover must specify aria-labelledby="popover-title" or aria-label'
    );
  });

  await t.test('app.js sets id="popover-title" on popover title element', () => {
    assert.ok(
      appJs.includes('class="popover-title" id="popover-title"') ||
      appJs.includes('id="popover-title" class="popover-title"') ||
      appJs.includes('id="popover-title"'),
      'showEventPopover in app.js must assign id="popover-title" to the title element'
    );
  });

  await t.test('app.js showEventPopover triggers live announcement when popover opens', () => {
    // Look for announce call within showEventPopover function block
    const showEventPopoverFunc = appJs.slice(
      appJs.indexOf('function showEventPopover('),
      appJs.indexOf('function closePopover(')
    );

    assert.ok(
      showEventPopoverFunc.includes('announce('),
      'showEventPopover must invoke announce(...) to inform screen readers when opened'
    );
  });
});
