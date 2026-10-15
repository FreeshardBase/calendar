'use strict';
process.env.NODE_ENV = 'test';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Print View and PDF Export Stylesheet Suite (Issue #22)', async (t) => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  function getPrintBlock(css) {
    const startIndex = css.indexOf('@media print');
    if (startIndex === -1) return '';
    const openBrace = css.indexOf('{', startIndex);
    if (openBrace === -1) return '';
    let depth = 1;
    let idx = openBrace + 1;
    while (idx < css.length && depth > 0) {
      if (css[idx] === '{') depth++;
      else if (css[idx] === '}') depth--;
      idx++;
    }
    return css.slice(openBrace + 1, idx - 1);
  }

  await t.test('app.css includes @media print block', () => {
    assert.ok(cssContent.includes('@media print'), 'app.css must contain @media print query block');
  });

  await t.test('@media print block hides non-printable interactive elements', () => {
    const printCss = getPrintBlock(cssContent);
    assert.ok(printCss, '@media print block must be present');

    const requiredHiddenSelectors = [
      '.sidebar',
      '.toolbar-nav',
      '.view-tabs',
      '.search-wrapper',
      '#export-pdf-btn',
      '#invitations-btn',
      '#availability-btn',
      '#sidebar-toggle',
      '#sidebar-settings-btn',
      '.status-bar',
      '.modal-backdrop',
      '.popover'
    ];

    for (const selector of requiredHiddenSelectors) {
      assert.ok(
        printCss.includes(selector),
        `Print stylesheet must explicitly target '${selector}' for hidden display`
      );
    }

    assert.ok(
      printCss.includes('display: none !important') || printCss.includes('display:none !important'),
      'Print stylesheet must use display: none !important for hidden elements'
    );
  });

  await t.test('@media print block provides page break prevention for grid containers and cards', () => {
    const printCss = getPrintBlock(cssContent);
    assert.ok(printCss, '@media print block must be present');

    const requiredBreakSelectors = [
      '.calendar-container',
      '.month-grid',
      '.week-grid-body',
      '.day-grid-body',
      '.event-chip',
      '.kanban-card',
      '.agenda-event',
      '.month-day'
    ];

    for (const selector of requiredBreakSelectors) {
      assert.ok(
        printCss.includes(selector),
        `Print stylesheet must target '${selector}' for page break prevention`
      );
    }

    assert.ok(
      printCss.includes('break-inside: avoid') || printCss.includes('page-break-inside: avoid'),
      'Print stylesheet must specify break-inside: avoid or page-break-inside: avoid'
    );
  });

  await t.test('@media print enforces high-contrast background and overflow visibility', () => {
    const printCss = getPrintBlock(cssContent);
    assert.ok(printCss, '@media print block must be present');

    assert.ok(
      printCss.includes('background: #ffffff !important') || printCss.includes('background-color: #ffffff !important') || printCss.includes('background: white !important'),
      'Print stylesheet must enforce pure white background for printing'
    );
    assert.ok(
      printCss.includes('color: #000000 !important') || printCss.includes('color: black !important') || printCss.includes('color: #000 !important'),
      'Print stylesheet must enforce high contrast text color for printing'
    );
    assert.ok(
      printCss.includes('overflow: visible !important'),
      'Print stylesheet must set overflow: visible !important to prevent truncated printouts'
    );
  });
});

