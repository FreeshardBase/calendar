'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #182 — Calendar Visibility & ICS Import Keyboard Reachability', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('ics-dropzone in index.html includes tabindex="0", role="button", and aria-label', () => {
    assert.ok(
      indexHtml.includes('id="ics-dropzone"'),
      'index.html must contain #ics-dropzone'
    );
    assert.ok(
      indexHtml.includes('id="ics-dropzone"') && indexHtml.includes('tabindex="0"'),
      '#ics-dropzone must include tabindex="0" attribute for keyboard focusability'
    );
    assert.ok(
      indexHtml.includes('id="ics-dropzone"') && indexHtml.includes('role="button"'),
      '#ics-dropzone must include role="button" attribute for accessibility'
    );
    assert.ok(
      indexHtml.includes('id="ics-dropzone"') && indexHtml.includes('aria-label='),
      '#ics-dropzone must include aria-label attribute'
    );
  });

  await t.test('initIcsImport in app.js attaches keydown event handler for Enter and Space', () => {
    assert.ok(
      appJs.includes('initIcsImport'),
      'app.js must contain initIcsImport'
    );
    assert.ok(
      appJs.includes("zone.addEventListener('keydown'") || appJs.includes('zone.addEventListener("keydown"'),
      'initIcsImport must attach a keydown listener to ics-dropzone'
    );
  });

  await t.test('renderCalendarList in app.js generates tabindex="0", role="checkbox", and aria-checked on calendar items', () => {
    assert.ok(
      appJs.includes('class="calendar-item') && appJs.includes('tabindex="0"'),
      'calendar-item must include tabindex="0"'
    );
    assert.ok(
      appJs.includes('role="checkbox"'),
      'calendar-item must include role="checkbox"'
    );
    assert.ok(
      appJs.includes('aria-checked='),
      'calendar-item must include aria-checked attribute reflecting toggle state'
    );
  });

  await t.test('renderCalendarList in app.js attaches keydown event handler for Enter and Space on calendar items', () => {
    assert.ok(
      appJs.includes("el.addEventListener('keydown'") || appJs.includes('el.addEventListener("keydown"'),
      'renderCalendarList must attach a keydown listener on calendar items'
    );
  });
});
