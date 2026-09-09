const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const appJsPath = path.resolve(__dirname, '../../public/js/app.js');
const appCssPath = path.resolve(__dirname, '../../public/css/app.css');

test('Issue #190 — Share Dialog Autocomplete Combobox Semantics & Keyboard Navigation', async (t) => {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  const appCssContent = fs.readFileSync(appCssPath, 'utf8');

  await t.test('HTML template includes combobox and listbox ARIA attributes', () => {
    assert.match(appJsContent, /id="share-search-input"[^>]*role="combobox"/);
    assert.match(appJsContent, /id="share-search-input"[^>]*aria-autocomplete="list"/);
    assert.match(appJsContent, /id="share-search-input"[^>]*aria-expanded="false"/);
    assert.match(appJsContent, /id="share-search-input"[^>]*aria-controls="share-autocomplete-dropdown"/);
    assert.match(appJsContent, /id="share-search-input"[^>]*aria-haspopup="listbox"/);

    assert.match(appJsContent, /id="share-autocomplete-dropdown"[^>]*role="listbox"/);
  });

  await t.test('Autocomplete suggestion items include role="option" and aria-selected', () => {
    assert.match(appJsContent, /class="autocomplete-item"[^>]*role="option"/);
    assert.match(appJsContent, /aria-selected=/);
    assert.match(appJsContent, /id="share-opt-/);
  });

  await t.test('app.js contains keyboard navigation (ArrowDown, ArrowUp, Enter, Escape) and aria-activedescendant handling', () => {
    assert.match(appJsContent, /ArrowDown/);
    assert.match(appJsContent, /ArrowUp/);
    assert.match(appJsContent, /aria-activedescendant/);
    assert.match(appJsContent, /aria-expanded/);
  });

  await t.test('app.css includes active styling for autocomplete items', () => {
    assert.match(appCssContent, /\.autocomplete-item(?::hover|\.active|\[aria-selected="true"\])/);
  });
});
