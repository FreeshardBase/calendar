const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #86 — .btn-danger and .btn-success design system outline styling', () => {
  const cssPath = path.join(process.cwd(), 'public', 'css', 'app.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Verify --success token exists in :root
  assert.match(cssContent, /--success:\s*[^;]+;/, ':root must define --success color token');

  // Verify .btn-danger has outline styling in button section
  assert.match(cssContent, /\.btn-danger\s*\{[^}]*border-color:\s*var\(--danger\)/, '.btn-danger must use border-color: var(--danger)');
  assert.match(cssContent, /\.btn-danger\s*\{[^}]*color:\s*var\(--danger\)/, '.btn-danger must use color: var(--danger)');

  // Verify .btn-success has outline styling in button section
  assert.match(cssContent, /\.btn-success\s*\{[^}]*border-color:\s*var\(--success\)/, '.btn-success must use border-color: var(--success)');
  assert.match(cssContent, /\.btn-success\s*\{[^}]*color:\s*var\(--success\)/, '.btn-success must use color: var(--success)');

  // Verify .btn-danger and .btn-success are NOT overwritten with solid fill background or border: none
  assert.doesNotMatch(cssContent, /\.btn-danger\s*\{[^}]*background:\s*#ea4335/, '.btn-danger must not be overwritten with solid #ea4335 background');
  assert.doesNotMatch(cssContent, /\.btn-danger\s*\{[^}]*border:\s*none/, '.btn-danger must not be overwritten with border: none');
  assert.doesNotMatch(cssContent, /\.btn-success\s*\{[^}]*background:\s*#34a853/, '.btn-success must not be overwritten with solid #34a853 background');
  assert.doesNotMatch(cssContent, /\.btn-success\s*\{[^}]*border:\s*none/, '.btn-success must not be overwritten with border: none');
});
