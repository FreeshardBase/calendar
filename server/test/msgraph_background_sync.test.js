'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3397';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { execSync } = require('child_process');
const path = require('path');
const sharedTestDbKeyEnv = require('./helpers/sharedTestDbKeyEnv');

test('Issue #10 — M365 / Outlook Background Synchronization Suite', async (t) => {
  const { app, server } = require('../index');
  const { loginAs } = require('./helpers/testSession');
  await new Promise(r => setTimeout(r, 100));
  await Db.clearAll();

  t.after(() => {
    delete process.env.PORT;
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'msgraph-bg-user-id';
  const userCookie = await loginAs(userId);

  await t.test('POST /api/msgraph/accounts should automatically enqueue a PENDING sync job', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: userCookie
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

    // Microsoft is stubbed: an unreachable Graph API is a sync error (#343), not an empty sync.
    const realFetch = globalThis.fetch;
    const graphCalls = [];
    globalThis.fetch = async (url, opts) => {
      const href = String(url);
      if (href.startsWith('https://login.microsoftonline.com/')) {
        graphCalls.push(href);
        return new Response(JSON.stringify({ access_token: 'token-1000', expires_in: 3600 }), { status: 200 });
      }
      if (href.startsWith('https://graph.microsoft.com/')) {
        graphCalls.push(href);
        return new Response(JSON.stringify({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?token=1' }), { status: 200 });
      }
      return realFetch(url, opts);
    };
    let res;
    try {
      res = await fetch(`${baseUrl}/api/msgraph/accounts/${account.id}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userCookie
        },
        body: JSON.stringify({ localEvents: [] })
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(graphCalls.some((u) => u.startsWith('https://graph.microsoft.com/')), 'the sync engine must query Graph');
    const data = await res.json();
    assert.ok(data.success);

    const jobs = await Db.getSyncJobs(userId);
    const userJob = jobs.find(j => j.userId === userId);
    assert.ok(userJob, 'Sync job should be enqueued on manual trigger endpoint');

    await Db.deleteMSGraphAccount(account.id);
  });

  await t.test('sync_worker.py sync_user executes MS Graph background replication', async () => {
    const account = await Db.addMSGraphAccount({
      userId: 'py-msgraph-user',
      accountEmail: 'py-m365@example.com',
      accessToken: 'py-access-token',
      refreshToken: 'mock-py-refresh-token'
    });

    const scriptDir = path.join(__dirname, '../../sync-worker');
    const dbPath = process.env.DATABASE_PATH || (Db.getDbPath && Db.getDbPath()) || path.resolve(__dirname, '../../webcalendar.db');
    // Graph answers with an empty delta page; an unreachable Graph API fails the sync (#343).
    const code = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(scriptDir)})`,
      'from unittest.mock import MagicMock, patch',
      'import msgraph_worker',
      'from sync_worker import sync_user',
      'page = MagicMock()',
      "page.__enter__.return_value.read.return_value = b'{\"value\": []}'",
      "with patch.object(msgraph_worker.urllib.request, 'urlopen', return_value=page):",
      "    res, err = sync_user('py-msgraph-user')",
      "print(f'SUCCESS:{res},ERR:{err}')"
    ].join('\n');

    const out = execSync('python3', {
      input: code,
      env: { ...process.env, ...sharedTestDbKeyEnv, DATABASE_PATH:dbPath },
      encoding: 'utf8'
    });

    assert.ok(out.includes('SUCCESS:True'));

    const updatedAccount = await Db.getMSGraphAccountById(account.id);
    assert.ok(updatedAccount);
    assert.ok(updatedAccount.updatedAt > 0);

    await Db.deleteMSGraphAccount(account.id);
  });
});
