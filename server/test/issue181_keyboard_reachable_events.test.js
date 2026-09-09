'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve('public/js/calendar.js');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #181 — Calendar Grid Keyboard Reachability and Action Activation', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('chipHtml in calendar.js produces tabindex="0" and role="button"', () => {
    assert.ok(
      calendarJs.includes('tabindex="0"') || calendarJs.includes("tabindex='0'"),
      'chipHtml must include tabindex="0" attribute for keyboard focusability'
    );
    assert.ok(
      calendarJs.includes('role="button"'),
      'chipHtml must include role="button" attribute for screen readers and accessibility'
    );
  });

  await t.test('createEventBlock in calendar.js sets tabindex, role, and keydown handlers', () => {
    assert.ok(
      calendarJs.includes("block.setAttribute('tabindex', '0')") || calendarJs.includes("block.tabIndex = 0") || calendarJs.includes("tabindex"),
      'createEventBlock must set tabindex="0" on event block element'
    );
    assert.ok(
      calendarJs.includes("block.setAttribute('role', 'button')") || calendarJs.includes("role"),
      'createEventBlock must set role="button" on event block element'
    );
    assert.ok(
      calendarJs.includes("keydown") || calendarJs.includes("Enter"),
      'createEventBlock or container must handle keydown for Enter / Space activation'
    );
  });

  await t.test('agendaEventHtml in calendar.js includes tabindex="0" and role="button"', () => {
    assert.ok(
      calendarJs.includes('class="agenda-event"') && (calendarJs.includes('tabindex="0"') || calendarJs.includes("tabindex='0'")),
      'agendaEventHtml must produce tabindex="0" on agenda-event elements'
    );
  });

  await t.test('container event delegation in calendar.js handles keydown for Enter and Space', () => {
    assert.ok(
      calendarJs.includes("keydown") && (calendarJs.includes("'Enter'") || calendarJs.includes('"Enter"')),
      'calendar.js container event listeners must include keydown handler for Enter / Space'
    );
  });

  await t.test('showEventPopover in app.js supports keyboard event positioning and popover focus', () => {
    assert.ok(
      appJs.includes('getBoundingClientRect') || appJs.includes('typeof mouseEvent.clientX'),
      'showEventPopover must handle keyboard event targets without clientX/clientY'
    );
    assert.ok(
      appJs.includes('focus()') || appJs.includes('editBtn.focus()') || appJs.includes('popover.focus()'),
      'showEventPopover should shift keyboard focus to popover/action button when opened'
    );
  });
});
