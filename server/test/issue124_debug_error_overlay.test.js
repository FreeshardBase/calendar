'use strict';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const indexPath = path.resolve(__dirname, '../../public/index.html');

describe('Issue #124 — Production Debug Error Overlay & innerHTML Stack Trace Removal', () => {
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  test('public/index.html contains no debug window.onerror error overlay', () => {
    assert.strictEqual(
      indexContent.includes('window.onerror'),
      false,
      'public/index.html must not contain window.onerror debug handler'
    );
    assert.strictEqual(
      indexContent.includes('Laufzeitfehler'),
      false,
      'public/index.html must not display Laufzeitfehler debug overlay'
    );
  });

  test('public/index.html does not construct unescaped error overlays with innerHTML and error.stack', () => {
    assert.strictEqual(
      indexContent.includes('error.stack'),
      false,
      'public/index.html must not expose error.stack in frontend'
    );
    assert.strictEqual(
      /errDiv\.innerHTML/.test(indexContent),
      false,
      'public/index.html must not use innerHTML to render uncaught runtime errors'
    );
  });
});
