'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BINARY_EXTENSIONS = new Set([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3',
  '.pyc', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.exe', '.so', '.dll', '.dylib', '.woff', '.woff2', '.ttf', '.eot'
]);

function isBinaryFile(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  try {
    const fd = fs.openSync(fullPath, 'r');
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  } catch (_) {
    // If opening or reading fails, skip or let caller handle
  }
  return false;
}

function walkDir(currentDir, rootDir) {
  let files = [];
  const ignoreDirs = new Set(['.git', 'node_modules', 'sessions', 'test-results', 'playwright-report', 'coverage', 'dist', 'build', '.cache', '__pycache__']);
  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          files = files.concat(walkDir(full, rootDir));
        }
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, full));
      }
    }
  } catch (_) {}
  return files;
}

test('Security & Anonymization Audit: Repository contains no personal identifiers', (t) => {
  const rootDir = path.join(__dirname, '../..');
  const forbiddenPatterns = [
    /aaron/i,
    /gryzia/i
  ];

  // Get tracked files via git ls-files, or fallback to filesystem walk if not in git repo
  let trackedFiles = [];
  try {
    const stdout = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    trackedFiles = stdout.trim().split('\n').filter(Boolean);
  } catch (_) {
    trackedFiles = walkDir(rootDir, rootDir);
  }

  // Also include .env if present
  if (fs.existsSync(path.join(rootDir, '.env'))) {
    trackedFiles.push('.env');
  }

  const violations = [];

  for (const relativePath of trackedFiles) {
    if (relativePath.includes('anonymization.test.js') || relativePath.includes('issue251_anonymization_audit_resilience.test.js')) continue;
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) continue;

    // Skip binary files (e.g. SQLite DB/WAL, compiled bytecode, images)
    if (isBinaryFile(fullPath)) continue;

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

module.exports = {
  isBinaryFile,
  walkDir
};

