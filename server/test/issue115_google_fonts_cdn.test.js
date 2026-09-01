'use strict';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const indexPath = path.resolve(__dirname, '../../public/index.html');
const bookingPath = path.resolve(__dirname, '../../public/booking.html');
const cssPath = path.resolve(__dirname, '../../public/css/app.css');

describe('Issue #115 — Google Fonts CDN Removal & Self-Hosting Isolation', () => {
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  const bookingContent = fs.readFileSync(bookingPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  test('public/index.html contains no external Google Fonts CDN links or preconnects', () => {
    assert.strictEqual(
      indexContent.includes('fonts.googleapis.com'),
      false,
      'public/index.html must not reference fonts.googleapis.com'
    );
    assert.strictEqual(
      indexContent.includes('fonts.gstatic.com'),
      false,
      'public/index.html must not reference fonts.gstatic.com'
    );
  });

  test('public/booking.html contains no external Google Fonts CDN links or preconnects', () => {
    assert.strictEqual(
      bookingContent.includes('fonts.googleapis.com'),
      false,
      'public/booking.html must not reference fonts.googleapis.com'
    );
    assert.strictEqual(
      bookingContent.includes('fonts.gstatic.com'),
      false,
      'public/booking.html must not reference fonts.gstatic.com'
    );
  });

  test('app.css provides system font fallbacks for --font-ui and --font-mono', () => {
    assert.ok(
      /--font-ui\s*:\s*[^;]*system-ui/i.test(cssContent) || /--font-ui\s*:\s*[^;]*-apple-system/i.test(cssContent),
      '--font-ui must include system font fallback'
    );
    assert.ok(
      /--font-mono\s*:\s*[^;]*monospace/i.test(cssContent),
      '--font-mono must include monospace system font fallback'
    );
  });
});
