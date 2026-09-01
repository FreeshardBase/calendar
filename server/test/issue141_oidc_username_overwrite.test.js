const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');

test('Issue #141 — OIDC username overwrite & INSERT OR REPLACE collision safety', async (t) => {
  const userId1 = 'oidc-user-sub-141-1';
  const oidcUsername1 = 'alice141@example.com';
  const userId2 = 'oidc-user-sub-141-2';

  // Clean up test rows
  await new Promise((resolve) => Db.db.run('DELETE FROM users WHERE user_id IN (?, ?)', [userId1, userId2], resolve));

  await t.test('1. Db.upsertUser registers user with OIDC username', async () => {
    await Db.upsertUser(userId1, oidcUsername1);
    const row = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id, username FROM users WHERE user_id = ?', [userId1], (err, r) => err ? reject(err) : resolve(r));
    });
    assert.ok(row, 'User row should exist');
    assert.strictEqual(row.username, oidcUsername1);
  });

  await t.test('2. Subsequent request with userId fallback does NOT overwrite OIDC username', async () => {
    // Middleware calls upsertUser(userId1, userId1) on subsequent requests when username isn't in body/header
    await Db.upsertUser(userId1, userId1);
    const row = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id, username FROM users WHERE user_id = ?', [userId1], (err, r) => err ? reject(err) : resolve(r));
    });
    assert.strictEqual(row.username, oidcUsername1, 'Username should remain OIDC username, not overwritten by userId');
  });

  await t.test('3. Username collision does NOT delete existing user row', async () => {
    // Attempting to upsert user2 with user1's existing username
    await Db.upsertUser(userId2, oidcUsername1);

    // Verify user1's row was NOT deleted by REPLACE conflict resolution
    const row1 = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id, username FROM users WHERE user_id = ?', [userId1], (err, r) => err ? reject(err) : resolve(r));
    });
    assert.ok(row1, 'User 1 row MUST NOT be deleted on username collision');
    assert.strictEqual(row1.username, oidcUsername1, 'User 1 username should remain intact');
  });

  // Teardown
  await new Promise((resolve) => Db.db.run('DELETE FROM users WHERE user_id IN (?, ?)', [userId1, userId2], resolve));
});
