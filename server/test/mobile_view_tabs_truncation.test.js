const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #83 — Mobile View Tabs Accessibility & Toolbar Title Truncation Guard', async (t) => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  const htmlPath = path.join(__dirname, '../../public/index.html');

  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  await t.test('HTML contains header.toolbar and zero references to app-header', () => {
    assert.strictEqual(htmlContent.includes('class="app-header"'), false, 'HTML should not contain non-existent app-header class');
    assert.ok(htmlContent.includes('<header class="toolbar">'), 'HTML must contain header.toolbar');
  });

  await t.test('CSS mobile media query targets .toolbar .view-tabs instead of dead .app-header .view-tabs', () => {
    // Locate @media (max-width: 768px) block
    const mobileMediaIdx = cssContent.indexOf('@media (max-width: 768px)');
    assert.ok(mobileMediaIdx !== -1, '@media (max-width: 768px) block must exist in app.css');

    const mobileCss = cssContent.slice(mobileMediaIdx, cssContent.indexOf('/* ── ICS Import Dropzone', mobileMediaIdx));

    assert.strictEqual(mobileCss.includes('.app-header'), false, 'Mobile CSS block must not contain dead .app-header selectors');
    assert.ok(mobileCss.includes('.toolbar .view-tabs'), 'Mobile CSS block must target .toolbar .view-tabs');
    assert.ok(mobileCss.includes('.toolbar .view-tab'), 'Mobile CSS block must target .toolbar .view-tab');
    assert.ok(mobileCss.includes('.toolbar .search-wrapper'), 'Mobile CSS block must target .toolbar .search-wrapper');
  });

  await t.test('Mobile toolbar CSS configures 3-row grid layout and spans view-tabs across full width', () => {
    const mobileMediaIdx = cssContent.indexOf('@media (max-width: 768px)');
    const mobileCss = cssContent.slice(mobileMediaIdx, cssContent.indexOf('/* ── ICS Import Dropzone', mobileMediaIdx));

    assert.ok(mobileCss.includes('grid-column: 1 / span 3') || mobileCss.includes('grid-column: 1 / -1'), 'view-tabs must span all grid columns in mobile toolbar');
    assert.ok(mobileCss.includes('grid-row: 2'), 'view-tabs must be positioned in grid row 2 in mobile toolbar');
  });

  await t.test('Extra desktop toolbar controls are hidden on mobile to prevent title column squeezing', () => {
    const mobileMediaIdx = cssContent.indexOf('@media (max-width: 768px)');
    const mobileCss = cssContent.slice(mobileMediaIdx, cssContent.indexOf('/* ── ICS Import Dropzone', mobileMediaIdx));

    // Ensure extra action buttons and tz selector don't overcrowd Row 1 grid
    const hidesExtraBtns = mobileCss.includes('display: none') &&
      (mobileCss.includes('#export-pdf-btn') || mobileCss.includes('.toolbar-btn:not') || mobileCss.includes('.toolbar-tz-select-wrapper'));
    assert.ok(hidesExtraBtns, 'Extra desktop toolbar controls must be hidden or isolated in mobile header to protect title space');
  });
});
