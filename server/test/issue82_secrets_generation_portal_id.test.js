'use strict';

/**
 * Issue #82 — CRITICAL: ENCRYPTION_KEY and SESSION_SECRET must be generated per install
 *
 * Verifies all findings from @ClaydeCode:
 * 1. Both SESSION_SECRET and ENCRYPTION_KEY reject the 103-character rendered portal.id under NODE_ENV=production.
 * 2. .encryption_key and .session_secret files do NOT short-circuit the production guard if they hold weak/default keys.
 * 3. Per-install generation: 32 random bytes generated and persisted when unset, rather than known default literals.
 * 4. SYSTEM_SYNC_SECRET has a production boot check refusing startup / exiting non-zero when unset or default.
 * 5. Python sync_worker.py enforces the same rendered portal.id, key validation, and per-install generation rules.
 * 6. docker-compose.yml supplies no default fallback for SESSION_SECRET.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');
process.env.NODE_ENV = 'test';
const { getSessionConfig, resolveSessionSecret } = require('../utils/sessionConfig');
const { validateEncryptionKey, resolveEncryptionKey } = require('../db');
const { validateSystemSyncSecret } = require('../index');

// 103-character rendered portal.id (Freeshard shard hash ID)
const renderedPortalId = '8271dd' + 'a'.repeat(97);

test.describe('Issue #82 — Per-Install Secrets Generation & Rendered portal.id Rejection', () => {

  test('getSessionConfig rejects 103-character rendered portal.id under NODE_ENV=production', () => {
    assert.equal(renderedPortalId.length, 103);
    assert.throws(
      () => getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: renderedPortalId }),
      /SESSION_SECRET must be explicitly configured/i,
      'getSessionConfig must reject 103-character rendered portal.id in production'
    );
  });

  test('validateEncryptionKey rejects 103-character rendered portal.id under NODE_ENV=production', () => {
    assert.equal(renderedPortalId.length, 103);
    assert.throws(
      () => validateEncryptionKey({ NODE_ENV: 'production', ENCRYPTION_KEY: renderedPortalId }),
      /ENCRYPTION_KEY must be explicitly configured/i,
      'validateEncryptionKey must reject 103-character rendered portal.id in production'
    );
  });

  test('resolveEncryptionKey does NOT short-circuit production guard when .encryption_key holds known default literal', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_test_key_guard_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');

    try {
      fs.writeFileSync(keyFile, 'freeshard-default-encryption-key-do-not-use-in-prod');
      assert.throws(
        () => resolveEncryptionKey({ NODE_ENV: 'production' }, testDbPath),
        /ENCRYPTION_KEY must be explicitly configured/i,
        'resolveEncryptionKey must not bypass production guard when file holds default literal'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveEncryptionKey does NOT short-circuit production guard when .encryption_key holds rendered portal.id', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_test_key_portal_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');

    try {
      fs.writeFileSync(keyFile, renderedPortalId);
      assert.throws(
        () => resolveEncryptionKey({ NODE_ENV: 'production' }, testDbPath),
        /ENCRYPTION_KEY must be explicitly configured/i,
        'resolveEncryptionKey must not bypass production guard when file holds rendered portal.id'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveEncryptionKey generates random 32-byte key per install when unset and persists to file', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_test_key_gen_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');

    try {
      const generatedKey = resolveEncryptionKey({ NODE_ENV: 'development' }, testDbPath);
      assert.notEqual(
        generatedKey,
        'freeshard-default-encryption-key-do-not-use-in-prod',
        'Generated key must not be the known hardcoded literal'
      );
      assert.equal(generatedKey.length, 64, 'Generated key must be 32 random bytes (64 hex characters)');
      assert.ok(fs.existsSync(keyFile), '.encryption_key file must be written to disk');
      const savedKey = fs.readFileSync(keyFile, 'utf8').trim();
      assert.equal(savedKey, generatedKey, 'Saved key file must match returned generated key');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveSessionSecret generates random 32-byte secret per install when unset and persists to file', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_test_session_gen_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const secretFile = path.join(tmpDir, '.session_secret');

    try {
      const generatedSecret = resolveSessionSecret({ NODE_ENV: 'development' }, testDbPath);
      assert.notEqual(
        generatedSecret,
        'freeshard-change-this-in-production',
        'Generated secret must not be the default literal'
      );
      assert.equal(generatedSecret.length, 64, 'Generated secret must be 32 random bytes (64 hex characters)');
      assert.ok(fs.existsSync(secretFile), '.session_secret file must be written to disk');
      const savedSecret = fs.readFileSync(secretFile, 'utf8').trim();
      assert.equal(savedSecret, generatedSecret, 'Saved secret file must match returned generated secret');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveSessionSecret does NOT short-circuit production guard when .session_secret holds default literal or rendered portal.id', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_test_session_guard_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const secretFile = path.join(tmpDir, '.session_secret');

    try {
      fs.writeFileSync(secretFile, 'freeshard-change-this-in-production');
      assert.throws(
        () => resolveSessionSecret({ NODE_ENV: 'production' }, testDbPath),
        /SESSION_SECRET must be explicitly configured/i,
        'resolveSessionSecret must reject default literal in production'
      );

      fs.writeFileSync(secretFile, renderedPortalId);
      assert.throws(
        () => resolveSessionSecret({ NODE_ENV: 'production' }, testDbPath),
        /SESSION_SECRET must be explicitly configured/i,
        'resolveSessionSecret must reject rendered portal.id in production'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('validateSystemSyncSecret rejects missing, default literal, or rendered portal.id in production', () => {
    assert.throws(
      () => validateSystemSyncSecret({ NODE_ENV: 'production', SYSTEM_SYNC_SECRET: '' }),
      /SYSTEM_SYNC_SECRET must be explicitly configured/i
    );
    assert.throws(
      () => validateSystemSyncSecret({ NODE_ENV: 'production', SYSTEM_SYNC_SECRET: 'super-secret-bypass' }),
      /SYSTEM_SYNC_SECRET must be explicitly configured/i
    );
    assert.throws(
      () => validateSystemSyncSecret({ NODE_ENV: 'production', SYSTEM_SYNC_SECRET: renderedPortalId }),
      /SYSTEM_SYNC_SECRET must be explicitly configured/i
    );
    assert.doesNotThrow(
      () => validateSystemSyncSecret({ NODE_ENV: 'production', SYSTEM_SYNC_SECRET: 'a-secure-random-sync-secret-12345678' })
    );
  });

  test('server process exits non-zero on boot in production with missing, change-me, or default SYSTEM_SYNC_SECRET', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_boot_test_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    try {
      const invalidSecrets = [
        { label: 'missing', value: '' },
        { label: 'change-me', value: 'change-me' },
        { label: 'default literal', value: 'super-secret-bypass' },
        { label: 'rendered portal.id', value: renderedPortalId }
      ];

      for (const { label, value } of invalidSecrets) {
        const res = spawnSync('node', ['server/index.js'], {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            DATABASE_PATH: testDbPath,
            PORT: '39999',
            SYSTEM_SYNC_SECRET: value
          }
        });
        assert.equal(res.status, 1, `Server boot must exit code 1 when SYSTEM_SYNC_SECRET is ${label} in production`);
        assert.match(
          res.stderr.toString(),
          /SYSTEM_SYNC_SECRET must be explicitly configured/i,
          `Server boot stderr must log rejection when SYSTEM_SYNC_SECRET is ${label}`
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Python sync_worker.py rejects rendered portal.id and default literal in production', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'scratch_py_test_'));
    const testDbPath = path.join(tmpDir, 'webcalendar.db');
    const keyFile = path.join(tmpDir, '.encryption_key');

    try {
      // 1. Direct rendered portal.id reject
      const pyPortalScript = `
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker
try:
    sync_worker.resolve_encryption_secret({'NODE_ENV': 'production', 'ENCRYPTION_KEY': '${renderedPortalId}'}, '${testDbPath}')
    print('ACCEPTED')
except ValueError as e:
    print('REJECTED')
`;
      const out1 = execSync(`python3 -c "${pyPortalScript.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
      assert.equal(out1, 'REJECTED', 'Python sync_worker must reject rendered portal.id in production');

      // 2. File with default key reject
      fs.writeFileSync(keyFile, 'freeshard-default-encryption-key-do-not-use-in-prod');
      const pyFileScript = `
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker
try:
    sync_worker.resolve_encryption_secret({'NODE_ENV': 'production'}, '${testDbPath}')
    print('ACCEPTED')
except ValueError as e:
    print('REJECTED')
`;
      const out2 = execSync(`python3 -c "${pyFileScript.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
      assert.equal(out2, 'REJECTED', 'Python sync_worker must not bypass production guard when file holds default literal');

      // 3. Per-install generation when unset
      fs.rmSync(keyFile, { force: true });
      const pyGenScript = `
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker
key = sync_worker.resolve_encryption_secret({'NODE_ENV': 'development'}, '${testDbPath}')
print(key)
`;
      const generatedPyKey = execSync(`python3 -c "${pyGenScript.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
      assert.notEqual(generatedPyKey, 'freeshard-default-encryption-key-do-not-use-in-prod');
      assert.equal(generatedPyKey.length, 64, 'Python sync_worker must generate 32 random bytes (64 hex chars)');
      assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), generatedPyKey);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('docker-compose.yml supplies no default :- fallback for SESSION_SECRET', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');
    assert.ok(
      !content.includes('SESSION_SECRET:-'),
      'docker-compose.yml must not supply default :- fallback for SESSION_SECRET'
    );
  });

});
