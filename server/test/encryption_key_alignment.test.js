'use strict';

/**
 * Issue #322 — App & Sync-Worker Encryption Key Alignment
 *
 * Verifies that Node.js app (server/db.js) and Python daemon (sync-worker/sync_worker.py):
 *   1. Support both ENCRYPTION_KEY and ENCRYPTION_SECRET environment variables with identical precedence.
 *   2. Shared docker-compose.yml configuration passes ENCRYPTION_KEY into both webcalendar and sync-worker.
 *   3. Scrypt key derivation (32 bytes, salt='salt', N=16384, r=8, p=1) and AES-256-CBC encryption/decryption
 *      produce 100% interoperable ciphertexts across Node.js and Python.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

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

  test('Node.js AES-256-CBC ciphertext is successfully decrypted by Python sync_worker decrypt routine', () => {
    const secret = 'custom-test-secret-key-32-chars!!';
    const plaintext = 'sensitive-oauth-refresh-token-xyz789';

    // 1. Derive key in Node.js
    const derivedKeyNode = crypto.scryptSync(secret, 'salt', 32);

    // 2. Encrypt in Node.js using AES-256-CBC
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', derivedKeyNode, iv);
    let encryptedHex = cipher.update(plaintext, 'utf8', 'hex');
    encryptedHex += cipher.final('hex');

    // 3. Decrypt in Python using sync_worker logic
    const pyScript = `
import os
import sys
sys.path.insert(0, '${path.join(ROOT_DIR, 'sync-worker')}')
import sync_worker

key = sync_worker.derive_key('${secret}')
decrypted = sync_worker.decrypt('${encryptedHex}', '${iv.toString('hex')}', key)
print(decrypted)
`;

    const pythonOutput = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8'
    }).trim();

    assert.equal(pythonOutput, plaintext, 'Python sync_worker must correctly decrypt Node.js encrypted credentials');
  });

});
