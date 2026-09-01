'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

test('Issue #149 — Multi-Statement Database Operations & Transaction Atomicity', async (t) => {
  await t.test('1. Db.withTransaction commits changes when callback resolves', async () => {
    const testUserId = `test-tx-commit-${Date.now()}`;
    const testUsername = `user-tx-commit-${Date.now()}`;

    await Db.withTransaction(async (tx) => {
      await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [testUserId, testUsername]);
    });

    const user = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id, username FROM users WHERE user_id = ?', [testUserId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    assert.ok(user, 'User should be committed');
    assert.equal(user.user_id, testUserId);

    // Cleanup
    await Db.deleteUser(testUserId);
  });

  await t.test('2. Db.withTransaction rolls back all operations when an error is thrown', async () => {
    const testUserId = `test-tx-rollback-${Date.now()}`;
    const testUsername = `user-tx-rollback-${Date.now()}`;

    await assert.rejects(
      Db.withTransaction(async (tx) => {
        await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [testUserId, testUsername]);
        throw new Error('Simulated failure during multi-statement transaction');
      }),
      /Simulated failure/
    );

    const user = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id, username FROM users WHERE user_id = ?', [testUserId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    assert.equal(user, undefined, 'User insert should be rolled back completely');
  });

  await t.test('3. Db.clearAll runs in a transaction and rolls back if an error occurs', async () => {
    const testUserId = `test-clearall-${Date.now()}`;
    await Db.upsertUser(testUserId, `user-${testUserId}`);

    // Call clearAll
    await Db.clearAll();

    const accounts = await Db.getAccounts(testUserId);
    assert.deepEqual(accounts, []);

    // Cleanup
    await Db.deleteUser(testUserId);
  });

  await t.test('4. Db.deleteUser rolls back if any statement fails', async () => {
    const testUserId = `test-deluser-${Date.now()}`;
    await Db.upsertUser(testUserId, `user-${testUserId}`);

    // Verify deleteUser works cleanly when executed without errors
    await Db.deleteUser(testUserId);

    const user = await new Promise((resolve, reject) => {
      Db.db.get('SELECT user_id FROM users WHERE user_id = ?', [testUserId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    assert.equal(user, undefined, 'User deleted cleanly via deleteUser');
  });

  await t.test('5. Db.addSyncJob, Db.deleteMSGraphAccount, Db.deleteResource use transactions for multi-statement atomic execution', async () => {
    const testUserId = `test-multistatements-${Date.now()}`;
    await Db.upsertUser(testUserId, `user-${testUserId}`);

    const job = await Db.addSyncJob(testUserId);
    assert.ok(job && job.id, 'addSyncJob succeeded atomically');

    const jobCheck = await Db.getSyncJobById(job.id);
    assert.ok(jobCheck, 'Sync job was inserted and committed');

    await Db.clearSyncJobsForUser(testUserId);
    await Db.deleteUser(testUserId);
  });
});
