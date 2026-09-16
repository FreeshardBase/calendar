'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3091';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Db = require('../db');
const { app, server: appServer } = require('../index');
const { queueSyncForCalendar } = require('../utils/calendarAuth');

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

describe('Issue #323 — Sync Queue Request Owner Authorization Verification', () => {
  const ownerUserId = '00000000-3230-4000-8000-000000000001';
  const strangerUserId = '00000000-3230-4000-8000-000000000002';
  const calendarId = `internal-caldav::/${ownerUserId}/personal/`;
  let server;
  let port;

  before(async () => {
    await Db.upsertUser(ownerUserId, 'owner323');
    await Db.upsertUser(strangerUserId, 'stranger323');
    port = process.env.PORT || 3091;
    if (!appServer.listening) {
      await new Promise(r => appServer.listen(port, r));
    }
    server = appServer;
  });

  after(() => {
    if (appServer && appServer.close) {
      appServer.close();
    }
  });

  beforeEach(async () => {
    await Db.clearSyncJobsForUser(ownerUserId);
    await Db.clearSyncJobsForUser(strangerUserId);
  });

  test('queueSyncForCalendar refrains from queueing owner sync job when requesting user is unauthorized', async () => {
    await queueSyncForCalendar(calendarId, strangerUserId);

    const ownerJobs = await Db.getSyncJobs(ownerUserId);
    assert.equal(ownerJobs.length, 0, 'Owner sync queue must not contain jobs from unauthorized request');
  });

  test('queueSyncForCalendar enqueues sync job when requesting user is calendar owner', async () => {
    await queueSyncForCalendar(calendarId, ownerUserId);

    const ownerJobs = await Db.getSyncJobs(ownerUserId);
    assert.equal(ownerJobs.length, 1, 'Owner sync queue must receive job when requested by owner');
    assert.equal(ownerJobs[0].userId, ownerUserId);
  });

  test('POST /api/calendars/:id/sync-queue returns 401 for unauthenticated requests', async () => {
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/calendars/${encodeURIComponent(calendarId)}/sync-queue`,
      method: 'POST',
      headers: {
        'x-test-user-id': 'unauthenticated'
      }
    });

    assert.equal(res.status, 401);
  });

  test('POST /api/calendars/:id/sync-queue returns 403 when user has no access to calendar', async () => {
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/calendars/${encodeURIComponent(calendarId)}/sync-queue`,
      method: 'POST',
      headers: {
        'x-test-user-id': strangerUserId,
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.status, 403);
    const ownerJobs = await Db.getSyncJobs(ownerUserId);
    assert.equal(ownerJobs.length, 0);
  });

  test('POST /api/calendars/:id/sync-queue enqueues sync job for authorized calendar owner', async () => {
    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/calendars/${encodeURIComponent(calendarId)}/sync-queue`,
      method: 'POST',
      headers: {
        'x-test-user-id': ownerUserId,
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.status, 201, `Expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    const ownerJobs = await Db.getSyncJobs(ownerUserId);
    assert.equal(ownerJobs.length, 1);
  });

  test('POST /api/msgraph/accounts/:id/sync returns 403 when user attempts to sync another user account', async () => {
    const account = await Db.addMSGraphAccount({
      userId: ownerUserId,
      tenantId: 'common',
      clientId: 'test-client-id',
      accountEmail: 'owner323@example.com',
      accessToken: 'token-323',
      refreshToken: 'refresh-323',
      expiresAt: Date.now() + 3600000,
      targetCalendarId: 'cal-323'
    });

    const res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/msgraph/accounts/${account.id}/sync`,
      method: 'POST',
      headers: {
        'x-test-user-id': strangerUserId,
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.status, 403);
  });
});
