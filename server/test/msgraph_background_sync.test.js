'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3397';
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
  server.listen(process.env.PORT);
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

  await t.test('POST /api/msgraph/accounts/:id/sync enqueues a sync job for the worker', async () => {
    const account = await Db.addMSGraphAccount({
      userId,
      accountEmail: 'testuser@example.com',
      accessToken: 'testuser-access-token',
      refreshToken: 'testuser-refresh-token'
    });

    const res = await fetch(`${baseUrl}/api/msgraph/accounts/${account.id}/sync`, {
      method: 'POST',
      headers: { cookie: userCookie }
    });

    assert.equal(res.status, 202, await res.clone().text());
    const data = await res.json();
    assert.ok(data.success);
    assert.equal(data.job.status, 'PENDING');

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
      refreshToken: 'py-refresh-token',
      expiresAt: Date.now() + 3600000
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
      "page.__enter__.return_value.read.return_value = b'{\"value\": [], \"@odata.deltaLink\": \"https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=x\"}'",
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
