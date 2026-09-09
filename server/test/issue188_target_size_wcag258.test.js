'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appCssPath = path.resolve('public/css/app.css');

test('Issue #188 — WCAG 2.5.8 Minimum Target Size for Action Buttons and Event Chips', async (t) => {
  const appCss = fs.readFileSync(appCssPath, 'utf8');

  await t.test('cal-action-btn meets WCAG 2.5.8 minimum target size of 24px x 24px', () => {
    // Extract .cal-action-btn CSS block
    const match = appCss.match(/\.cal-action-btn\s*\{([^}]+)\}/);
    assert.ok(match, '.cal-action-btn CSS rule must exist in public/css/app.css');
    const block = match[1];

    assert.ok(
      (block.includes('width: 24px') || block.includes('min-width: 24px')) &&
      (block.includes('height: 24px') || block.includes('min-height: 24px')),
      '.cal-action-btn must have width/height or min-width/min-height of at least 24px'
    );
    assert.ok(!block.includes('width: 20px;'), '.cal-action-btn must not retain undersized 20px width');
    assert.ok(!block.includes('height: 20px;'), '.cal-action-btn must not retain undersized 20px height');
  });

  await t.test('event-chip meets WCAG 2.5.8 minimum target height of 24px', () => {
    // Extract .event-chip CSS block
    const match = appCss.match(/\.event-chip\s*\{([^}]+)\}/);
    assert.ok(match, '.event-chip CSS rule must exist in public/css/app.css');
    const block = match[1];

    assert.ok(
      block.includes('min-height: 24px'),
      '.event-chip must specify min-height: 24px to satisfy WCAG 2.5.8'
    );
  });

  await t.test('kanban-btn retains compliant target size (>= 24px)', () => {
    const match = appCss.match(/\.kanban-btn\s*\{([^}]+)\}/);
    assert.ok(match, '.kanban-btn CSS rule must exist in public/css/app.css');
    const block = match[1];

    assert.ok(
      block.includes('min-height: 44px') || block.includes('min-height: 24px'),
      '.kanban-btn must retain compliant target size'
    );
  });
});
