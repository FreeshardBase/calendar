'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3196';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const TEST_USER = 'user-136-test';
let Db;
let app;
let server;
let port = 3196;

function makeRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': TEST_USER,
        ...extraHeaders
      }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Inserts a row whose password_encrypted/iv are garbage (simulate wrong key). */
function insertBrokenAccount(userId, displayName) {
  const id = require('uuid').v4();
  return new Promise((res, rej) => Db.db.run(
    `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name)
     VALUES (?,?,?,?,?,?,?)`,
    [id, userId, 'https://caldav.example.com/', 'brokenuser', 'deadbeef',
     '00000000000000000000000000000000', displayName],
    err => err ? rej(err) : res(id)
  ));
}

/** Inserts a properly encrypted account using the same key db.js uses. */
function insertGoodAccount(userId, displayName) {
  const id = require('uuid').v4();
  const encKey = crypto.scryptSync(
    process.env.ENCRYPTION_KEY || 'freeshard-default-encryption-key-do-not-use-in-prod',
    process.env.ENCRYPTION_SALT || 'salt',
    32
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  let enc = cipher.update('good-password', 'utf8', 'hex');
  enc += cipher.final('hex');
  return new Promise((res, rej) => Db.db.run(
    `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name)
     VALUES (?,?,?,?,?,?,?)`,
    [id, userId, 'https://caldav.example.com/', 'gooduser', enc, iv.toString('hex'), displayName],
    err => err ? rej(err) : res(id)
  ));
}

function deleteAllForUser(userId) {
  return new Promise((res, rej) => Db.db.run(
    `DELETE FROM linked_accounts WHERE user_id = ?`, [userId],
    err => err ? rej(err) : res()
  ));
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Issue #136 — un-decryptable linked_accounts row', () => {
  before(async () => {
    Db = require('../db');
    const index = require('../index');
    app = index.app;
    server = index.server;
    port = Number(process.env.PORT) || 3196;

    // Seed the user so session middleware can upsertUser without error.
    await Db.upsertUser(TEST_USER, TEST_USER).catch(() => {});
  });

  after(async () => {
    await deleteAllForUser(TEST_USER);
    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  afterEach(() => deleteAllForUser(TEST_USER));

  // ── 1. Db.getAccounts skips corrupted row, keeps healthy rows ────────────────
  it('getAccounts skips undecryptable row and returns healthy rows', async () => {
    const goodId = await insertGoodAccount(TEST_USER, 'Good Account');
    await insertBrokenAccount(TEST_USER, 'Bad Account');

    const accounts = await Db.getAccounts(TEST_USER);

    assert.ok(Array.isArray(accounts));
    const good = accounts.find(a => a.id === goodId);
    assert.ok(good, 'healthy account must be present');
    assert.equal(good.displayName, 'Good Account');

    const bad = accounts.find(a => a.displayName === 'Bad Account');
    assert.equal(bad, undefined, 'undecryptable account must be silently dropped, not throw');
  });

  // ── 2. GET /api/accounts returns 200 even with a broken row ─────────────────
  it('GET /api/accounts returns 200 even when one row is undecryptable', async () => {
    await insertBrokenAccount(TEST_USER, 'Broken');

    const { status, body } = await makeRequest('GET', '/api/accounts');
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body));
  });

  // ── 3. Other API routes are NOT 401-ed by a broken row ──────────────────────
  it('GET /api/calendars is not 401-blocked when one linked_accounts row is undecryptable', async () => {
    await insertBrokenAccount(TEST_USER, 'Broken');

    const { status } = await makeRequest('GET', '/api/calendars');
    // 200 or 502/any non-401 is acceptable; 401 proves the bug is present.
    assert.notEqual(status, 401,
      'A broken linked_accounts row must NOT cause a global 401 on /api/calendars');
  });

  // ── 4. DELETE /api/accounts/:id removes a broken row absent from session ─────
  it('DELETE /api/accounts/:id removes an undecryptable account not in session', async () => {
    const brokenId = await insertBrokenAccount(TEST_USER, 'Broken');

    // req.session.accounts for TEST_USER will NOT contain brokenId
    // because getAccounts drops it. A naive "find in session + delete" would 404.
    const { status, body } = await makeRequest('DELETE', `/api/accounts/${brokenId}`);
    assert.equal(status, 200,
      `DELETE must succeed for a broken account; got ${status}: ${JSON.stringify(body)}`);

    // Confirm row is physically gone.
    const row = await new Promise((res, rej) => Db.db.get(
      `SELECT id FROM linked_accounts WHERE id = ?`, [brokenId],
      (err, r) => err ? rej(err) : res(r)
    ));
    assert.equal(row, undefined, 'row must be deleted from DB');
  });
});
