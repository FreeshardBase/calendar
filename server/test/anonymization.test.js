'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('Security & Anonymization Audit: Repository contains no personal identifiers', (t) => {
  const rootDir = path.join(__dirname, '../..');
  const forbiddenPatterns = [
    /aaron/i,
    /gryzia/i
  ];

  // Get tracked files via git ls-files
  let trackedFiles = [];
  try {
    const stdout = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8' });
    trackedFiles = stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    assert.fail(`Failed to list tracked files: ${err.message}`);
  }

  // Also include .env if present
  if (fs.existsSync(path.join(rootDir, '.env'))) {
    trackedFiles.push('.env');
  }

  const violations = [];

  for (const relativePath of trackedFiles) {
    if (relativePath.includes('anonymization.test.js')) continue;
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) continue;

    // Skip binary files except sqlite db where text search applies
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) continue;

    const content = fs.readFileSync(fullPath, 'utf8');

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        violations.push(`${relativePath} matched forbidden pattern ${pattern}`);
      }
    }
  }

  assert.strictEqual(
    violations.length,
    0,
    `Found anonymization violations in repository:\n${violations.join('\n')}`
  );
});
