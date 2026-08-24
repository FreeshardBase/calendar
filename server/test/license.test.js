'use strict';

/**
 * Issue #33 — Add a LICENSE file
 *
 * Validates that repository has a LICENSE file and package.json specifies license metadata.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #33 — Add a LICENSE file', () => {

  test('LICENSE or LICENSE.md exists in repository root', () => {
    const licensePath = path.join(ROOT_DIR, 'LICENSE');
    const licenseMdPath = path.join(ROOT_DIR, 'LICENSE.md');
    const exists = fs.existsSync(licensePath) || fs.existsSync(licenseMdPath);
    assert.ok(exists, 'LICENSE or LICENSE.md file must exist in repository root');
  });

  test('LICENSE file is non-empty and contains valid legal text', () => {
    const licensePath = fs.existsSync(path.join(ROOT_DIR, 'LICENSE'))
      ? path.join(ROOT_DIR, 'LICENSE')
      : path.join(ROOT_DIR, 'LICENSE.md');

    assert.ok(fs.existsSync(licensePath), 'LICENSE file must exist');
    const content = fs.readFileSync(licensePath, 'utf8');
    assert.ok(content.trim().length > 100, 'LICENSE content must not be trivial or empty');
    assert.ok(
      content.includes('Terms and Conditions') ||
      content.includes('Copyright') ||
      content.includes('License') ||
      content.includes('MIT License') ||
      content.includes('Apache License'),
      'LICENSE file must contain standard license legal terms'
    );
  });

  test('package.json contains a license field', () => {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.ok(pkg.license, 'package.json must contain a "license" field');
    assert.ok(typeof pkg.license === 'string' && pkg.license.length > 0, 'package.json "license" must be a non-empty string');
  });

});
