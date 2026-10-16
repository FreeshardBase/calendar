'use strict';
// Issue #104: theme.js resolves, applies and persists the theme. The settings control, the painted
// palette and the reload are covered in the browser (e2e, Issue #104).
const test = require('node:test');
const assert = require('assert');
const {
  THEME_STORAGE_KEY,
  resolveEffectiveTheme,
  applyTheme,
} = require('../../public/js/theme.js');

test('Issue #104 — theme.js correctly resolves and applies themes', () => {
  assert.strictEqual(THEME_STORAGE_KEY, 'webcalendar_theme');

  assert.strictEqual(resolveEffectiveTheme('light'), 'light');
  assert.strictEqual(resolveEffectiveTheme('dark'), 'dark');

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
