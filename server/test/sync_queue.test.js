const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

describe('Sync Queue Worker & Error Resilience Suite', () => {
  before(async () => {
    // Ensure DB tables are initialized
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  beforeEach(async () => {
    await Db.clearSyncJobsForUser('testuser-');
  });

  test('addSyncJob creates a pending sync job for user', async () => {
    const userId = 'testuser-sync-1';
    const job = await Db.addSyncJob(userId);

    assert.equal(job.userId, userId);
    assert.equal(job.status, 'PENDING');
    assert.ok(job.id);
    assert.ok(job.createdAt);

    const jobs = await Db.getSyncJobs(userId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job.id);
    assert.equal(jobs[0].status, 'PENDING');
  });

  test('addSyncJob idempotency: enqueuing multiple pending jobs replaces previous pending job', async () => {
    const userId = 'testuser-sync-idempotence';
    const job1 = await Db.addSyncJob(userId);
    const job2 = await Db.addSyncJob(userId);

    assert.notEqual(job1.id, job2.id);

    const jobs = await Db.getSyncJobs(userId);
    // Should only have 1 pending job for the user, old pending job deleted
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job2.id);
    assert.equal(jobs[0].status, 'PENDING');
  });

  test('getPendingSyncJobs returns jobs ordered by creation time', async () => {
    const user1 = 'testuser-queue-1';
    const user2 = 'testuser-queue-2';

    const job1 = await Db.addSyncJob(user1);
    await new Promise((r) => setTimeout(r, 10));
    const job2 = await Db.addSyncJob(user2);

    const pendingJobs = await Db.getPendingSyncJobs();
    assert.equal(pendingJobs.length, 2);
    assert.equal(pendingJobs[0].id, job1.id);
    assert.equal(pendingJobs[1].id, job2.id);
  });

  test('sync job state lifecycle: PENDING -> RUNNING -> SUCCESS', async () => {
    const userId = 'testuser-lifecycle-success';
    const job = await Db.addSyncJob(userId);

    // Transition to RUNNING
    await Db.updateSyncJobStatus(job.id, 'RUNNING');
    let userJobs = await Db.getSyncJobs(userId);
    assert.equal(userJobs[0].status, 'RUNNING');

    // Pending jobs list should no longer include running job
    const pendingJobs = await Db.getPendingSyncJobs();
    assert.equal(pendingJobs.length, 0);

    // Transition to SUCCESS
    await Db.updateSyncJobStatus(job.id, 'SUCCESS');
    userJobs = await Db.getSyncJobs(userId);
    assert.equal(userJobs[0].status, 'SUCCESS');
    assert.equal(userJobs[0].errorMessage, null);
  });

  test('sync job state lifecycle & error recovery: PENDING -> RUNNING -> ERROR with details', async () => {
    const userId = 'testuser-lifecycle-error';
    const job = await Db.addSyncJob(userId);

    // Transition to RUNNING
    await Db.updateSyncJobStatus(job.id, 'RUNNING');

    // Simulate CalDAV network timeout / connection error
    const errorDetails = 'CalDAV connection timeout at http://caldav-server:5232';
    await Db.updateSyncJobStatus(job.id, 'ERROR', errorDetails);

    const userJobs = await Db.getSyncJobs(userId);
    assert.equal(userJobs[0].status, 'ERROR');
    assert.equal(userJobs[0].errorMessage, errorDetails);

    // Enqueue a new sync retry job after error recovery
    const retryJob = await Db.addSyncJob(userId);
    assert.equal(retryJob.status, 'PENDING');

    const updatedUserJobs = await Db.getSyncJobs(userId);
    // Should have both the historical ERROR job and the new PENDING retry job
    assert.equal(updatedUserJobs.length, 2);
    assert.equal(updatedUserJobs[0].status, 'PENDING');
    assert.equal(updatedUserJobs[1].status, 'ERROR');
  });
});
