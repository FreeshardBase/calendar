'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3297';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Db = require('../db');
const { app, server: appServer } = require('../index');
const { loginAs } = require('./helpers/testSession');

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

describe('Issue #198 — Sync Worker Status & Error Message API Exposure', () => {
  const userId = 'user-198-test-owner';
  const strangerId = 'user-198-test-stranger';
  let server;
  let port;
  let ownerCookie;

  before(async () => {
    await Db.upsertUser(userId, 'user198owner');
    await Db.upsertUser(strangerId, 'user198stranger');
    const targetPort = Number(process.env.PORT || 3297);
    if (!appServer.listening) {
      await new Promise((resolve, reject) => {
        appServer.listen(targetPort, '127.0.0.1', resolve);
        appServer.once('error', reject);
      });
    }
    port = appServer.address().port;
    server = appServer;
    ownerCookie = await loginAs(userId);
  });

  after(() => {
    if (appServer && appServer.close) {
      appServer.close();
    }
  });

  beforeEach(async () => {
    await Db.clearSyncJobsForUser(userId);
    await Db.clearSyncJobsForUser(strangerId);
  });

  test('GET /api/accounts/sync-status returns 401 when unauthenticated', async () => {
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/accounts/sync-status',
      method: 'GET',
      headers: {}
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Authentication required');
  });

  test('GET /api/accounts/sync-status exposes status and error_message for sync jobs', async () => {
    const job = await Db.addSyncJob(userId);
    await Db.updateSyncJobStatus(job.id, 'ERROR', 'vdirsyncer connection failed: 500 Internal Server Error');

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/accounts/sync-status',
      method: 'GET',
      headers: {
        cookie: ownerCookie
      }
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.jobs));
    assert.equal(res.body.jobs.length, 1);
    const returnedJob = res.body.jobs[0];
    assert.equal(returnedJob.id, job.id);
    assert.equal(returnedJob.status, 'ERROR');
    assert.equal(returnedJob.errorMessage, 'vdirsyncer connection failed: 500 Internal Server Error');
  });

  test('GET /api/accounts/sync-status filters sync jobs by authenticated user', async () => {
    const ownerJob = await Db.addSyncJob(userId);
    const strangerJob = await Db.addSyncJob(strangerId);

    await Db.updateSyncJobStatus(ownerJob.id, 'SUCCESS', null);
    await Db.updateSyncJobStatus(strangerJob.id, 'ERROR', 'Stranger job error');

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/accounts/sync-status',
      method: 'GET',
      headers: {
        cookie: ownerCookie
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 1);
    assert.equal(res.body.jobs[0].id, ownerJob.id);
    assert.equal(res.body.jobs[0].status, 'SUCCESS');
  });

  test('GET /api/accounts/sync-jobs/:id returns 401 when unauthenticated', async () => {
    const job = await Db.addSyncJob(userId);
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/accounts/sync-jobs/${job.id}`,
      method: 'GET',
      headers: {}
    });

    assert.equal(res.status, 401);
  });

  test('GET /api/accounts/sync-jobs/:id returns 404 for another user\'s sync job', async () => {
    const strangerJob = await Db.addSyncJob(strangerId);
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/accounts/sync-jobs/${strangerJob.id}`,
      method: 'GET',
      headers: {
        cookie: ownerCookie
      }
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Sync-Job nicht gefunden.');
  });

  test('GET /api/accounts/sync-jobs/:id returns job details including error_message for owner', async () => {
    const job = await Db.addSyncJob(userId);
    await Db.updateSyncJobStatus(job.id, 'ERROR', 'Authentication failed for CalDAV account');

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/accounts/sync-jobs/${job.id}`,
      method: 'GET',
      headers: {
        cookie: ownerCookie
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.id, job.id);
    assert.equal(res.body.userId, userId);
    assert.equal(res.body.status, 'ERROR');
    assert.equal(res.body.errorMessage, 'Authentication failed for CalDAV account');
  });
});
