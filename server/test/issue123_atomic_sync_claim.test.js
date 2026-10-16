'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3093';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const Db = require('../db');

describe('Issue #123 — Atomic Sync Queue Claiming Suite', () => {
  const testUserId = 'testuser-issue123';

  before(async () => {
    await Db.upsertUser(testUserId, 'pass123');
  });

  beforeEach(async () => {
    await Db.clearAll();
    await Db.upsertUser(testUserId, 'pass123');
  });

  test('Db.claimSyncJob should atomically claim a PENDING job', async () => {
    const job = await Db.addSyncJob(testUserId);
    assert.ok(job && job.id, 'Job should be created');

    const firstClaim = await Db.claimSyncJob(job.id);
    assert.equal(firstClaim.claimed, true, 'First claim should succeed');
    assert.equal(firstClaim.id, job.id);

    const secondClaim = await Db.claimSyncJob(job.id);
    assert.equal(secondClaim.claimed, false, 'Second claim must fail (already RUNNING)');
  });

  test('Db.claimNextSyncJob should atomically select and claim candidate job without race conditions', async () => {
    const job = await Db.addSyncJob(testUserId);
    assert.ok(job && job.id);

    // Simulate two concurrent workers attempting to claim the next pending job simultaneously
    const [workerA, workerB] = await Promise.all([
      Db.claimNextSyncJob(),
      Db.claimNextSyncJob()
    ]);

    const claimedCount = [workerA, workerB].filter(res => res !== null).length;
    assert.equal(claimedCount, 1, 'Exactly one worker must successfully claim the pending job');

    const winner = workerA || workerB;
    assert.equal(winner.id, job.id);
    assert.equal(winner.userId, testUserId);
  });

  test('Python sync_worker process_next_job atomic claim prevents concurrent executions', async () => {
    const job = await Db.addSyncJob(testUserId, { nextRetryAt: Date.now() - 1000 });
    assert.ok(job && job.id);

    const testDbPath = Db.getDbPath ? Db.getDbPath() : path.join(__dirname, '../../webcalendar.db');
    const syncWorkerPy = path.join(__dirname, '../../sync-worker/sync_worker.py');

    // Run Python snippet invoking process_next_job twice concurrently via python threads
    const pyScript = `
import sqlite3
import time
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, '${path.dirname(syncWorkerPy)}')
import sync_worker

def mock_sync(uid):
    time.sleep(0.1)
    return (True, "")
sync_worker.sync_user = mock_sync

db_path = '${testDbPath}'

with ThreadPoolExecutor(max_workers=2) as executor:
    f1 = executor.submit(sync_worker.process_next_job, db_path)
    f2 = executor.submit(sync_worker.process_next_job, db_path)
    r1 = f1.result()
    r2 = f2.result()

print(f"RESULTS:{r1},{r2}")
`;

    const tempPy = path.join(__dirname, 'temp_test_claim.py');
    fs.writeFileSync(tempPy, pyScript);

    try {
      const output = execSync(`python3 ${tempPy}`, { encoding: 'utf8' });
      assert.ok(output.includes('RESULTS:'), `Output should contain RESULTS: ${output}`);

      const resultsPart = output.split('RESULTS:')[1].trim();
      const [r1, r2] = resultsPart.split(',').map(s => s === 'True');
      
      const trueCount = [r1, r2].filter(Boolean).length;
      assert.equal(trueCount, 1, `Exactly one worker must succeed in claiming the job. Got: r1=${r1}, r2=${r2}`);
    } finally {
      if (fs.existsSync(tempPy)) {
        fs.unlinkSync(tempPy);
      }
    }
  });
});
