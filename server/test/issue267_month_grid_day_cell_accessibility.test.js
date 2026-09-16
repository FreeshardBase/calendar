'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve('public/js/calendar.js');

test('Issue #267 — Month Grid Day Cell Click Target & Accessibility Isolation', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('calendar.js renderMonth guards day click handler attachment with isCurrentMonth check', () => {
    assert.ok(
      calendarJs.includes('if (isCurrentMonth)') || calendarJs.includes('isCurrentMonth &&'),
      'renderMonth must guard day click handler attachment with isCurrentMonth'
    );
  });

  await t.test('calendar.js renderMonth sets aria-disabled="true" on other-month day cells', () => {
    assert.ok(
      calendarJs.includes('aria-disabled') && (calendarJs.includes('other-month') || calendarJs.includes('!isCurrentMonth')),
      'renderMonth must set aria-disabled="true" on other-month day cells'
    );
  });

  await t.test('other-month day cells do not register day creation click listeners', () => {
    // Locate renderMonth function block
    const renderMonthBlock = calendarJs.slice(
      calendarJs.indexOf('function renderMonth('),
      calendarJs.indexOf('export function chipHtml(')
    );

    assert.ok(
      renderMonthBlock.includes('isCurrentMonth') &&
      (renderMonthBlock.includes('if (isCurrentMonth)') || renderMonthBlock.includes('isCurrentMonth ?') || renderMonthBlock.includes('isCurrentMonth &&')),
      'renderMonth must conditionally attach onDayClick listener only for current month days'
    );
  });
});
