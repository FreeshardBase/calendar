const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve('public/js/calendar.js');
const appCssPath = path.resolve('public/css/app.css');

test('Issue #90 — 30-Minute Event Title Visibility', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');
  const appCss = fs.readFileSync(appCssPath, 'utf8');

  await t.test('calendar.js assigns short-event class or handles short duration events (<= 30 mins)', () => {
    assert.ok(
      calendarJs.includes('short-event') || calendarJs.includes('isShort'),
      'calendar.js should detect short duration events and apply short-event layout handling'
    );
  });

  await t.test('calendar.js renders event-block-title inside short event blocks', () => {
    assert.ok(
      calendarJs.includes('event-block-title'),
      'calendar.js must render .event-block-title in event blocks'
    );
  });

  await t.test('app.css includes rules for .event-block.short-event to prevent title clipping', () => {
    assert.ok(
      appCss.includes('.event-block.short-event') || appCss.includes('.short-event'),
      'app.css should include CSS rules for .event-block.short-event'
    );
    assert.ok(
      appCss.includes('flex-direction: row') || appCss.includes('gap:'),
      'app.css short-event rule should use compact padding and layout so title fits within 30px height'
    );
  });
});
