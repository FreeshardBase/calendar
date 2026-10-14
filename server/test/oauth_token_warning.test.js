'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3106';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

/**
 * Issue #7 — User warning banner for expired Google OAuth tokens
 *
 * Tests for GET /api/accounts/oauth-token-status endpoint which surfaces
 * per-account OAuth expiry state so the frontend can display a warning banner.
 *
 * Contract:
 *   - 401 when the request carries no session
 *   - 200 { accounts: [] }  when user has no oauth2 accounts
 *   - expired: true  when expiresAt is null/missing
 *   - expired: true  when expiresAt is in the past
 *   - expired: true  when expiresAt is within 60 s grace window
 *   - expired: false when expiresAt is comfortably in the future
 *   - Only oauth2 accounts are returned (basic-auth accounts excluded)
 *   - password_encrypted / iv never exposed
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { server: appServer } = require('../index');
const { loginAs } = require('./helpers/testSession');

const PORT = process.env.PORT || 3106;
const BASE = `http://localhost:${PORT}`;
const TEST_USER = 'oauth-token-warning-testuser';

// ── helpers ───────────────────────────────────────────────────────────────────

function encryptToken(plaintext) {
  const key = crypto.scryptSync(
    process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_SECRET ||
      'freeshard-default-encryption-key-do-not-use-in-prod',
    'salt', 32
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  return { enc, ivHex: iv.toString('hex') };
}

async function insertOAuthAccount(userId, { expiresAt = null, displayName = 'Test OAuth', username = 'testuser@example.com', url = 'https://apidata.googleusercontent.com/caldav/v2/testuser%40example.com/' } = {}) {
  await Db.ensureUser(userId, userId);
  const id = uuidv4();
  const { enc, ivHex } = encryptToken('test-refresh-token');
  return new Promise((resolve, reject) => {
    Db.db.run(
      `INSERT INTO linked_accounts
         (id, user_id, url, username, password_encrypted, iv, display_name, auth_type, access_token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId,
        url,
        username, enc, ivHex, displayName, 'oauth2', 'tok',
        expiresAt ?? null
      ],
      (err) => { if (err) return reject(err); resolve(id); }
    );
  });
}

async function cleanupUser(userId) {
  return new Promise((resolve) => {
    Db.db.run('DELETE FROM linked_accounts WHERE user_id = ?', [userId], () => {
      Db.db.run('DELETE FROM users WHERE user_id = ?', [userId], () => {
        resolve();
      });
    });
  });
}

async function get(path, userId) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) headers.cookie = await loginAs(userId);
  const res = await fetch(`${BASE}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('Issue #7 — OAuth Token Expiry Warning', () => {

  after(() => {
    if (appServer && appServer.close) appServer.close();
  });

  beforeEach(async () => {
    await cleanupUser(TEST_USER);
  });

  afterEach(async () => {
    await cleanupUser(TEST_USER);
  });

  test('401 when unauthenticated (no session cookie)', async () => {
    const { status, body } = await get('/api/accounts/oauth-token-status', null);
    assert.strictEqual(status, 401, 'should return 401');
    assert.ok(body.error, 'should include error field');
  });

  test('200 empty array when user has no oauth2 accounts', async () => {
    await Db.upsertUser(TEST_USER, 'testoauthuser@example.com');
    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.accounts), 'accounts should be an array');
    const oauthAccounts = body.accounts.filter(a => a.authType === 'oauth2');
    assert.strictEqual(oauthAccounts.length, 0, 'no oauth2 accounts expected');
  });

  test('expired:true when expiresAt is in the past', async () => {
    const expiredAt = Date.now() - 3600 * 1000; // 1 hour ago
    await insertOAuthAccount(TEST_USER, { expiresAt: expiredAt, displayName: 'Expired Google' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.accounts));
    const expired = body.accounts.filter(a => a.expired === true);
    assert.strictEqual(expired.length, 1, 'exactly one expired account');
    assert.strictEqual(expired[0].displayName, 'Expired Google');
    assert.strictEqual(expired[0].authType, 'oauth2');
    assert.ok(expired[0].expiresAt < Date.now(), 'expiresAt should be in the past');
  });

  test('expired:true when expiresAt is null/missing', async () => {
    await insertOAuthAccount(TEST_USER, { expiresAt: null, displayName: 'No Expiry Google' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    const missing = body.accounts.filter(a => a.expired === true);
    assert.strictEqual(missing.length, 1, 'null expiresAt → expired:true');
  });

  test('expired:false for valid token (expiresAt comfortably in the future)', async () => {
    const validAt = Date.now() + 30 * 60 * 1000; // 30 minutes ahead
    await insertOAuthAccount(TEST_USER, { expiresAt: validAt, displayName: 'Valid Google' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    const valid = body.accounts.filter(a => a.expired === false);
    assert.strictEqual(valid.length, 1, 'exactly one valid account');
    assert.strictEqual(valid[0].displayName, 'Valid Google');
    assert.ok(valid[0].expiresAt > Date.now(), 'expiresAt should be in the future');
  });

  test('expired:true when token expires within 60 s grace window', async () => {
    const nearlyExpiredAt = Date.now() + 30 * 1000; // expires in 30 s (< 60 s grace)
    await insertOAuthAccount(TEST_USER, { expiresAt: nearlyExpiredAt, displayName: 'Nearly Expired' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    const expired = body.accounts.filter(a => a.expired === true);
    assert.strictEqual(expired.length, 1, 'within 60 s grace → expired:true');
    assert.strictEqual(expired[0].displayName, 'Nearly Expired');
  });

  test('only oauth2 accounts are returned — basic accounts excluded', async () => {
    const validAt = Date.now() + 3600 * 1000;
    await insertOAuthAccount(TEST_USER, { expiresAt: validAt, displayName: 'Google Account' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    for (const acct of body.accounts) {
      assert.strictEqual(acct.authType, 'oauth2', 'only oauth2 accounts in response');
    }
  });

  test('mixed expired and valid accounts reported correctly', async () => {
    const expiredAt = Date.now() - 3600 * 1000;
    const validAt = Date.now() + 3600 * 1000;
    await insertOAuthAccount(TEST_USER, { expiresAt: expiredAt, displayName: 'Old Token', username: 'olduser@example.com' });
    await insertOAuthAccount(TEST_USER, { expiresAt: validAt, displayName: 'Fresh Token', username: 'freshuser@example.com' });

    const { status, body } = await get('/api/accounts/oauth-token-status', TEST_USER);
    assert.strictEqual(status, 200);
    const expiredList = body.accounts.filter(a => a.expired === true);
    const validList = body.accounts.filter(a => a.expired === false);
    assert.strictEqual(expiredList.length, 1, 'one expired');
    assert.strictEqual(validList.length, 1, 'one valid');
    assert.strictEqual(expiredList[0].displayName, 'Old Token');
    assert.strictEqual(validList[0].displayName, 'Fresh Token');
  });

  test('Db.getOAuthTokenStatus — returns per-account expiry, does not expose credentials', async () => {
    const expiredAt = Date.now() - 7200 * 1000;
    const id = await insertOAuthAccount(TEST_USER, { expiresAt: expiredAt, displayName: 'DB Direct Test' });

    const statuses = await Db.getOAuthTokenStatus(TEST_USER);
    assert.ok(Array.isArray(statuses), 'should be an array');
    const entry = statuses.find(s => s.id === id);
    assert.ok(entry, 'should find the account by id');
    assert.strictEqual(entry.authType, 'oauth2');
    assert.strictEqual(entry.expired, true);
    assert.strictEqual(entry.expiresAt, expiredAt);
    assert.strictEqual(entry.displayName, 'DB Direct Test');
    // Must NOT expose password/encrypted refresh token
    assert.strictEqual(entry.password, undefined, 'password must not be exposed');
    assert.strictEqual(entry.password_encrypted, undefined, 'password_encrypted must not be exposed');
  });
});
