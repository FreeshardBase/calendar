'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #202 — Stored XSS & Attribute Injection Prevention in Frontend Select Options & List Rendering', async (t) => {
  await t.test('eventModal.js populates calendar select with escaped id and name', () => {
    const eventModalPath = path.join(__dirname, '../../public/js/eventModal.js');
    const content = fs.readFileSync(eventModalPath, 'utf8');

    // Verify populateCalendarSelect escapes both c.id and c.name
    assert.match(content, /`<option value="\${escHtml\(c\.id\)}"/, 'c.id in option value must be wrapped in escHtml');
    assert.match(content, /\${escHtml\(c\.name\)}/, 'c.name in option label must be wrapped in escHtml');
  });

  await t.test('availability.js populates calendar select and page cards with escaped properties', () => {
    const availPath = path.join(__dirname, '../../public/js/availability.js');
    const content = fs.readFileSync(availPath, 'utf8');

    assert.match(content, /<option value="\${escapeHtml\(c\.id\)}"/, 'c.id in availability option value must be escaped');
    assert.match(content, /\${escapeHtml\(c\.displayName \|\| c\.name \|\| c\.id\)}/, 'calendar name/id in availability option label must be escaped');
    assert.match(content, /data-url="\${escapeHtml\(publicUrl\)}"/, 'publicUrl in availability data-url attribute must be escaped');
    assert.match(content, /data-id="\${escapeHtml\(p\.id\)}"/, 'p.id in availability data-id attribute must be escaped');
  });

  await t.test('delegates.js renders delegate items with escaped properties', () => {
    const delegatesPath = path.join(__dirname, '../../public/js/delegates.js');
    const content = fs.readFileSync(delegatesPath, 'utf8');

    assert.match(content, /data-id="\${escHtml\(d\.id\)}"/, 'd.id in delegate card data-id attribute must be escaped');
    assert.match(content, /\${escHtml\(d\.delegate_user_id\)}/, 'd.delegate_user_id in delegate card label must be escaped');
    assert.match(content, /\${escHtml\(d\.role\)}/, 'd.role in delegate card label must be escaped');
  });
});
