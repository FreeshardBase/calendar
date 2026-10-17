'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3128';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
// #537: /internal/* checks the secret under every NODE_ENV.
const INTERNAL_SECRET = 'testuser-internal-secret-120';
process.env.INTERNAL_WEBHOOK_SECRET = INTERNAL_SECRET;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../db');
const { server } = require('../index');

describe('Issue #120 — SQLite WAL Quiesce, Backup & Restorability Verification', () => {
  const backupDir = path.join(__dirname, 'scratch');
  const backupPath = path.join(backupDir, 'webcalendar_backup_test.db');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  before(async () => {
    if (server && !server.listening) {
      await new Promise(resolve => server.listen(process.env.PORT, resolve));
    }
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      if (server.close) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (server.unref) {
        server.unref();
      }
    }
  });

  it('should execute wal_checkpoint(TRUNCATE) via Db.quiesceDatabase', async () => {
    assert.strictEqual(typeof Db.quiesceDatabase, 'function', 'Db.quiesceDatabase must be exported as a function');
    const result = await Db.quiesceDatabase('TRUNCATE');
    assert.ok(result, 'quiesceDatabase must return a result object');
    assert.strictEqual(typeof result.busy, 'number', 'result.busy must be a number');
    assert.strictEqual(typeof result.log, 'number', 'result.log must be a number');
    assert.strictEqual(typeof result.checkpointed, 'number', 'result.checkpointed must be a number');
    assert.strictEqual(result.busy, 0, 'WAL checkpoint must not be blocked/busy');
  });

  it('should create an atomic, restorable backup file using Db.createBackup', async () => {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    assert.strictEqual(typeof Db.createBackup, 'function', 'Db.createBackup must be exported as a function');
    const backupResult = await Db.createBackup(backupPath);
    assert.ok(backupResult, 'createBackup must return result');
    assert.strictEqual(fs.existsSync(backupPath), true, 'Backup DB file must exist');

    const stats = fs.statSync(backupPath);
    assert.ok(stats.size > 0, 'Backup DB file must not be empty');

    const isHealthy = await Db.verifyDatabaseIntegrity(backupPath);
    assert.strictEqual(isHealthy, true, 'Backup database must pass PRAGMA integrity_check');

    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  });

  it('should expose internal endpoint /internal/db/quiesce to allow shard backup quiescing', async () => {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT}/internal/db/quiesce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-freeshard-secret': INTERNAL_SECRET }
    });

    assert.strictEqual(res.status, 200, 'Internal endpoint must respond with 200 OK');
    const body = await res.json();
    assert.strictEqual(body.success, true, 'Response body must contain success: true');
    assert.ok(body.details, 'Response body must contain checkpoint details');
    assert.strictEqual(body.details.busy, 0, 'Checkpoint busy count must be 0');
  });
});
