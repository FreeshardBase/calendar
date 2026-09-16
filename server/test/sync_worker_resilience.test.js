'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { execFileSync } = require('child_process');
const path = require('path');

describe('Issue #62 — Sync Worker Exception Guard & Expiration Mismatch Suite', () => {
  const scriptDir = path.join(__dirname, '../../sync-worker');
  const dbPath = (Db.getDbPath && Db.getDbPath()) || Db.dbPath || process.env.DATABASE_PATH || path.resolve(__dirname, '../webcalendar.test.db');

  test('sync_worker process_next_job recovers from unguarded exceptions and does not strand job in RUNNING', async () => {
    const targetDbPath = Db.getDbPath ? Db.getDbPath() : Db.dbPath;
    const userId = 'testuser-unguarded-exc';
    await Db.withTransaction(async (tx) => {
      await tx.run('DELETE FROM sync_queue');
    });

    const job = await Db.addSyncJob(userId, { maxAttempts: 3, nextRetryAt: Date.now() - 1000 });
    assert.equal(job.status, 'PENDING');

    const pyCode = `
import sys, os, sqlite3, time
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import sync_worker

def failing_sync_user(user_id):
    raise RuntimeError("Simulated crash in sync_user")

sync_worker.sync_user = failing_sync_user
res = sync_worker.process_next_job(${JSON.stringify(targetDbPath)})
print(f"PY_RES:{res}, NOW:{int(time.time()*1000)}")
`;

    execFileSync('python3', ['-c', pyCode], {
      env: { ...process.env, DATABASE_PATH: targetDbPath },
      encoding: 'utf8'
    });

    const userJobs = await Db.getSyncJobs(userId);
    assert.equal(userJobs.length, 1);
    assert.notEqual(userJobs[0].status, 'RUNNING', 'Job must not remain in RUNNING status');
    assert.equal(userJobs[0].status, 'PENDING');
    assert.equal(userJobs[0].attempts, 1);
    assert.equal(userJobs[0].retryState, 'RETRY_PENDING');
    assert.ok(userJobs[0].errorMessage.includes('Simulated crash in sync_user'));

    await Db.clearSyncJobsForUser(userId);
  });

  test('refresh_google_token returns expires_at timestamp in milliseconds', () => {
    const pyCode = `
import sys, os, time, json
sys.path.insert(0, ${JSON.stringify(scriptDir)})
from sync_worker import refresh_google_token
import urllib.request

class MockResponse:
    def read(self):
        return json.dumps({"access_token": "new-tok-123", "expires_in": 3600}).encode('utf-8')
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass

urllib.request.urlopen = lambda req: MockResponse()

token, expires_at = refresh_google_token("refresh-tok-123")
now_ms = int(time.time() * 1000)
print(f"TOK:{token},EXP:{expires_at},NOW:{now_ms}")
`;

    const out = execFileSync('python3', ['-c', pyCode], {
      env: { ...process.env, DATABASE_PATH: dbPath },
      encoding: 'utf8'
    }).trim();

    const expMatch = out.match(/EXP:(\d+)/);
    assert.ok(expMatch, 'Must output expiration timestamp');
    const expiresAt = parseInt(expMatch[1], 10);
    assert.ok(expiresAt > 10000000000, `expires_at timestamp (${expiresAt}) must be in milliseconds (> 10^10)`);
  });
});
