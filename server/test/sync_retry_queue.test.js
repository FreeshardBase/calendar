'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3092';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Db = require('../db');
const { app, server: appServer } = require('../index');
const { loginAs } = require('./helpers/testSession');
const {
  calculateBackoff,
  scheduleSyncFailure,
  getDueSyncJobs,
  resetSyncJobRetries,
  getSyncQueueStatus
} = require('../utils/syncRetryQueue');

function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('Issue #6 — Automatic Retry Queue for Synchronization Failures Suite', () => {
  const userId = 'testuser-retry-1';
  let server;
  let port;

  before(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await Db.upsertUser(userId, 'userretry1');
    port = process.env.PORT || 3092;
    if (!appServer.listening) {
      await new Promise((resolve) => appServer.listen(port, resolve));
    }
    server = appServer;
  });

  after(() => {
    if (appServer && appServer.close) {
      appServer.close();
    }
  });

  beforeEach(async () => {
    const testUsers = [
      'testuser-retry-1',
      'testuser-retry-init',
      'testuser-retry-fail',
      'testuser-retry-max',
      'testuser-retry-due1',
      'testuser-retry-due2',
      'testuser-retry-reset',
      'testuser-retry-status'
    ];
    for (const u of testUsers) {
      await Db.clearSyncJobsForUser(u);
    }
  });

  test('calculateBackoff computes exponential backoff within bounds', () => {
    assert.equal(calculateBackoff(0, 1000, 30000), 1000);
    assert.equal(calculateBackoff(1, 1000, 30000), 2000);
    assert.equal(calculateBackoff(2, 1000, 30000), 4000);
    assert.equal(calculateBackoff(3, 1000, 30000), 8000);
    assert.equal(calculateBackoff(10, 1000, 30000), 30000); // capped at max
  });

  test('addSyncJob initializes retry metadata (attempts=0, maxAttempts=3, retryState=IDLE)', async () => {
    const testUser = 'testuser-retry-init';
    const job = await Db.addSyncJob(testUser);

    assert.equal(job.userId, testUser);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.equal(job.retryState, 'IDLE');

    const jobs = await Db.getSyncJobs(testUser);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].attempts, 0);
    assert.equal(jobs[0].retryState, 'IDLE');
  });

  test('scheduleSyncFailure auto-retries failed job with exponential backoff', async () => {
    const testUser = 'testuser-retry-fail';
    const job = await Db.addSyncJob(testUser);

    const now = Date.now();
    const updatedJob = await scheduleSyncFailure(job.id, 'Connection reset by peer', {
      baseDelayMs: 5000
    });

    assert.equal(updatedJob.attempts, 1);
    assert.equal(updatedJob.status, 'PENDING');
    assert.equal(updatedJob.retryState, 'RETRY_PENDING');
    assert.ok(updatedJob.nextRetryAt >= now + 5000);
    assert.equal(updatedJob.errorMessage, 'Connection reset by peer');
  });

  test('scheduleSyncFailure transitions to MAX_RETRIES_EXCEEDED when max attempts reached', async () => {
    const testUser = 'testuser-retry-max';
    const job = await Db.addSyncJob(testUser, { maxAttempts: 2 });

    // Attempt 1 failure
    await scheduleSyncFailure(job.id, 'Failure 1', { baseDelayMs: 100 });

    // Attempt 2 failure
    const finalJob = await scheduleSyncFailure(job.id, 'Failure 2', { baseDelayMs: 100 });

    assert.equal(finalJob.attempts, 2);
    assert.equal(finalJob.status, 'ERROR');
    assert.equal(finalJob.retryState, 'MAX_RETRIES_EXCEEDED');
    assert.equal(finalJob.errorMessage, 'Failure 2');
  });

  test('getDueSyncJobs filters out jobs scheduled for future retry', async () => {
    const userId1 = 'testuser-retry-due1';
    const userId2 = 'testuser-retry-due2';

    const job1 = await Db.addSyncJob(userId1);
    const job2 = await Db.addSyncJob(userId2);

    // Job 1 scheduled for future (60s in future)
    await Db.updateSyncJobStatus(job1.id, 'PENDING', 'Temporary glitch', {
      attempts: 1,
      retryState: 'RETRY_PENDING',
      nextRetryAt: Date.now() + 60000
    });

    // Job 2 ready now
    await Db.updateSyncJobStatus(job2.id, 'PENDING', null, {
      attempts: 0,
      retryState: 'IDLE',
      nextRetryAt: Date.now() - 1000
    });

    const dueJobs = await getDueSyncJobs();
    const dueJobIds = dueJobs.map(j => j.id);

    assert.ok(dueJobIds.includes(job2.id));
    assert.ok(!dueJobIds.includes(job1.id));
  });

  test('resetSyncJobRetries resets failed job back to PENDING IDLE state', async () => {
    const testUser = 'testuser-retry-reset';
    const job = await Db.addSyncJob(testUser, { maxAttempts: 2 });

    await scheduleSyncFailure(job.id, 'Error 1', { baseDelayMs: 10 });
    await scheduleSyncFailure(job.id, 'Error 2', { baseDelayMs: 10 });

    let jobs = await Db.getSyncJobs(testUser);
    assert.equal(jobs[0].retryState, 'MAX_RETRIES_EXCEEDED');

    const resetJob = await resetSyncJobRetries(testUser);
    assert.equal(resetJob.status, 'PENDING');
    assert.equal(resetJob.attempts, 0);
    assert.equal(resetJob.retryState, 'IDLE');
    assert.equal(resetJob.errorMessage, null);
  });

  test('getSyncQueueStatus formats user retry queue state correctly', async () => {
    const testUser = 'testuser-retry-status';
    const job = await Db.addSyncJob(testUser);

    await scheduleSyncFailure(job.id, 'Timeout error', { baseDelayMs: 5000 });

    const status = await getSyncQueueStatus(testUser);
    assert.equal(status.userId, testUser);
    assert.equal(status.hasPendingRetry, true);
    assert.equal(status.activeJob.status, 'PENDING');
    assert.equal(status.activeJob.retryState, 'RETRY_PENDING');
  });

  test('GET /api/calendars/sync-queue/status returns 401 for unauthenticated requests', async () => {
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/calendars/sync-queue/status',
      method: 'GET'
    });

    assert.equal(res.status, 401);
  });

  test('GET /api/calendars/sync-queue/status returns sync queue status for session user', async () => {
    const testUser = 'testuser-retry-1';
    await Db.addSyncJob(testUser);

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/calendars/sync-queue/status',
      method: 'GET',
      headers: {
        cookie: await loginAs(testUser)
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.userId, testUser);
    assert.ok(res.body.activeJob);
    assert.equal(res.body.activeJob.status, 'PENDING');
  });

  test('POST /api/calendars/sync-queue/retry resets failed sync retries and enqueues job', async () => {
    const testUser = 'testuser-retry-1';
    const job = await Db.addSyncJob(testUser, { maxAttempts: 1 });
    await scheduleSyncFailure(job.id, 'Fatal error', { baseDelayMs: 10 });

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/calendars/sync-queue/retry',
      method: 'POST',
      headers: {
        cookie: await loginAs(testUser),
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.job.status, 'PENDING');
    assert.equal(res.body.job.attempts, 0);
    assert.equal(res.body.job.retryState, 'IDLE');
  });
});
