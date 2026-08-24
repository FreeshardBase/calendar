'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3098';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { execSync } = require('child_process');
const path = require('path');

test('Issue #10 — M365 / Outlook Background Synchronization Suite', async (t) => {
  const { app, server } = require('../index');

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'msgraph-bg-user-id';

  await t.test('POST /api/msgraph/accounts should automatically enqueue a PENDING sync job', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({
        accountEmail: 'm365user@example.com',
        tenantId: 'common',
        clientId: 'test-m365-client'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(data.account.id);

    const pendingJobs = await Db.getPendingSyncJobs();
    const userJob = pendingJobs.find(j => j.userId === userId);
    assert.ok(userJob, 'Sync job should be enqueued in sync_queue table upon MS Graph account registration');
    assert.equal(userJob.status, 'PENDING');

    await Db.deleteMSGraphAccount(data.account.id);
  });

  await t.test('POST /api/msgraph/accounts/:id/sync should enqueue sync job and trigger sync engine', async () => {
    const account = await Db.addMSGraphAccount({
      userId,
      accountEmail: 'outlookuser@example.com',
      tenantId: 'common',
      clientId: 'client-999',
      accessToken: 'token-999',
      refreshToken: 'refresh-999'
    });

    const res = await fetch(`${baseUrl}/api/msgraph/accounts/${account.id}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({ localEvents: [] })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);

    const pendingJobs = await Db.getPendingSyncJobs();
    const userJob = pendingJobs.find(j => j.userId === userId);
    assert.ok(userJob, 'Sync job should be enqueued on manual trigger endpoint');

    await Db.deleteMSGraphAccount(account.id);
  });

  await t.test('sync_worker.py sync_user executes MS Graph background replication', async () => {
    const account = await Db.addMSGraphAccount({
      userId: 'py-msgraph-user',
      accountEmail: 'py-m365@example.com',
      accessToken: 'py-access-token',
      refreshToken: 'py-refresh-token'
    });

    const scriptDir = path.join(__dirname, '../../sync-worker');
    const dbPath = path.resolve(__dirname, '../../webcalendar.db');
    const pyCmd = `python3 -c "import sys, os, sqlite3; sys.path.insert(0, '${scriptDir}'); from sync_worker import sync_user; conn = sqlite3.connect('${dbPath}'); conn.row_factory = sqlite3.Row; res, err = sync_user('py-msgraph-user'); print(f'SUCCESS:{res},ERR:{err}')"`;

    const out = execSync(pyCmd, {
      env: { ...process.env, DATABASE_PATH: dbPath },
      encoding: 'utf8'
    });

    assert.ok(out.includes('SUCCESS:True'));

    const updatedAccount = await Db.getMSGraphAccountById(account.id);
    assert.ok(updatedAccount);
    assert.ok(updatedAccount.updatedAt > 0);

    await Db.deleteMSGraphAccount(account.id);
  });
});
