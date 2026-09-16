'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isBinaryFile, walkDir } = require('./anonymization.test.js');

test('Issue #251 — Anonymization Audit Resilience & Binary/WAL Skipping', async (t) => {
  await t.test('isBinaryFile correctly identifies binary extensions', () => {
    assert.strictEqual(isBinaryFile('test.db-wal'), true);
    assert.strictEqual(isBinaryFile('webcalendar.db'), true);
    assert.strictEqual(isBinaryFile('script.pyc'), true);
    assert.strictEqual(isBinaryFile('image.png'), true);
    assert.strictEqual(isBinaryFile('document.pdf'), true);
    assert.strictEqual(isBinaryFile('code.js'), false);
    assert.strictEqual(isBinaryFile('README.md'), false);
  });

  await t.test('isBinaryFile detects null bytes in non-standard binary files', () => {
    const tmpFile = path.join(__dirname, 'tmp_binary_test.bin');
    fs.writeFileSync(tmpFile, Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]));
    try {
      assert.strictEqual(isBinaryFile(tmpFile), true);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  await t.test('walkDir recursively gathers files and ignores .git and node_modules', () => {
    const rootDir = path.join(__dirname, '../..');
    const files = walkDir(rootDir, rootDir);
    assert.ok(Array.isArray(files));
    assert.ok(files.length > 0);
    assert.strictEqual(files.some(f => f.includes('.git/')), false);
    assert.strictEqual(files.some(f => f.includes('node_modules/')), false);
    assert.ok(files.includes('package.json') || files.includes('README.md'));
  });

  await t.test('filesystem walk fallback handles non-git environments gracefully', () => {
    const rootDir = path.join(__dirname, '../..');
    let trackedFiles = [];
    try {
      // Intentionally run an invalid command to force exception and trigger walkDir fallback
      const { execSync } = require('child_process');
      const stdout = execSync('git invalid-command-force-fail', { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      trackedFiles = stdout.trim().split('\n').filter(Boolean);
    } catch (_) {
      trackedFiles = walkDir(rootDir, rootDir);
    }
    assert.ok(Array.isArray(trackedFiles));
    assert.ok(trackedFiles.length > 0);
    assert.ok(trackedFiles.includes('package.json') || trackedFiles.includes('README.md'));
  });
});
