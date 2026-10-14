'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const Db = require('../db');
const {
  getSchemaVersion,
  setSchemaVersion,
  runMigrations,
  migrations
} = require('../utils/migrations');

test('Issue #139 — Schema Migration System', async (t) => {
  const tmpDbPath = path.join(__dirname, `scratch_test_migration_${Date.now()}.db`);

  t.after(() => {
    for (const file of [tmpDbPath, `${tmpDbPath}-wal`, `${tmpDbPath}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  });

  await t.test('getSchemaVersion and setSchemaVersion read and set PRAGMA user_version', async () => {
    const testDb = new sqlite3.Database(tmpDbPath);
    try {
      const v0 = await getSchemaVersion(testDb);
      assert.equal(typeof v0, 'number');
      assert.equal(v0, 0);

      await setSchemaVersion(testDb, 5);
      const v5 = await getSchemaVersion(testDb);
      assert.equal(v5, 5);
    } finally {
      testDb.close();
    }
  });

  await t.test('runMigrations applies pending migrations sequentially and updates user_version', async () => {
    const memDbPath = path.join(__dirname, `scratch_test_migration_run_${Date.now()}.db`);
    const testDb = new sqlite3.Database(memDbPath);

    try {
      // Initialize base tables first
      await new Promise((resolve, reject) => {
        testDb.serialize(() => {
          testDb.run(`CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, display_name TEXT)`);
          testDb.run(`CREATE TABLE sync_queue (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)`, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      const initialVersion = await getSchemaVersion(testDb);
      assert.equal(initialVersion, 0);

      const customMigrations = [
        {
          version: 1,
          name: 'add_linked_accounts_columns',
          up: async (db) => {
            await new Promise((res, rej) => {
              db.run(`ALTER TABLE linked_accounts ADD COLUMN auth_type TEXT DEFAULT 'basic'`, (err) => {
                if (err && !err.message.includes('duplicate column')) return rej(err);
                res();
              });
            });
          }
        },
        {
          version: 2,
          name: 'add_sync_queue_retry_columns',
          up: async (db) => {
            await new Promise((res, rej) => {
              db.run(`ALTER TABLE sync_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column')) return rej(err);
                res();
              });
            });
          }
        }
      ];

      const result = await runMigrations(testDb, customMigrations);
      assert.equal(result.initialVersion, 0);
      assert.equal(result.currentVersion, 2);
      assert.equal(result.appliedCount, 2);
      assert.deepEqual(result.appliedVersions, [1, 2]);

      const finalVersion = await getSchemaVersion(testDb);
      assert.equal(finalVersion, 2);

      // Re-running applied migrations should be idempotent (0 applied)
      const rerunResult = await runMigrations(testDb, customMigrations);
      assert.equal(rerunResult.initialVersion, 2);
      assert.equal(rerunResult.currentVersion, 2);
      assert.equal(rerunResult.appliedCount, 0);
    } finally {
      testDb.close();
      if (fs.existsSync(memDbPath)) fs.unlinkSync(memDbPath);
    }
  });

  await t.test('runMigrations halts on failure without corrupting applied version', async () => {
    const memDbPath = path.join(__dirname, `scratch_test_migration_err_${Date.now()}.db`);
    const testDb = new sqlite3.Database(memDbPath);

    try {
      const failingMigrations = [
        {
          version: 1,
          name: 'successful_step',
          up: async (db) => {
            await new Promise((res, rej) => db.run(`CREATE TABLE step1 (id INT)`, (err) => err ? rej(err) : res()));
          }
        },
        {
          version: 2,
          name: 'failing_step',
          up: async () => {
            throw new Error('Migration failed intentionally');
          }
        },
        {
          version: 3,
          name: 'unreachable_step',
          up: async (db) => {
            await new Promise((res, rej) => db.run(`CREATE TABLE step3 (id INT)`, (err) => err ? rej(err) : res()));
          }
        }
      ];

      await assert.rejects(
        async () => {
          await runMigrations(testDb, failingMigrations);
        },
        {
          name: 'Error',
          message: /Migration failed intentionally/
        }
      );

      const currentVersion = await getSchemaVersion(testDb);
      assert.equal(currentVersion, 1);
    } finally {
      testDb.close();
      if (fs.existsSync(memDbPath)) fs.unlinkSync(memDbPath);
    }
  });

  await t.test('Db exports migration methods and defaults to active schema version', async () => {
    assert.equal(typeof Db.getSchemaVersion, 'function');
    assert.equal(typeof Db.runMigrations, 'function');
    assert.ok(Array.isArray(Db.migrations));
    assert.ok(Db.migrations.length > 0);

    const version = await Db.getSchemaVersion();
    assert.ok(typeof version === 'number');
    assert.ok(version >= Db.migrations[Db.migrations.length - 1].version);
  });
});
