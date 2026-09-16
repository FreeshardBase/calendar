const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const syncRetryQueue = require('../utils/syncRetryQueue');

describe('Issue #147 — Sync Queue Pruning Production Fix', () => {
  before(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  beforeEach(async () => {
    await Db.clearAll();
  });

  test('Db.pruneSyncQueue deletes completed/errored jobs older than maxAgeMs', async () => {
    const now = 1700000000000; // fixed reference timestamp
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    const oldTime = now - maxAgeMs - 3600000; // 25 hours ago
    const recentTime = now - 3600000; // 1 hour ago

    await Db.upsertUser('user-1', 'user-1@example.com');
    await Db.upsertUser('user-2', 'user-2@example.com');

    // Insert test jobs manually
    await new Promise((resolve, reject) => {
      Db.db.serialize(() => {
        // Old completed job (should be pruned)
        Db.db.run(
          `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
           VALUES ('job-old-success', 'user-1', 'SUCCESS', NULL, 1, 3, NULL, 'IDLE', ?, ?)`,
          [oldTime, oldTime]
        );
        // Old failed job (should be pruned)
        Db.db.run(
          `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
           VALUES ('job-old-error', 'user-1', 'ERROR', 'Fatal error', 3, 3, NULL, 'MAX_RETRIES_EXCEEDED', ?, ?)`,
          [oldTime, oldTime]
        );
        // Recent completed job (should NOT be pruned)
        Db.db.run(
          `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
           VALUES ('job-recent-success', 'user-1', 'SUCCESS', NULL, 1, 3, NULL, 'IDLE', ?, ?)`,
          [recentTime, recentTime]
        );
        // Old pending job (should NOT be pruned)
        Db.db.run(
          `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
           VALUES ('job-old-pending', 'user-2', 'PENDING', NULL, 0, 3, NULL, 'IDLE', ?, ?)`,
          [oldTime, oldTime]
        );
        // Old running job (should NOT be pruned by completed prune rule)
        Db.db.run(
          `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
           VALUES ('job-old-running', 'user-2', 'RUNNING', NULL, 1, 3, NULL, 'IDLE', ?, ?)`,
          [oldTime, oldTime],
          (err) => (err ? reject(err) : resolve())
        );
      });
    });

    const result = await Db.pruneSyncQueue(maxAgeMs, now);
    assert.equal(result.pruned, 2, 'Should prune exactly 2 old completed/errored jobs');

    const user1Jobs = await Db.getSyncJobs('user-1');
    assert.equal(user1Jobs.length, 1);
    assert.equal(user1Jobs[0].id, 'job-recent-success');

    const user2Jobs = await Db.getSyncJobs('user-2');
    assert.equal(user2Jobs.length, 2);
  });

  test('syncRetryQueue.pruneSyncQueue exports and delegates to Db.pruneSyncQueue', async () => {
    const now = Date.now();
    const oldTime = now - (48 * 60 * 60 * 1000); // 48 hours ago

    await Db.upsertUser('user-export', 'user-export@example.com');

    await new Promise((resolve, reject) => {
      Db.db.run(
        `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
         VALUES ('job-export-test', 'user-export', 'SUCCESS', NULL, 1, 3, NULL, 'IDLE', ?, ?)`,
        [oldTime, oldTime],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const result = await syncRetryQueue.pruneSyncQueue(24 * 60 * 60 * 1000, now);
    assert.equal(result.pruned, 1);

    const jobs = await Db.getSyncJobs('user-export');
    assert.equal(jobs.length, 0);
  });

  test('addSyncJob automatically triggers pruning of old completed/errored jobs', async () => {
    const oldTime = Date.now() - (48 * 60 * 60 * 1000); // 48 hours ago

    await Db.upsertUser('user-autoprune', 'user-autoprune@example.com');
    await Db.upsertUser('user-new', 'user-new@example.com');

    await new Promise((resolve, reject) => {
      Db.db.run(
        `INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at)
         VALUES ('job-auto-prune', 'user-autoprune', 'SUCCESS', NULL, 1, 3, NULL, 'IDLE', ?, ?)`,
        [oldTime, oldTime],
        (err) => (err ? reject(err) : resolve())
      );
    });

    await Db.addSyncJob('user-new');

    const oldUserJobs = await Db.getSyncJobs('user-autoprune');
    assert.equal(oldUserJobs.length, 0, 'Old finished job should have been auto-pruned during addSyncJob');
  });
});
