'use strict';

/**
 * Issue #322 — App & Sync-Worker Encryption Key Alignment
 *
 * Verifies that Node.js app (server/db.js) and Python daemon (sync-worker/sync_worker.py):
 *   1. Resolve ENCRYPTION_KEY and ENCRYPTION_SECRET with identical precedence, and both refuse the
 *      old built-in default key in production.
 *   2. Shared docker-compose.yml configuration passes ENCRYPTION_KEY into both webcalendar and sync-worker.
 *   3. Stored values (AES-256-GCM under scrypt(secret, per-value salt), see #72) are interoperable
 *      across Node.js and Python.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const { encryptForSecret } = require('./helpers/storedCiphertext');
const sharedTestDbKeyEnv = require('./helpers/sharedTestDbKeyEnv');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #322 — App & Sync-Worker Encryption Key Alignment', () => {

  test('docker-compose.yml sets ENCRYPTION_KEY environment for both webcalendar and sync-worker', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    const webcalendarIdx = content.indexOf('\n  webcalendar:');
    const caldavIdx = content.indexOf('\n  caldav-server:');
    const syncWorkerIdx = content.indexOf('\n  sync-worker:');

    const webcalendarSection = content.substring(webcalendarIdx, caldavIdx);
    const syncWorkerSection = content.substring(syncWorkerIdx);

    assert.ok(
      webcalendarSection.includes('ENCRYPTION_KEY:'),
      'webcalendar service in docker-compose.yml must declare ENCRYPTION_KEY environment variable'
    );
    assert.ok(
      syncWorkerSection.includes('ENCRYPTION_KEY:'),
      'sync-worker service in docker-compose.yml must declare ENCRYPTION_KEY environment variable'
    );
  });

  // Each case resolves the install secret on a fresh install under NODE_ENV=production, in
  // server/db.js and in sync_worker.py; both must pick the same secret or refuse alike.
  const KEY = 'testuser-encryption-key-0123456789abcdef0123456789';
  const SECRET = 'testuser-encryption-secret-fedcba9876543210fedcba';
  const KEY_CASES = [
    { label: 'ENCRYPTION_SECRET alone', env: { ENCRYPTION_SECRET: SECRET }, expected: SECRET },
    { label: 'ENCRYPTION_KEY alone', env: { ENCRYPTION_KEY: KEY }, expected: KEY },
    { label: 'both, ENCRYPTION_KEY wins', env: { ENCRYPTION_KEY: KEY, ENCRYPTION_SECRET: SECRET }, expected: KEY },
    { label: 'the old built-in default key', env: { ENCRYPTION_KEY: 'freeshard-default-encryption-key-do-not-use-in-prod' }, expected: 'REJECTED' },
    { label: 'the old built-in default as ENCRYPTION_SECRET', env: { ENCRYPTION_SECRET: 'freeshard-default-encryption-key-do-not-use-in-prod' }, expected: 'REJECTED' },
  ];

  function freshInstall(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-alignment-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dbPath: path.join(dir, 'webcalendar.db'), keyFile: path.join(dir, '.encryption_key') };
  }

  function nodeResolve(env, dbPath) {
    const { resolveEncryptionKey } = require('../db');
    try {
      return resolveEncryptionKey(env, dbPath);
    } catch (err) {
      assert.match(err.message, /ENCRYPTION_KEY must be explicitly configured/);
      return 'REJECTED';
    }
  }

  function pythonResolve(env, dbPath) {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT_DIR, 'sync-worker'))})`,
      'import sync_worker',
      'env, db_path = json.loads(sys.argv[1]), sys.argv[2]',
      'try:',
      '    print(sync_worker.resolve_encryption_secret(env, db_path))',
      'except ValueError as e:',
      '    print("REJECTED")',
    ].join('\n');
    const r = spawnSync('python3', ['-c', script, JSON.stringify(env), dbPath], {
      env: { ...process.env, ...sharedTestDbKeyEnv }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n').pop();
  }

  for (const { label, env, expected } of KEY_CASES) {
    test(`server/db.js and sync_worker.py resolve the same secret: ${label}`, (t) => {
      const node = freshInstall(t);
      const nodeEnv = { NODE_ENV: 'production', ENCRYPTION_KEY_FILE: node.keyFile, ...env };
      assert.equal(nodeResolve(nodeEnv, node.dbPath), expected, 'server/db.js');

      const py = freshInstall(t);
      const pyEnv = { NODE_ENV: 'production', ENCRYPTION_KEY_FILE: py.keyFile, ...env };
      assert.equal(pythonResolve(pyEnv, py.dbPath), expected, 'sync_worker.py');
    });
  }

  test('a value in the shared AES-256-GCM format is decrypted by the Python sync_worker decrypt routine', () => {
    const secret = 'custom-test-secret-key-32-chars!!';
    const plaintext = 'sensitive-oauth-refresh-token-xyz789';
    const { ciphertext: encryptedHex, iv } = encryptForSecret(secret, plaintext);

    const pyScript = `
import os
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker

key = sync_worker.key_material('${secret}')
decrypted = sync_worker.decrypt('${encryptedHex}', '${iv}', key)
print(decrypted)
`;

    const pythonOutput = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8'
    }).trim();

    assert.equal(pythonOutput, plaintext, 'Python sync_worker must correctly decrypt Node.js encrypted credentials');
  });

  test('Python sync_worker raises exception on encryption key mismatch instead of returning empty string', () => {
    const secretApp = 'freeshard-app-encryption-key-1';
    const secretWorkerWrong = 'freeshard-worker-wrong-key-2';
    const plaintext = 'sensitive-oauth-refresh-token-999';

    const { ciphertext: encryptedHex, iv } = encryptForSecret(secretApp, plaintext);

    const pyScript = `
import os
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker

key_wrong = sync_worker.key_material('${secretWorkerWrong}')
try:
    decrypted = sync_worker.decrypt('${encryptedHex}', '${iv}', key_wrong)
    print("UNEXPECTED_SUCCESS:" + str(decrypted))
except Exception as e:
    print("RAISED_ERROR:" + type(e).__name__)
`;

    const pythonOutput = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8'
    }).trim();

    assert.ok(pythonOutput.startsWith('RAISED_ERROR:'), 'Python sync_worker must raise an exception on key mismatch rather than returning empty string');
  });

});
