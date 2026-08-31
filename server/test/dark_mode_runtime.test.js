'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  THEME_STORAGE_KEY,
  resolveEffectiveTheme,
  applyTheme,
  setTheme
} = require('../../public/js/theme.js');

test('Issue #104 — Dark Mode Runtime Reachability & CSS Compatibility Suite', async (t) => {
  await t.test('theme.js utility correctly resolves, applies, and persists themes', () => {
    assert.strictEqual(THEME_STORAGE_KEY, 'webcalendar_theme');

    // Test system resolution fallback
    assert.strictEqual(resolveEffectiveTheme('light'), 'light');
    assert.strictEqual(resolveEffectiveTheme('dark'), 'dark');

    // Test DOM manipulation mock
    const fakeClassList = new Set();
    const fakeAttributes = {};
    const fakeDoc = {
      documentElement: {
        setAttribute: (k, v) => { fakeAttributes[k] = v; },
        classList: {
          add: (c) => fakeClassList.add(c),
          remove: (c) => fakeClassList.delete(c)
        }
      }
    };

    applyTheme('dark', fakeDoc);
    assert.strictEqual(fakeAttributes['data-theme'], 'dark');
    assert.ok(fakeClassList.has('theme-dark'));

    applyTheme('light', fakeDoc);
    assert.strictEqual(fakeAttributes['data-theme'], 'light');
    assert.ok(!fakeClassList.has('theme-dark'));
  });

  await t.test('public/index.html includes theme settings drawer section and #theme-select control', () => {
    const htmlPath = path.join(__dirname, '../../public/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(htmlContent.includes('id="theme-select"'), 'index.html must contain #theme-select element');
    assert.ok(htmlContent.includes('value="system"'), 'theme-select must contain system option');
    assert.ok(htmlContent.includes('value="light"'), 'theme-select must contain light option');
    assert.ok(htmlContent.includes('value="dark"'), 'theme-select must contain dark option');
  });

  await t.test('public/css/app.css contains color-scheme: dark and valid dark mode rules without undefined variables', () => {
    const cssPath = path.join(__dirname, '../../public/css/app.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    assert.ok(cssContent.includes('color-scheme: dark'), 'CSS must include color-scheme: dark under data-theme="dark"');

    // Verify undefined custom properties are eliminated
    assert.strictEqual(cssContent.includes('var(--text-main)'), false, 'CSS must not contain undefined var(--text-main)');
    assert.strictEqual(cssContent.includes('var(--bg-canvas)'), false, 'CSS must not contain undefined var(--bg-canvas)');

    // Verify dark mode overrides exist for newest components
    assert.ok(cssContent.includes('[data-theme="dark"] .share-badge'), 'CSS must contain dark mode styling for share badges');
    assert.ok(cssContent.includes('[data-theme="dark"] .status-accepted'), 'CSS must contain dark mode styling for invitation status badges');
    assert.ok(cssContent.includes('[data-theme="dark"] .prio-high'), 'CSS must contain dark mode styling for kanban priority tags');
  });

  await t.test('public/js/app.js references theme module', () => {
    const appJsPath = path.join(__dirname, '../../public/js/app.js');
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(appJsContent.includes('initTheme'), 'app.js must call initTheme');
    assert.ok(appJsContent.includes('theme-select'), 'app.js must bind #theme-select change listener');
  });
});
