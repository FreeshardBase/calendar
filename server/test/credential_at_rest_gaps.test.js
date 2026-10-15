'use strict';

/**
 * Issue #72 — credentials at rest.
 *
 * 1. MS Graph and Google OAuth tokens are encrypted at rest and come back decrypted through the Db API.
 * 2. App passwords are stored as salted PBKDF2-HMAC-SHA256 (`salt:hash`), never unsalted SHA-256.
 * 3. Encrypted values are AES-256-GCM under a key derived with scrypt from a random per-value salt:
 *    a tampered value fails to decrypt instead of returning altered plaintext, and the stored layout
 *    (iv column = salt(16) || nonce(12), ciphertext column = ciphertext || tag(16)) is the one the
 *    Python sync worker reads.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Own database and key: the tests decrypt stored values independently and must know the key.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'issue72-'));
const ENCRYPTION_SECRET = 'testuser-issue72-strong-encryption-secret-6f1c2a';
process.env.DATABASE_PATH = path.join(TMP_DIR, 'webcalendar.db');
process.env.ENCRYPTION_KEY = ENCRYPTION_SECRET;
process.env.ENCRYPTION_KEY_FILE = path.join(TMP_DIR, '.encryption_key');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const Db = require('../db');

const SYNC_WORKER_DIR = path.join(__dirname, '../../sync-worker');

function rawGet(sql, params) {
  return new Promise((resolve, reject) => Db.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function rawRun(sql, params) {
  return new Promise((resolve, reject) => Db.db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

/** Flips the lowest bit of the hex digit at `index`. */
function flipHexBit(hex, index) {
  const flipped = (parseInt(hex[index], 16) ^ 1).toString(16);
  return hex.slice(0, index) + flipped + hex.slice(index + 1);
}

/** Decrypts a stored value from the documented layout alone, without db.js. */
function openIndependently(ivHex, cipherHex) {
  const header = Buffer.from(ivHex, 'hex');
  const body = Buffer.from(cipherHex, 'hex');
  assert.equal(header.length, 28, 'iv column must hold salt(16) || nonce(12)');
  const key = crypto.scryptSync(ENCRYPTION_SECRET, header.subarray(0, 16), 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(16));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
}

function runPython(script, ...args) {
  return execFileSync('python3', ['-c', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH, ENCRYPTION_KEY: ENCRYPTION_SECRET },
  }).trim();
}

test.before(() => Db.ready);
test.after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

test.describe('Issue #72 — credentials at rest', () => {

  test('MS Graph access and refresh tokens are encrypted at rest in msgraph_accounts', async () => {
    const testUserId = 'testuser-issue72-msgraph';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const plainAccessToken = 'secret-ms-access-token-12345';
    const plainRefreshToken = 'secret-ms-refresh-token-67890';

    const account = await Db.addMSGraphAccount({
      userId: testUserId,
      accountEmail: 'testuser@example.com',
      accessToken: plainAccessToken,
      refreshToken: plainRefreshToken,
      expiresAt: Date.now() + 3600000
    });

    const rawRow = await rawGet('SELECT access_token, refresh_token FROM msgraph_accounts WHERE id = ?', [account.id]);
    assert.notEqual(rawRow.access_token, plainAccessToken, 'Raw DB access_token must not be plaintext');
    assert.notEqual(rawRow.refresh_token, plainRefreshToken, 'Raw DB refresh_token must not be plaintext');

    const retrieved = await Db.getMSGraphAccountById(account.id);
    assert.equal(retrieved.accessToken, plainAccessToken);
    assert.equal(retrieved.refreshToken, plainRefreshToken);
    const listed = (await Db.getMSGraphAccounts(testUserId)).find(a => a.id === account.id);
    assert.equal(listed.accessToken, plainAccessToken);
    assert.equal(listed.refreshToken, plainRefreshToken);

    const updatedAccessToken = 'updated-ms-access-token-99999';
    await Db.updateMSGraphAccount(account.id, { accessToken: updatedAccessToken });
    const updatedRaw = await rawGet('SELECT access_token FROM msgraph_accounts WHERE id = ?', [account.id]);
    assert.notEqual(updatedRaw.access_token, updatedAccessToken, 'Updated raw DB access_token must not be plaintext');
    assert.equal((await Db.getMSGraphAccountById(account.id)).accessToken, updatedAccessToken);

    await Db.deleteMSGraphAccount(account.id);
  });

  test('Google OAuth access token is encrypted at rest like the refresh token', async () => {
    const testUserId = 'testuser-issue72-google';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const { id } = await Db.addOAuthAccount(testUserId, {
      url: 'https://apidata.googleusercontent.com/caldav/v2/', username: 'testuser@example.com',
      refreshToken: 'testuser-google-refresh', accessToken: 'testuser-google-access', expiresAt: Date.now() + 3600000
    });

    const raw = await rawGet('SELECT access_token FROM linked_accounts WHERE id = ?', [id]);
    assert.ok(!raw.access_token.includes('testuser-google-access'), 'Raw DB access_token must not be plaintext');
    const [ivHex, cipherHex] = raw.access_token.split(':');
    assert.equal(openIndependently(ivHex, cipherHex), 'testuser-google-access');
    assert.equal((await Db.getAccountById(id)).accessToken, 'testuser-google-access');

    await Db.updateOAuthTokens(id, { accessToken: 'testuser-google-access-2', expiresAt: Date.now() + 3600000 });
    const updated = await rawGet('SELECT access_token FROM linked_accounts WHERE id = ?', [id]);
    assert.ok(!updated.access_token.includes('testuser-google-access-2'), 'Updated access_token must not be plaintext');
    assert.equal((await Db.getAccounts(testUserId)).find(a => a.id === id).accessToken, 'testuser-google-access-2');

    await Db.deleteAccount(id);
  });

  test('App passwords are saved using salted PBKDF2 (salt:hash) and verified securely', async () => {
    const testUserId = 'testuser-issue72-asp';
    await Db.upsertUser(testUserId, 'testuser-asp@example.com');
    const result = await Db.addAppPassword(testUserId, 'Test Device');

    const rawRow = await rawGet('SELECT password_hash FROM app_passwords WHERE id = ?', [result.id]);
    assert.ok(rawRow.password_hash.includes(':'), 'Stored password_hash must be in salt:hash format');
    const [salt, hash] = rawRow.password_hash.split(':');
    assert.equal(salt.length, 32, 'Salt hex string must be 16 bytes (32 hex chars)');
    assert.equal(hash.length, 64, 'Hash hex string must be 32 bytes (64 hex chars)');
    const plainSha256 = crypto.createHash('sha256').update(result.rawPassword).digest('hex');
    assert.notEqual(rawRow.password_hash, plainSha256, 'App password must not be stored as plain unsalted SHA-256');

    assert.equal(await Db.verifyAppPassword(testUserId, result.rawPassword), true);
    assert.equal(await Db.verifyAppPassword(testUserId, 'wrong-password-123'), false);

    await Db.deleteAppPassword(result.id, testUserId);
  });

  test('stored credentials are AES-256-GCM under a scrypt key with a random salt per value', async () => {
    const testUserId = 'testuser-issue72-gcm';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const a = await Db.addAccount(testUserId, { url: 'https://caldav.example.com/a/', username: 'testuser', password: 'same-password' });
    const b = await Db.addAccount(testUserId, { url: 'https://caldav.example.com/b/', username: 'testuser', password: 'same-password' });

    const rowA = await rawGet('SELECT password_encrypted, iv FROM linked_accounts WHERE id = ?', [a.id]);
    const rowB = await rawGet('SELECT password_encrypted, iv FROM linked_accounts WHERE id = ?', [b.id]);
    assert.equal(openIndependently(rowA.iv, rowA.password_encrypted), 'same-password');
    assert.equal(openIndependently(rowB.iv, rowB.password_encrypted), 'same-password');
    assert.notEqual(rowA.iv.slice(0, 32), rowB.iv.slice(0, 32), 'each value must get its own scrypt salt');

    const graph = await Db.addMSGraphAccount({
      userId: testUserId, accountEmail: 'testuser@example.com',
      accessToken: 'testuser-graph-access', refreshToken: 'testuser-graph-refresh', expiresAt: Date.now() + 3600000
    });
    const graphRow = await rawGet('SELECT refresh_token FROM msgraph_accounts WHERE id = ?', [graph.id]);
    const [ivHex, cipherHex] = graphRow.refresh_token.split(':');
    assert.equal(openIndependently(ivHex, cipherHex), 'testuser-graph-refresh');

    const check = await rawGet('SELECT ciphertext, iv FROM encryption_key_check WHERE id = 1', []);
    assert.equal(openIndependently(check.iv, check.ciphertext), 'freeshard-webcalendar-key-check-v1');

    await Db.deleteAccount(a.id);
    await Db.deleteAccount(b.id);
    await Db.deleteMSGraphAccount(graph.id);
  });

  test('a one-bit change to a stored MS Graph token makes the read fail instead of returning altered plaintext', async () => {
    const testUserId = 'testuser-issue72-tamper-graph';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const graph = await Db.addMSGraphAccount({
      userId: testUserId, accountEmail: 'testuser@example.com',
      accessToken: 'AAAAAAAAAAAAAAAA', refreshToken: 'testuser-graph-refresh', expiresAt: Date.now() + 3600000
    });
    const { access_token: stored } = await rawGet('SELECT access_token FROM msgraph_accounts WHERE id = ?', [graph.id]);
    const separator = stored.indexOf(':');

    // A bit in the IV/nonce part, then a bit in the ciphertext part.
    for (const index of [separator - 1, separator + 1]) {
      await rawRun('UPDATE msgraph_accounts SET access_token = ? WHERE id = ?', [flipHexBit(stored, index), graph.id]);
      await assert.rejects(Db.getMSGraphAccountById(graph.id), 'a tampered token must not decrypt');
      await assert.rejects(Db.getMSGraphAccounts(testUserId), 'a tampered token must not decrypt');
    }

    // A token that is not an encrypted value at all is an error, never handed out as the token.
    await rawRun('UPDATE msgraph_accounts SET access_token = ? WHERE id = ?', ['testuser-plaintext-token', graph.id]);
    await assert.rejects(Db.getMSGraphAccountById(graph.id));

    await Db.deleteMSGraphAccount(graph.id);
  });

  test('a one-bit change to a stored account password marks the account unreadable', async () => {
    const testUserId = 'testuser-issue72-tamper-account';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const { id } = await Db.addAccount(testUserId, {
      url: 'https://caldav.example.com/', username: 'testuser', password: 'AAAAAAAAAAAAAAAA'
    });
    const row = await rawGet('SELECT iv FROM linked_accounts WHERE id = ?', [id]);
    await rawRun('UPDATE linked_accounts SET iv = ? WHERE id = ?', [flipHexBit(row.iv, row.iv.length - 1), id]);

    assert.equal((await Db.getAccounts(testUserId)).length, 0, 'a tampered credential must not be returned');
    assert.deepEqual((await Db.getUnreadableAccounts(testUserId)).map(a => a.id), [id]);
    await assert.rejects(Db.getAccountById(id));

    await Db.deleteAccount(id);
  });

  test('the Python sync worker reads values the app wrote and rejects tampered ones', async () => {
    const testUserId = 'testuser-issue72-python';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const graph = await Db.addMSGraphAccount({
      userId: testUserId, accountEmail: 'testuser@example.com',
      accessToken: 'testuser-graph-access', refreshToken: 'testuser-graph-refresh', expiresAt: Date.now() + 3600000
    });
    const { refresh_token: stored } = await rawGet('SELECT refresh_token FROM msgraph_accounts WHERE id = ?', [graph.id]);

    const script = `
import sys
sys.path.insert(0, sys.argv[1])
import msgraph_worker, sync_worker
token = sys.argv[2]
print(msgraph_worker.decrypt_token(token))
try:
    msgraph_worker.decrypt_token(sys.argv[3])
    print("TAMPERED-ACCEPTED")
except ValueError:
    print("TAMPERED-REJECTED")
print(msgraph_worker.encrypt_token("testuser-from-python"))
`;
    const tampered = flipHexBit(stored, stored.indexOf(':') - 1);
    const [plain, verdict, fromPython] = runPython(script, SYNC_WORKER_DIR, stored, tampered).split('\n');
    assert.equal(plain, 'testuser-graph-refresh');
    assert.equal(verdict, 'TAMPERED-REJECTED');

    await rawRun('UPDATE msgraph_accounts SET refresh_token = ? WHERE id = ?', [fromPython, graph.id]);
    assert.equal((await Db.getMSGraphAccountById(graph.id)).refreshToken, 'testuser-from-python');

    await Db.deleteMSGraphAccount(graph.id);
  });
});
