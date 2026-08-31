const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Issue #110 — Stylesheet and Markup Drift Fixes', () => {
  const cssPath = path.join(process.cwd(), 'public/css/app.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const publicDir = path.join(process.cwd(), 'public');

  function getProjectCode() {
    let code = '';
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html') || entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
          code += fs.readFileSync(full, 'utf8') + '\n';
        }
      }
    }
    walk(publicDir);
    return code;
  }

  test('All referenced custom CSS properties are defined in app.css', () => {
    const definedVars = new Set();
    for (const m of cssContent.matchAll(/--[a-zA-Z0-9_-]+(?=\s*:)/g)) {
      definedVars.add(m[0]);
    }

    const allCode = getProjectCode();
    const usedVars = new Set();
    for (const m of allCode.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)) {
      usedVars.add(m[1]);
    }

    const targetUndefinedVars = [
      '--surface-hover',
      '--text-muted',
      '--surface-bg-alt',
      '--radius-card',
      '--radius-sm',
      '--text',
      '--warning'
    ];

    const missingVars = targetUndefinedVars.filter(v => !definedVars.has(v));
    assert.deepStrictEqual(missingVars, [], `Missing custom property definitions in CSS: ${missingVars.join(', ')}`);
  });

  test('Unstyled component classes have CSS definitions in app.css', () => {
    const cssClassSelectors = new Set();
    for (const m of cssContent.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      cssClassSelectors.add(m[1]);
    }

    const requiredClasses = [
      'btn-secondary',
      'popover-attachments',
      'attachment-drive-link',
      'popover-color-bar',
      'popover-meta',
      'popover-actions',
      'toast-icon',
      'toast-msg',
      'toast-close',
      'btn-revoke-share',
      'share-role-toggle',
      'agenda-events',
      'agenda-event-loc'
    ];

    const unstyled = requiredClasses.filter(c => !cssClassSelectors.has(c));
    assert.deepStrictEqual(unstyled, [], `Unstyled component classes missing in CSS: ${unstyled.join(', ')}`);
  });

  test('Obsolete dead CSS selectors are removed from app.css', () => {
    const deadSelectors = [
      '.onboarding-screen',
      '.onboarding-logo-icon',
      '.account-item',
      '.account-remove',
      '.view-switcher',
      '.view-btn',
      '.search-bar',
      '.attendee-info',
      '.popover-header'
    ];

    const presentDeadSelectors = deadSelectors.filter(sel => cssContent.includes(sel));
    assert.deepStrictEqual(presentDeadSelectors, [], `Dead CSS selectors still present in app.css: ${presentDeadSelectors.join(', ')}`);
  });
});
