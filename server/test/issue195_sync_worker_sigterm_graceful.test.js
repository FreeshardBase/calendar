'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const sharedTestDbKeyEnv = require('./helpers/sharedTestDbKeyEnv');

// Resolves once the child prints `marker`. Rejects if the child exits first (e.g. an
// ImportError for a missing worker dependency) or stays silent for 15 s, so a broken
// environment fails this file instead of wedging `npm test` until the CI ceiling (#204).
function waitForMarker(child, marker) {
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`No ${marker} from sync_worker child within 15 s. stderr:\n${stderr}`));
    }, 15000);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', data => {
      stdout += data.toString();
      if (stdout.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    // 'close' rather than 'exit': it fires after stderr is drained, so the traceback is complete.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sync_worker child exited (code ${code}, signal ${signal}) before printing ${marker}. stderr:\n${stderr}`));
    });
  });
}

// Sends SIGTERM and resolves with [code, signal]. The child scripts keep running for 5 s,
// so a handler that does not exit (or blocks) is caught here instead of hanging the file.
function terminateAndWait(child, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sync_worker child did not exit within ${ms} ms of SIGTERM`));
    }, ms);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
    child.kill('SIGTERM');
  });
}

describe('Issue #195 — Sync Worker SIGTERM Signal & Graceful Exit Suite', () => {
  const scriptDir = path.join(__dirname, '../../sync-worker');
  const dbPath = Db.getDbPath();

  test('sync_worker process registers SIGTERM handler and exits cleanly on SIGTERM', async () => {
    const pyCode = `
import sys, time
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import sync_worker

print("READY", flush=True)
for _ in range(50):
    time.sleep(0.1)
`;

    const child = spawn('python3', ['-c', pyCode], {
      env: { ...process.env, ...sharedTestDbKeyEnv, DATABASE_PATH:dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await waitForMarker(child, 'READY');

    const [code, signal] = await terminateAndWait(child);

    // Without a handler Python dies from the signal itself (signal 'SIGTERM'); the handler exits 0.
    assert.deepEqual([code, signal], [0, null], `Process exited with code ${code} and signal ${signal}`);
  });

  test('sync_worker resets stranded RUNNING jobs back to PENDING on startup', async () => {
    const userId = 'testuser-sigterm-startup';
    await Db.clearSyncJobsForUser(userId);

    const job = await Db.addSyncJob(userId, { maxAttempts: 3 });
    await new Promise((resolve, reject) => {
      Db.db.run(
        "UPDATE sync_queue SET status = 'RUNNING' WHERE id = ?",
        [job.id],
        err => (err ? reject(err) : resolve())
      );
    });

    let jobs = await Db.getSyncJobs(userId);
    assert.equal(jobs[0].status, 'RUNNING');

    const pyCode = `
import sys
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import sync_worker

count = sync_worker.recover_stranded_jobs(${JSON.stringify(dbPath)})
print(f"RECOVERED:{count}")
`;

    const out = execFileSync('python3', ['-c', pyCode], {
      env: { ...process.env, ...sharedTestDbKeyEnv, DATABASE_PATH:dbPath },
      encoding: 'utf8'
    }).trim();

    assert.ok(out.includes('RECOVERED:'), 'Should output RECOVERED count');

    jobs = await Db.getSyncJobs(userId);
    assert.ok(jobs && jobs.length > 0, 'Jobs must exist in sync_queue for user');
    assert.equal(jobs[0].status, 'PENDING', 'Stranded job must be reset to PENDING on startup');

    await Db.clearSyncJobsForUser(userId);
  });

  test('sync_worker resets active RUNNING job to PENDING on SIGTERM shutdown', async () => {
    const userId = 'testuser-sigterm-active';
    await Db.clearSyncJobsForUser(userId);

    const job = await Db.addSyncJob(userId, { maxAttempts: 3 });
    await new Promise((resolve, reject) => {
      Db.db.run(
        "UPDATE sync_queue SET status = 'RUNNING' WHERE id = ?",
        [job.id],
        err => (err ? reject(err) : resolve())
      );
    });

    const pyCode = `
import sys, time
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import sync_worker

sync_worker.active_job_id = ${JSON.stringify(job.id)}
sync_worker.active_job_db_path = ${JSON.stringify(dbPath)}

print("ACTIVE_JOB_READY", flush=True)
time.sleep(5)
`;

    const child = spawn('python3', ['-c', pyCode], {
      env: { ...process.env, ...sharedTestDbKeyEnv, DATABASE_PATH:dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await waitForMarker(child, 'ACTIVE_JOB_READY');

    await terminateAndWait(child);

    const updatedJob = await new Promise((resolve, reject) => {
      Db.db.get("SELECT * FROM sync_queue WHERE id = ?", [job.id], (err, row) => err ? reject(err) : resolve(row));
    });
    assert.ok(updatedJob, 'Active job must exist in sync_queue');
    assert.equal(updatedJob.status, 'PENDING', 'Active job must be reset to PENDING when SIGTERM is caught');

    await Db.clearSyncJobsForUser(userId);
  });
});
