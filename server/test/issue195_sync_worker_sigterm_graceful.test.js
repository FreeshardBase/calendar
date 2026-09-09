'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

describe('Issue #195 — Sync Worker SIGTERM Signal & Graceful Exit Suite', () => {
  const scriptDir = path.join(__dirname, '../../sync-worker');
  const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../../webcalendar.db');

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
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    child.stdout.on('data', data => { stdout += data.toString(); });

    await new Promise(resolve => {
      const check = setInterval(() => {
        if (stdout.includes('READY')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    child.kill('SIGTERM');

    const [code, signal] = await new Promise(resolve => {
      child.on('exit', (c, s) => resolve([c, s]));
    });

    assert.ok(code === 0 || signal === 'SIGTERM', `Process exited with code ${code} and signal ${signal}`);
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
      env: { ...process.env, DATABASE_PATH: dbPath },
      encoding: 'utf8'
    }).trim();

    assert.ok(out.includes('RECOVERED:'), 'Should output RECOVERED count');

    jobs = await Db.getSyncJobs(userId);
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
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    child.stdout.on('data', data => { stdout += data.toString(); });

    await new Promise(resolve => {
      const check = setInterval(() => {
        if (stdout.includes('ACTIVE_JOB_READY')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    child.kill('SIGTERM');

    await new Promise(resolve => child.on('exit', resolve));

    const updatedJob = await new Promise((resolve, reject) => {
      Db.db.get("SELECT * FROM sync_queue WHERE id = ?", [job.id], (err, row) => err ? reject(err) : resolve(row));
    });
    assert.equal(updatedJob.status, 'PENDING', 'Active job must be reset to PENDING when SIGTERM is caught');

    await Db.clearSyncJobsForUser(userId);
  });
});
