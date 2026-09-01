'use strict';

/**
 * Issue #137 — Credential Encryption Key Persistence & Restore Preservation
 *
 * Verifies that:
 *   1. Encryption key is persisted to `.encryption_key` in database directory (or ENCRYPTION_KEY_FILE).
 *   2. When restoring a database backup to a new shard with a different ENCRYPTION_KEY environment variable,
 *      the persisted `.encryption_key` file is loaded so encrypted credentials remain decryptable.
 *   3. Both server/db.js and sync-worker/sync_worker.py resolve encryption key consistently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const { resolveEncryptionKey, validateEncryptionKey } = require('../db');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #137 — Credential Encryption Key Restore Preservation', () => {

  test('resolveEncryptionKey persists ENCRYPTION_KEY to .encryption_key file in database directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_key_test_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const expectedKeyFile = path.join(tmpDir, '.encryption_key');
    const secretKey = 'test-shard-initial-secret-key-32chars!';

    try {
      const key = resolveEncryptionKey({ ENCRYPTION_KEY: secretKey }, testDbPath);
      assert.equal(key, secretKey);
      assert.ok(fs.existsSync(expectedKeyFile), '.encryption_key file must be created');
      const savedKey = fs.readFileSync(expectedKeyFile, 'utf8').trim();
      assert.equal(savedKey, secretKey, 'Saved key file content must match initial ENCRYPTION_KEY');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveEncryptionKey prioritizes restored .encryption_key over new shard ENCRYPTION_KEY environment variable', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_restore_test_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');

    const originalShardKey = 'original-shard-secret-key-12345';
    const newShardKey = 'new-shard-different-secret-key-67890';

    try {
      // Simulate restored .encryption_key file
      fs.writeFileSync(keyFile, originalShardKey, 'utf8');

      // Resolve key on new shard with different environment ENCRYPTION_KEY
      const resolvedKey = resolveEncryptionKey({ ENCRYPTION_KEY: newShardKey }, testDbPath);
      assert.equal(resolvedKey, originalShardKey, 'Resolved key must come from restored .encryption_key file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Python sync_worker.py resolves encryption key from .encryption_key file', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_py_key_test_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');
    const originalKey = 'persisted-key-from-backup-12345678';

    try {
      fs.writeFileSync(keyFile, originalKey, 'utf8');

      const pyScript = `
import os
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker

key_secret = sync_worker.resolve_encryption_secret({'ENCRYPTION_KEY': 'different-env-key'}, '${testDbPath}')
print(key_secret)
`;

      const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8'
      }).trim();

      assert.equal(output, originalKey, 'Python sync_worker must resolve encryption key from .encryption_key file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
