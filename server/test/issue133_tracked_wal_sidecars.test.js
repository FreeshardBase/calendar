'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '../..');

test('Issue #133 — No tracked SQLite database files or WAL/SHM sidecars in git index', () => {
  let trackedFiles = [];
  try {
    const stdout = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8' });
    trackedFiles = stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    assert.fail(`Failed to execute git ls-files: ${err.message}`);
  }

  const trackedDbFiles = trackedFiles.filter(file => {
    const base = path.basename(file);
    return base.startsWith('webcalendar.db') ||
           base.endsWith('.db') ||
           base.endsWith('.db-wal') ||
           base.endsWith('.db-shm') ||
           base.endsWith('.sqlite') ||
           base.endsWith('.sqlite-wal') ||
           base.endsWith('.sqlite-shm');
  });

  assert.strictEqual(
    trackedDbFiles.length,
    0,
    `Found tracked SQLite database/WAL sidecar files in git index:\n${trackedDbFiles.join('\n')}`
  );
});

test('Issue #133 — .gitignore includes database and WAL sidecar patterns', () => {
  const gitignorePath = path.join(rootDir, '.gitignore');
  assert.ok(fs.existsSync(gitignorePath), '.gitignore file must exist');

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  const hasDbWildcard = lines.includes('webcalendar.db*') || lines.includes('*.db*');
  const hasWalPattern = lines.includes('*.db-wal') || lines.includes('webcalendar.db*') || lines.includes('*.db*');
  const hasShmPattern = lines.includes('*.db-shm') || lines.includes('webcalendar.db*') || lines.includes('*.db*');

  assert.ok(hasDbWildcard || lines.includes('*.db'), '.gitignore must ignore *.db or webcalendar.db*');
  assert.ok(hasWalPattern, '.gitignore must ignore WAL sidecar files (*.db-wal or webcalendar.db*)');
  assert.ok(hasShmPattern, '.gitignore must ignore SHM sidecar files (*.db-shm or webcalendar.db*)');
});
