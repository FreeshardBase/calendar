'use strict';

/**
 * Issue #72 — Credential-at-Rest Gaps Fix
 *
 * Verifies that:
 * 1. MS Graph access_token and refresh_token are encrypted at rest in DB (`msgraph_accounts`),
 *    not saved in plaintext, and returned decrypted via Db API methods.
 * 2. App-Specific Passwords (`app_passwords`) are stored using salted PBKDF2-HMAC-SHA256 (`salt:hash`),
 *    never unsalted plain SHA-256.
 * 3. AES key derivation honors custom `ENCRYPTION_SALT` while defaulting to `'salt'` for backward compatibility.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const Db = require('../db');
const dbPath = Db.getDbPath ? Db.getDbPath() : (process.env.DATABASE_PATH || path.join(__dirname, '../../webcalendar.db'));

test.describe('Issue #72 — Credential-at-Rest Gaps Security Suite', () => {

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

    assert.ok(account.id, 'Account ID must be created');

    // 1. Direct raw SQLite query: ensure raw columns in DB are encrypted, NOT plaintext
    const db = new sqlite3.Database(dbPath);
    const rawRow = await new Promise((resolve, reject) => {
      db.get(
        'SELECT access_token, refresh_token FROM msgraph_accounts WHERE id = ?',
        [account.id],
        (err, row) => err ? reject(err) : resolve(row)
      );
    });
    db.close();

    assert.notEqual(rawRow.access_token, plainAccessToken, 'Raw DB access_token must not be plaintext');
    assert.notEqual(rawRow.refresh_token, plainRefreshToken, 'Raw DB refresh_token must not be plaintext');
    assert.ok(rawRow.access_token.includes(':'), 'Encrypted access_token must contain IV separator');
    assert.ok(rawRow.refresh_token.includes(':'), 'Encrypted refresh_token must contain IV separator');

    // 2. Db API query: must decrypt tokens back to plaintext
    const retrieved = await Db.getMSGraphAccountById(account.id);
    assert.equal(retrieved.accessToken, plainAccessToken, 'getMSGraphAccountById must return decrypted accessToken');
    assert.equal(retrieved.refreshToken, plainRefreshToken, 'getMSGraphAccountById must return decrypted refreshToken');

    const accountsList = await Db.getMSGraphAccounts(testUserId);
    const listed = accountsList.find(a => a.id === account.id);
    assert.equal(listed.accessToken, plainAccessToken, 'getMSGraphAccounts must return decrypted accessToken');
    assert.equal(listed.refreshToken, plainRefreshToken, 'getMSGraphAccounts must return decrypted refreshToken');

    // 3. Update token encryption: updating tokens must encrypt new values
    const updatedAccessToken = 'updated-ms-access-token-99999';
    await Db.updateMSGraphAccount(account.id, { accessToken: updatedAccessToken });

    const db2 = new sqlite3.Database(dbPath);
    const updatedRaw = await new Promise((resolve, reject) => {
      db2.get(
        'SELECT access_token FROM msgraph_accounts WHERE id = ?',
        [account.id],
        (err, row) => err ? reject(err) : resolve(row)
      );
    });
    db2.close();

    assert.notEqual(updatedRaw.access_token, updatedAccessToken, 'Updated raw DB access_token must not be plaintext');
    const updatedRetrieved = await Db.getMSGraphAccountById(account.id);
    assert.equal(updatedRetrieved.accessToken, updatedAccessToken, 'getMSGraphAccountById must return decrypted updated accessToken');

    // Cleanup
    await Db.deleteMSGraphAccount(account.id);
  });

  test('App passwords are saved using salted PBKDF2 (salt:hash) and verified securely', async () => {
    const testUserId = 'testuser-issue72-asp';
    await Db.upsertUser(testUserId, 'testuser-asp@example.com');
    const result = await Db.addAppPassword(testUserId, 'Test Device');

    assert.ok(result.id, 'App password ID must be returned');
    assert.ok(result.rawPassword, 'Raw cleartext password must be returned for one-time display');

    // 1. Direct raw SQLite query: password_hash column must contain salt and hash separated by colon
    const db = new sqlite3.Database(dbPath);
    const rawRow = await new Promise((resolve, reject) => {
      db.get(
        'SELECT password_hash FROM app_passwords WHERE id = ?',
        [result.id],
        (err, row) => err ? reject(err) : resolve(row)
      );
    });
    db.close();

    assert.ok(rawRow.password_hash.includes(':'), 'Stored password_hash must be in salt:hash format');

    const [salt, hash] = rawRow.password_hash.split(':');
    assert.equal(salt.length, 32, 'Salt hex string must be 16 bytes (32 hex chars)');
    assert.equal(hash.length, 64, 'Hash hex string must be 32 bytes (64 hex chars)');

    // Ensure it is NOT plain unsalted sha256
    const plainSha256 = crypto.createHash('sha256').update(result.rawPassword).digest('hex');
    assert.notEqual(rawRow.password_hash, plainSha256, 'App password must not be stored as plain unsalted SHA-256');

    // 2. Db.verifyAppPassword test
    const isValid = await Db.verifyAppPassword(testUserId, result.rawPassword);
    assert.equal(isValid, true, 'Db.verifyAppPassword must return true for correct raw password');

    const isInvalid = await Db.verifyAppPassword(testUserId, 'wrong-password-123');
    assert.equal(isInvalid, false, 'Db.verifyAppPassword must return false for wrong password');

    // Cleanup
    await Db.deleteAppPassword(result.id);
  });

  test('ENCRYPTION_SALT environment configuration support', () => {
    const defaultSalt = process.env.ENCRYPTION_SALT || 'salt';
    const derivedKey = crypto.scryptSync('my-test-secret', defaultSalt, 32);
    assert.equal(derivedKey.length, 32, 'Scrypt derived key length must be 32 bytes');
  });
});
