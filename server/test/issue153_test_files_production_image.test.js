'use strict';

/**
 * Issue #153 — LOW: eleven test files ship inside the production image
 *
 * Validates that test files and directories are excluded from production Docker builds:
 *   1. .dockerignore ignores `server/test/` directory.
 *   2. .dockerignore ignores `e2e/` directory.
 *   3. .dockerignore ignores test file patterns `*.test.js` and `*.spec.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #153 — Test Files Production Image Exclusion', () => {

  test('.dockerignore includes test directory and file exclusion patterns', () => {
    const ignorePath = path.join(ROOT_DIR, '.dockerignore');
    assert.ok(fs.existsSync(ignorePath), '.dockerignore must exist in repository root');
    const content = fs.readFileSync(ignorePath, 'utf8');

    assert.ok(
      content.includes('server/test/') || content.includes('server/test'),
      '.dockerignore must ignore server/test/ directory'
    );
    assert.ok(
      content.includes('e2e/') || content.includes('e2e'),
      '.dockerignore must ignore e2e/ directory'
    );
    assert.ok(
      content.includes('*.test.js'),
      '.dockerignore must ignore *.test.js files'
    );
    assert.ok(
      content.includes('*.spec.js'),
      '.dockerignore must ignore *.spec.js files'
    );
  });

});
