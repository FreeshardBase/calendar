'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3285';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
// Hermetic key resolution: db.js prefers an existing .encryption_key file over the env/default key,
// and any earlier run in the same checkout creates one. Point it at a path that never exists.
process.env.ENCRYPTION_KEY_FILE = require('path').join(require('os').tmpdir(), 'issue136-no-such-key-file');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const TEST_USER = 'user-136-test';
const OTHER_USER = 'user-136-other';
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
    port = Number(process.env.PORT) || 3285;
    if (server && !server.listening) {
      await new Promise(resolve => server.listen(port, resolve));
    }

    // Seed the user so session middleware can upsertUser without error.
    await Db.upsertUser(TEST_USER, TEST_USER).catch(() => {});
    await Db.upsertUser(OTHER_USER, OTHER_USER);
  });

  after(async () => {
    await deleteAllForUser(TEST_USER);
    await deleteAllForUser(OTHER_USER);
    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  afterEach(async () => {
    await deleteAllForUser(TEST_USER);
    await deleteAllForUser(OTHER_USER);
  });

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

  // ── 2b. GET /api/accounts surfaces the broken row so the UI can offer deletion ──
  it('GET /api/accounts lists an undecryptable account flagged credentialsUnreadable, without secrets', async () => {
    const goodId = await insertGoodAccount(TEST_USER, 'Good Account');
    const brokenId = await insertBrokenAccount(TEST_USER, 'Broken Account');
    const otherBrokenId = await insertBrokenAccount(OTHER_USER, 'Other User Broken');

    const { status, body } = await makeRequest('GET', '/api/accounts');
    assert.equal(body.find?.(a => a.id === otherBrokenId), undefined,
      'another user\'s unreadable account must never be listed');
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const broken = body.find(a => a.id === brokenId);
    assert.ok(broken, `broken account must be listed so it can be deleted; got ${JSON.stringify(body)}`);
    assert.equal(broken.credentialsUnreadable, true);
    assert.equal(broken.displayName, 'Broken Account');
    assert.equal(broken.username, 'brokenuser');
    assert.equal(broken.url, 'https://caldav.example.com/');
    assert.ok(!('password' in broken), 'degraded row must never carry a password field');

    const good = body.find(a => a.id === goodId);
    assert.ok(good, 'healthy account must be listed');
    assert.notEqual(good.credentialsUnreadable, true, 'healthy account must not be flagged');
    assert.ok(!('password' in good));
  });

  // ── 2c. The broken row never reaches the session (CalDAV consumers) ──────────
  it('undecryptable account is not handed to CalDAV consumers via the session', async () => {
    const brokenId = await insertBrokenAccount(TEST_USER, 'Broken Account');
    await insertBrokenAccount(OTHER_USER, 'Other User Broken');
    const accounts = await Db.getAccounts(TEST_USER);
    assert.equal(accounts.find(a => a.id === brokenId), undefined);
    const unreadable = await Db.getUnreadableAccounts(TEST_USER);
    assert.deepEqual(unreadable.map(a => a.id), [brokenId]);
    assert.ok(!('password' in unreadable[0]));
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

  // ── 5. A broken account of another user can neither be deleted nor probed ───
  it('DELETE /api/accounts/:id refuses another user\'s undecryptable account', async () => {
    const otherBrokenId = await insertBrokenAccount(OTHER_USER, 'Other User Broken');

    const { status } = await makeRequest('DELETE', `/api/accounts/${otherBrokenId}`);
    assert.equal(status, 404);

    const row = await new Promise((res, rej) => Db.db.get(
      `SELECT id FROM linked_accounts WHERE id = ?`, [otherBrokenId],
      (err, r) => err ? rej(err) : res(r)
    ));
    assert.ok(row, 'another user\'s row must survive');
  });
});
