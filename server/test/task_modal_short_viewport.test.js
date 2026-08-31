const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #85 — Task Modal Short Viewport Layout & Control Reachability Guard', async (t) => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  const htmlPath = path.join(__dirname, '../../public/index.html');

  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  await t.test('index.html contains #task-modal with form, modal-body, and modal-footer elements', () => {
    assert.ok(htmlContent.includes('id="task-modal"'), '#task-modal element must exist');
    assert.ok(htmlContent.includes('id="task-form"'), '#task-form element must exist');
    assert.ok(htmlContent.includes('id="task-save-btn"'), '#task-save-btn element must exist');
    assert.ok(htmlContent.includes('id="task-cancel-btn"'), '#task-cancel-btn element must exist');
  });

  await t.test('app.css defines flex layout for .modal form so children flex-shrink and scroll inside modal max-height', () => {
    assert.ok(cssContent.includes('.modal form'), '.modal form selector must exist in app.css');
    const modalFormMatch = cssContent.match(/\.modal\s+form\s*\{([^}]+)\}/);
    assert.ok(modalFormMatch, '.modal form CSS block must be present');
    const rules = modalFormMatch[1];
    assert.ok(rules.includes('display: flex') || rules.includes('display:flex'), '.modal form must use flexbox');
    assert.ok(rules.includes('flex-direction: column') || rules.includes('flex-direction:column'), '.modal form must use column flex-direction');
    assert.ok(rules.includes('min-height: 0') || rules.includes('min-height:0'), '.modal form must set min-height: 0 to allow body scroll');
  });

  await t.test('app.css defines .modal-footer with flex-shrink: 0 to keep action buttons pinned and visible', () => {
    assert.ok(cssContent.includes('.modal-footer'), '.modal-footer selector must exist in app.css');
    const footerMatch = cssContent.match(/\.modal-footer\s*\{([^}]+)\}/);
    assert.ok(footerMatch, '.modal-footer CSS block must be present');
    const rules = footerMatch[1];
    assert.ok(rules.includes('flex-shrink: 0') || rules.includes('flex-shrink:0'), '.modal-footer must set flex-shrink: 0');
    assert.ok(rules.includes('display: flex') || rules.includes('display:flex'), '.modal-footer must use flexbox');
  });
});
