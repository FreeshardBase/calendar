'use strict';

/**
 * Issue #322 — App & Sync-Worker Encryption Key Alignment
 *
 * Verifies that Node.js app (server/db.js) and Python daemon (sync-worker/sync_worker.py):
 *   1. Support both ENCRYPTION_KEY and ENCRYPTION_SECRET environment variables with identical precedence.
 *   2. Shared docker-compose.yml configuration passes ENCRYPTION_KEY into both webcalendar and sync-worker.
 *   3. Stored values (AES-256-GCM under scrypt(secret, per-value salt), see #72) are interoperable
 *      across Node.js and Python.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { encryptForSecret } = require('./helpers/storedCiphertext');

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

  test('sync_worker.py checks ENCRYPTION_KEY and ENCRYPTION_SECRET before falling back', () => {
    const workerPath = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
    assert.ok(fs.existsSync(workerPath), 'sync_worker.py must exist');
    const content = fs.readFileSync(workerPath, 'utf8');

    assert.ok(
      content.includes('os.environ.get("ENCRYPTION_KEY")') && content.includes('os.environ.get("ENCRYPTION_SECRET")'),
      'sync_worker.py must inspect both ENCRYPTION_KEY and ENCRYPTION_SECRET environment variables'
    );
  });

  test('server/db.js checks process.env.ENCRYPTION_KEY and process.env.ENCRYPTION_SECRET', () => {
    const dbPath = path.join(ROOT_DIR, 'server/db.js');
    assert.ok(fs.existsSync(dbPath), 'server/db.js must exist');
    const content = fs.readFileSync(dbPath, 'utf8');

    assert.ok(
      content.includes('process.env.ENCRYPTION_KEY') && content.includes('process.env.ENCRYPTION_SECRET'),
      'server/db.js must inspect both process.env.ENCRYPTION_KEY and process.env.ENCRYPTION_SECRET'
    );
  });

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

  test('default fallback encryption key literal matches identically across server/db.js and sync_worker.py', () => {
    const dbPath = path.join(ROOT_DIR, 'server/db.js');
    const workerPath = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
    const defaultLiteral = 'freeshard-default-encryption-key-do-not-use-in-prod';

    const dbContent = fs.readFileSync(dbPath, 'utf8');
    const workerContent = fs.readFileSync(workerPath, 'utf8');

    assert.ok(dbContent.includes(defaultLiteral), 'server/db.js must contain default encryption key fallback literal');
    assert.ok(workerContent.includes(defaultLiteral), 'sync_worker.py must contain default encryption key fallback literal');
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
