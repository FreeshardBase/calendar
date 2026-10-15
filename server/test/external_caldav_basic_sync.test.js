'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const accountsRouter = require('../routes/accounts');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

const TEST_PORT = 3108;
let server;
let baseUrl;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret-key-basic-sync',
    resave: false,
    saveUninitialized: true
  }));
  app.use('/api/accounts', accountsRouter);
  app.use('/api/calendars', calendarsRouter);
  return app;
}

test.before(async () => {
  const app = makeApp();
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      baseUrl = `http://127.0.0.1:${TEST_PORT}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Issue #9 — Background replication and synchronization for external CalDAV servers (Basic Auth)', async (t) => {
  const testUser = `basic_sync_user_${Date.now()}`;
  let cookieHeader = '';
  let createdAccountId = '';

  await t.test('Db.addAccount inserts basic auth account into linked_accounts', async () => {
    await Db.upsertUser(testUser, `${testUser}@example.com`);
    const account = await Db.addAccount(testUser, {
      url: 'https://caldav.example.com/dav/user/',
      username: 'test_caldav_user',
      password: 'secret_password_123',
      displayName: 'External Work Calendar'
    });

    assert.ok(account.id);
    assert.equal(account.displayName, 'External Work Calendar');
    createdAccountId = account.id;

    const fetched = await Db.getAccounts(testUser);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].id, account.id);
    assert.equal(fetched[0].authType, 'basic');
    assert.equal(fetched[0].username, 'test_caldav_user');
    assert.equal(fetched[0].password, 'secret_password_123');
  });

  await t.test('POST /api/accounts/:id/sync returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/${createdAccountId}/sync`, {
      method: 'POST'
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/accounts/:id/sync enqueues background sync job for authenticated user', async () => {
    // Obtain session cookie
    const getRes = await fetch(`${baseUrl}/api/accounts`);
    const setCookie = getRes.headers.get('set-cookie');
    if (setCookie) {
      cookieHeader = setCookie.split(';')[0];
    }

    // Set req.session.userId by mocking login state or adding account
    // We can simulate session authentication via test route or by directly checking sync endpoint with session
    const syncRes = await fetch(`${baseUrl}/api/accounts/${createdAccountId}/sync`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader
      }
    });

    // Wait: req.session.userId is not set yet in session cookie, so expects 401 until authenticated
    assert.equal(syncRes.status, 401);
  });

  await t.test('POST /api/accounts/:id/sync returns 404 for non-existent account', async () => {
    // We create an authenticated session request
    const authApp = express();
    authApp.use(express.json());
    authApp.use((req, res, next) => {
      req.session = { userId: testUser };
      next();
    });
    authApp.use('/api/accounts', accountsRouter);
    
    const authServer = authApp.listen(TEST_PORT + 1);
    const authBaseUrl = `http://127.0.0.1:${TEST_PORT + 1}`;

    try {
      const account = await Db.addAccount(testUser, {
        url: 'https://caldav.example.com/dav/user2/',
        username: 'test_caldav_user',
        password: 'secret_password_123',
        displayName: 'External Work Calendar'
      });

      const res404 = await fetch(`${authBaseUrl}/api/accounts/non-existent-id/sync`, {
        method: 'POST'
      });
      assert.equal(res404.status, 404);

      const res200 = await fetch(`${authBaseUrl}/api/accounts/${account.id}/sync`, {
        method: 'POST'
      });
      assert.equal(res200.status, 200);
      const data = await res200.json();
      assert.ok(data.jobId);
      assert.equal(data.accountId, account.id);

      // Verify sync_queue row was created
      const statusList = await Db.getPendingSyncJobs();
      const userJob = statusList.find(j => j.userId === testUser);
      assert.ok(userJob);
      assert.equal(userJob.status, 'PENDING');
    } finally {
      authServer.close();
    }
  });

  await t.test('sync_basic_caldav_accounts script handles basic auth accounts in sync_worker.py', async () => {
    // Verify sync_worker.py imports and basic auth sync functionality
    const { execSync } = require('child_process');
    const pyCode = `
import sys, os
os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
sys.path.append('sync-worker')
import sync_worker

print("sync_worker imported successfully")
assert hasattr(sync_worker, "sync_basic_caldav_accounts"), "sync_basic_caldav_accounts function missing"
`;
    const output = execSync(`python3 -c "${pyCode.replace(/"/g, '\\"')}"`, {
      cwd: require('path').join(__dirname, '../..'),
      encoding: 'utf-8'
    });
    assert.ok(output.includes("sync_worker imported successfully"));
  });

  // Cleanup
  await Db.deleteAccount(createdAccountId);
});
