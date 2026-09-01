'use strict';
process.env.NODE_ENV = 'test';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

describe('Issue #154 — clearSyncJobsForUser Prefix Matching Fix', () => {
  const targetUser = 'user1';
  const prefixSibling1 = 'user10';
  const prefixSibling2 = 'user15';
  const prefixSibling3 = 'user1_admin';
  const otherUser = 'user2';

  beforeEach(async () => {
    // Clean up test users' sync jobs directly
    await Db.clearSyncJobsForUser(targetUser);
    await Db.clearSyncJobsForUser(prefixSibling1);
    await Db.clearSyncJobsForUser(prefixSibling2);
    await Db.clearSyncJobsForUser(prefixSibling3);
    await Db.clearSyncJobsForUser(otherUser);
  });

  test('clearSyncJobsForUser strictly deletes target user jobs and does NOT prefix-match sibling users', async () => {
    await Db.addSyncJob(targetUser);
    await Db.addSyncJob(prefixSibling1);
    await Db.addSyncJob(prefixSibling2);
    await Db.addSyncJob(prefixSibling3);
    await Db.addSyncJob(otherUser);

    // Verify all 5 jobs exist
    assert.equal((await Db.getSyncJobs(targetUser)).length, 1);
    assert.equal((await Db.getSyncJobs(prefixSibling1)).length, 1);
    assert.equal((await Db.getSyncJobs(prefixSibling2)).length, 1);
    assert.equal((await Db.getSyncJobs(prefixSibling3)).length, 1);
    assert.equal((await Db.getSyncJobs(otherUser)).length, 1);

    // Perform clear for 'user1'
    const result = await Db.clearSyncJobsForUser(targetUser);
    assert.equal(result.deleted, 1, 'Should report 1 deleted job');

    // Target user jobs should be gone
    assert.equal((await Db.getSyncJobs(targetUser)).length, 0);

    // Sibling users with matching prefix must NOT be deleted
    assert.equal((await Db.getSyncJobs(prefixSibling1)).length, 1, 'user10 job must survive');
    assert.equal((await Db.getSyncJobs(prefixSibling2)).length, 1, 'user15 job must survive');
    assert.equal((await Db.getSyncJobs(prefixSibling3)).length, 1, 'user1_admin job must survive');
    assert.equal((await Db.getSyncJobs(otherUser)).length, 1, 'user2 job must survive');
  });

  test('clearSyncJobsForUser with empty string or falsy userId does NOT wipe out other users jobs', async () => {
    await Db.addSyncJob(prefixSibling1);
    await Db.addSyncJob(otherUser);

    const emptyResult = await Db.clearSyncJobsForUser('');
    assert.equal(emptyResult.deleted, 0, 'Empty string should delete 0 jobs');

    const nullResult = await Db.clearSyncJobsForUser(null);
    assert.equal(nullResult.deleted, 0, 'Null should delete 0 jobs');

    const undefinedResult = await Db.clearSyncJobsForUser(undefined);
    assert.equal(undefinedResult.deleted, 0, 'Undefined should delete 0 jobs');

    // Verify jobs survive
    assert.equal((await Db.getSyncJobs(prefixSibling1)).length, 1);
    assert.equal((await Db.getSyncJobs(otherUser)).length, 1);
  });
});
