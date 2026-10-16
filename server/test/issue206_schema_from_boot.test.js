'use strict';

// Issue #206: the schema an install runs on is whatever server/db.js builds at boot, not what
// its source text says. Boots db.js in a separate production process against an empty database
// file, waits for its exported `ready` promise, and then reads the real schema back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const dbModule = path.join(__dirname, '../db.js');

const probe = `
const Db = require(${JSON.stringify(dbModule)});
const all = (sql, p = []) => new Promise((res, rej) => Db.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (sql, p = []) => new Promise((res, rej) => Db.db.run(sql, p, (e) => e ? rej(e) : res()));
(async () => {
  await Db.ready;
  const out = { userVersion: (await all('PRAGMA user_version'))[0].user_version, fks: {} };
  for (const table of ['linked_accounts', 'app_passwords', 'sync_queue']) {
    out.fks[table] = await all('PRAGMA foreign_key_list(' + table + ')');
  }
  await Db.upsertUser('testuser-206', 'testuser');
  await Db.addAppPassword('testuser-206', 'Test ASP');
  await run('INSERT INTO sync_queue (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['sync-206', 'testuser-206', 'PENDING', Date.now(), Date.now()]);
  await run('DELETE FROM users WHERE user_id = ?', ['testuser-206']);
  out.leftAppPasswords = (await all('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?', ['testuser-206']))[0].n;
  out.leftSyncQueue = (await all('SELECT COUNT(*) AS n FROM sync_queue WHERE user_id = ?', ['testuser-206']))[0].n;
  process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
`;

test('Issue #206 — a freshly booted install carries the full schema', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue206-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stdout = execFileSync(process.execPath, ['-e', probe], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_PATH: path.join(dir, 'webcalendar.db'),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE:'));
  assert.ok(line, `probe produced no result:\n${stdout}`);
  const result = JSON.parse(line.slice('PROBE:'.length));
  const { migrations } = require('../utils/migrations');

  await t.test('every shipped migration has run once db.ready resolves', () => {
    assert.equal(result.userVersion, Math.max(...migrations.map((m) => m.version)));
  });

  await t.test('user-owned tables carry ON DELETE CASCADE foreign keys to users', () => {
    for (const [table, fks] of Object.entries(result.fks)) {
      const fk = fks.find((f) => f.table === 'users');
      assert.ok(fk, `${table} has no foreign key to users`);
      assert.equal(fk.from, 'user_id', table);
      assert.equal(fk.to, 'user_id', table);
      assert.equal(fk.on_delete, 'CASCADE', table);
    }
  });

  await t.test('deleting a user row removes its app passwords and sync jobs', () => {
    assert.equal(result.leftAppPasswords, 0);
    assert.equal(result.leftSyncQueue, 0);
  });
});
