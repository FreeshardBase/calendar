'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontendModule(filePath, mockGlobals = {}) {
  let code = fs.readFileSync(filePath, 'utf8');
  code = code.replace(/^\s*import\s+[^;]+;/gm, '');
  code = code.replace(/^\s*export\s+(async\s+)?function\s+/gm, '$1function ');
  code = code.replace(/^\s*export\s+const\s+/gm, 'const ');
  code = code.replace(/^\s*export\s+let\s+/gm, 'let ');

  const context = {
    console,
    Date,
    Array,
    String,
    RegExp,
    parseInt,
    document: {
      getElementById: () => null,
      createElement: () => ({
        style: {},
        dataset: {},
        setAttribute: function(key, val) { this[key] = val; },
        getAttribute: function(key) { return this[key]; },
        addEventListener: () => {}
      })
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    exports: {},
    module: { exports: {} },
    ...mockGlobals
  };
  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(code, context);

  return context;
}

const calendarJsPath = path.resolve('public/js/calendar.js');

test('Issue #275 — Mini-Calendar Month-Navigation Buttons Accessible Names', async (t) => {
  const mod = loadFrontendModule(calendarJsPath, {
    MONTHS: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    sameDay: () => false,
    escHtml: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  });

  await t.test('renderMiniCalendar sets accessible aria-label on data-mini-prev and data-mini-next buttons', () => {
    let renderedHtml = '';
    const mockContainer = {
      set innerHTML(val) { renderedHtml = val; },
      get innerHTML() { return renderedHtml; },
      querySelectorAll: () => [],
      querySelector: () => null
    };

    mod.renderMiniCalendar(mockContainer, new Date('2026-09-10T00:00:00Z'), [], () => {});

    assert.ok(renderedHtml.includes('data-mini-prev'), 'mini calendar must render data-mini-prev button');
    assert.ok(renderedHtml.includes('data-mini-next'), 'mini calendar must render data-mini-next button');

    assert.ok(
      renderedHtml.includes('<button data-mini-prev aria-label="Vorheriger Monat"') ||
      renderedHtml.includes('<button data-mini-prev aria-label=\'Vorheriger Monat\'') ||
      /data-mini-prev[^>]*aria-label="Vorheriger Monat"/.test(renderedHtml),
      `data-mini-prev button must carry aria-label="Vorheriger Monat" (got: ${renderedHtml})`
    );

    assert.ok(
      renderedHtml.includes('<button data-mini-next aria-label="Nächster Monat"') ||
      renderedHtml.includes('<button data-mini-next aria-label=\'Nächster Monat\'') ||
      /data-mini-next[^>]*aria-label="Nächster Monat"/.test(renderedHtml),
      `data-mini-next button must carry aria-label="Nächster Monat" (got: ${renderedHtml})`
    );
  });
});
