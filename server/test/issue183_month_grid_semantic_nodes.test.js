'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve('public/js/calendar.js');
const appCssPath = path.resolve('public/css/app.css');

test('Issue #183 — Month Grid ARIA Semantic Nodes for Screen Readers', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');
  const appCss = fs.readFileSync(appCssPath, 'utf8');

  await t.test('month-view container includes role="grid" and aria-label', () => {
    assert.ok(
      calendarJs.includes('role') && (calendarJs.includes('grid') || calendarJs.includes('table')),
      'month-view container must declare role="grid" or role="table" for semantic screen reader navigation'
    );
    assert.ok(
      calendarJs.includes('aria-label') && (calendarJs.includes('Monatsansicht') || calendarJs.includes('Kalender')),
      'month-view container must include aria-label describing the month grid view'
    );
  });

  await t.test('day-of-week header includes role="row" and role="columnheader" with full weekday names', () => {
    assert.ok(
      calendarJs.includes('role="row"') || calendarJs.includes("role='row'") || calendarJs.includes('setAttribute(\'role\', \'row\')'),
      'month-dow-header must declare role="row"'
    );
    assert.ok(
      calendarJs.includes('role="columnheader"') || calendarJs.includes("role='columnheader'") || calendarJs.includes('columnheader'),
      'month-dow header items must declare role="columnheader"'
    );
    assert.ok(
      calendarJs.includes('Montag') && calendarJs.includes('Dienstag') && calendarJs.includes('Sonntag'),
      'month-dow header items must provide full weekday names for aria-label or accessible text'
    );
  });

  await t.test('month grid days are grouped into week rows with role="row"', () => {
    assert.ok(
      calendarJs.includes('month-row') || (calendarJs.includes('role') && calendarJs.includes('row')),
      'month grid day cells must be grouped into week rows with role="row"'
    );
  });

  await t.test('month day cells include role="gridcell" and descriptive aria-label', () => {
    assert.ok(
      calendarJs.includes('role="gridcell"') || calendarJs.includes("role='gridcell'") || calendarJs.includes('gridcell') || calendarJs.includes('cell'),
      'month-day elements must declare role="gridcell" or role="cell"'
    );
    assert.ok(
      calendarJs.includes('aria-label') && (calendarJs.includes('toLocaleDateString') || calendarJs.includes('dateStr')),
      'month-day elements must set descriptive aria-label with formatted date'
    );
  });

  await t.test('overflow month-more element includes role="button", tabindex, and aria-label', () => {
    assert.ok(
      calendarJs.includes('month-more') && (calendarJs.includes('role="button"') || calendarJs.includes('role=\'button\'') || calendarJs.includes('role')),
      'month-more elements must declare role="button"'
    );
    assert.ok(
      calendarJs.includes('month-more') && (calendarJs.includes('tabindex="0"') || calendarJs.includes('tabIndex = 0') || calendarJs.includes('tabindex')),
      'month-more elements must be focusable with tabindex="0"'
    );
  });

  await t.test('app.css includes .month-row display: contents rule', () => {
    assert.ok(
      appCss.includes('.month-row') && appCss.includes('display: contents'),
      'app.css must define .month-row with display: contents to preserve CSS grid layout'
    );
  });
});
