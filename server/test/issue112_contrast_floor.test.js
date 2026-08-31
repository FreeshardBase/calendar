'use strict';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');
const cssPath = path.resolve(__dirname, '../../public/css/app.css');

describe('Issue #112 — Contrast Floor for Event Chips and Adjacent-Month Day Numbers', () => {
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  test('.mini-cal-day.other-month does not use low-contrast var(--border-cool)', () => {
    const match = cssContent.match(/\.mini-cal-day\.other-month\s*\{([^}]+)\}/);
    assert.ok(match, '.mini-cal-day.other-month CSS rule must exist');
    const ruleBody = match[1];
    assert.strictEqual(
      ruleBody.includes('var(--border-cool)'),
      false,
      '.mini-cal-day.other-month must not use var(--border-cool) which lacks contrast floor'
    );
    assert.ok(
      ruleBody.includes('var(--ink-muted)') || ruleBody.includes('var(--text-muted)'),
      '.mini-cal-day.other-month must use a readable ink/text color'
    );
  });

  test('.month-day.other-month has contrast floor opacity >= 0.70', () => {
    const match = cssContent.match(/\.month-day\.other-month\s*\{([^}]+)\}/);
    assert.ok(match, '.month-day.other-month CSS rule must exist');
    const opacityMatch = match[1].match(/opacity:\s*([0-9.]+)/);
    assert.ok(opacityMatch, '.month-day.other-month must specify opacity');
    const opacity = parseFloat(opacityMatch[1]);
    assert.ok(
      opacity >= 0.70,
      `.month-day.other-month opacity (${opacity}) must be >= 0.70 to maintain contrast floor`
    );
  });

  test('ensureContrastFloor function exists and enforces contrast floor >= 4.5:1', () => {
    assert.ok(
      calendarJs.includes('ensureContrastFloor'),
      'calendar.js must implement ensureContrastFloor helper function'
    );

    const sanitizeColorMatch = calendarJs.match(/export\s+function\s+sanitizeColor\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
    const ensureContrastFloorMatch = calendarJs.match(/export\s+function\s+ensureContrastFloor\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);

    assert.ok(sanitizeColorMatch, 'sanitizeColor function must exist');
    assert.ok(ensureContrastFloorMatch, 'ensureContrastFloor function must exist');

    const evalFn = new Function('color', 'bgAlpha', `
      ${sanitizeColorMatch[0].replace('export ', '')}
      ${calendarJs.match(/function parseHexColor[\s\S]*?\n\}/)?.[0] || ''}
      ${calendarJs.match(/function getRelativeLuminance[\s\S]*?\n\}/)?.[0] || ''}
      ${calendarJs.match(/function getContrastRatio[\s\S]*?\n\}/)?.[0] || ''}
      ${ensureContrastFloorMatch[0].replace('export ', '')}
      return ensureContrastFloor(color, bgAlpha);
    `);

    const testColors = ['#6366f1', '#f59e0b', '#ffff00', '#ffffff', '#007080', '#e0e0e0'];
    for (const color of testColors) {
      const textColor = evalFn(color, 0.22);
      assert.ok(textColor, `ensureContrastFloor must return a valid color for ${color}`);

      const hex = textColor.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const textLum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

      const origClean = color.startsWith('#') && (color.length === 7) ? color : '#6366f1';
      const origR = parseInt(origClean.slice(1, 3), 16);
      const origG = parseInt(origClean.slice(3, 5), 16);
      const origB = parseInt(origClean.slice(5, 7), 16);

      const bgR = Math.round(0.78 * 255 + 0.22 * origR);
      const bgG = Math.round(0.78 * 254 + 0.22 * origG);
      const bgB = Math.round(0.78 * 251 + 0.22 * origB);

      const bgLum = 0.2126 * toLinear(bgR) + 0.7152 * toLinear(bgG) + 0.0722 * toLinear(bgB);

      const l1 = Math.max(textLum, bgLum);
      const l2 = Math.min(textLum, bgLum);
      const ratio = (l1 + 0.05) / (l2 + 0.05);

      assert.ok(
        ratio >= 4.5,
        `Color ${color} -> text ${textColor} contrast ratio (${ratio.toFixed(2)}) must be >= 4.5`
      );
    }
  });

  test('chipHtml and createEventBlock call ensureContrastFloor in calendar.js', () => {
    assert.ok(
      /chipHtml[\s\S]*?ensureContrastFloor/.test(calendarJs),
      'chipHtml must invoke ensureContrastFloor for event chip text color'
    );
    assert.ok(
      /createEventBlock[\s\S]*?ensureContrastFloor/.test(calendarJs),
      'createEventBlock must invoke ensureContrastFloor for event block text color'
    );
  });
});
