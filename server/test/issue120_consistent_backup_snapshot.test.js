'use strict';

/**
 * Issue #120 — the shard backup (`rclone sync` of the app data directory at 03:00) copies the live
 * WAL-mode `webcalendar.db`, `-wal` and `-shm` at three different instants, which restores torn.
 *
 * The app therefore keeps a consistent snapshot, `webcalendar.db.backup`, next to the live
 * database: written with `VACUUM INTO` (a single read transaction, so commits that still live only
 * in the WAL are included and concurrent writers cannot tear it), checked with
 * `PRAGMA integrity_check`, and renamed into place so the backup never sees a half-written file.
 * The server process writes it at boot and then hourly.
 *
 * Tests here restore the snapshot (open it as a database of its own) while another connection keeps
 * committing inserts and deletes, and check integrity and row counts against the source.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue120-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const Db = require('../db');
const { startDbBackupWorker } = require('../utils/dbBackup');

const PROBE_ROWS = 500;

function open(file, mode) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(conn)));
  });
}
const exec = (conn, sql) => new Promise((resolve, reject) => conn.exec(sql, (err) => (err ? reject(err) : resolve())));
const get = (conn, sql) => new Promise((resolve, reject) => conn.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
const close = (conn) => new Promise((resolve, reject) => conn.close((err) => (err ? reject(err) : resolve())));

function payload(i) {
  return `testuser-${i}-`.padEnd(20 + ((i * 37) % 400), 'x');
}

// Opens the file the way a restore would (a fresh process, no sidecars) and reports what it holds.
async function restoreAndInspect(file) {
  const conn = await open(file, sqlite3.OPEN_READONLY);
  try {
    const integrity = Object.values(await get(conn, 'PRAGMA integrity_check'))[0];
    const { n } = await get(conn, 'SELECT count(*) AS n FROM backup_probe');
    const { users } = await get(conn, 'SELECT count(*) AS users FROM users');
    return { integrity, rows: n, users };
  } finally {
    await close(conn);
  }
}

// A second connection that never checkpoints, so every commit stays in the WAL, and that keeps the
// b-tree churning (variable-length inserts plus deletes) while the row count stays constant.
async function startWriter(dbPath) {
  const conn = await open(dbPath, sqlite3.OPEN_READWRITE);
  await exec(conn, 'PRAGMA busy_timeout = 30000; PRAGMA wal_autocheckpoint = 0;');
  await exec(conn, 'CREATE TABLE IF NOT EXISTS backup_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  let next = 0;
  const insertBatch = (count) => {
    const values = [];
    for (let i = 0; i < count; i++, next++) values.push(`(${next}, '${payload(next)}')`);
    return `INSERT INTO backup_probe (id, payload) VALUES ${values.join(',')};`;
  };
  await exec(conn, `BEGIN; ${insertBatch(PROBE_ROWS)} COMMIT;`);

  let running = true;
  let batches = 0;
  const loop = (async () => {
    while (running) {
      await exec(conn, `BEGIN IMMEDIATE; ${insertBatch(50)}
        DELETE FROM backup_probe WHERE id IN (SELECT id FROM backup_probe ORDER BY id LIMIT 50); COMMIT;`);
      batches++;
    }
  })();
  return {
    conn,
    batches: () => batches,
    async stop() { running = false; await loop; },
  };
}

test.describe('Issue #120 — consistent webcalendar.db.backup snapshot', () => {
  const snapshotPath = `${process.env.DATABASE_PATH}.backup`;
  let writer;

  test.before(async () => {
    await Db.ready;
    await Db.upsertUser('testuser-id', 'testuser', 'testuser@example.com');
    writer = await startWriter(process.env.DATABASE_PATH);
  });

  test.after(async () => {
    await writer.stop();
    await close(writer.conn);
  });

  test('the snapshot is written next to the live database', () => {
    assert.equal(Db.backupPath, snapshotPath);
  });

  test('the backup worker writes a restorable snapshot holding every committed row while writes continue', async () => {
    const walSize = fs.statSync(`${process.env.DATABASE_PATH}-wal`).size;
    assert.ok(walSize > 0, 'precondition: the probe rows are committed but still only in the WAL');
    const batchesBefore = writer.batches();

    const worker = startDbBackupWorker({ intervalMs: 60 * 60 * 1000 });
    try {
      await worker.firstRun;
    } finally {
      worker.stop();
    }
    assert.ok(writer.batches() > batchesBefore, 'precondition: the writer committed while the snapshot was taken');

    const restored = await restoreAndInspect(snapshotPath);
    assert.equal(restored.integrity, 'ok');
    assert.equal(restored.rows, PROBE_ROWS);
    const live = await get(writer.conn, 'SELECT count(*) AS users FROM users');
    assert.ok(live.users >= 1);
    assert.equal(restored.users, live.users);
    assert.equal(fs.existsSync(`${snapshotPath}.tmp`), false, 'no half-written temp file is left behind');
  });

  test('each run replaces the previous snapshot with the current state', async () => {
    await Db.createBackup(snapshotPath);
    await exec(writer.conn, `INSERT INTO backup_probe (id, payload) VALUES (-1, '${payload(1)}')`);
    await Db.createBackup(snapshotPath);

    const restored = await restoreAndInspect(snapshotPath);
    assert.equal(restored.integrity, 'ok');
    assert.equal(restored.rows, PROBE_ROWS + 1);
  });

  test('a stale temp file from an interrupted run does not block the next snapshot', async () => {
    fs.writeFileSync(`${snapshotPath}.tmp`, 'half-written');
    await Db.createBackup(snapshotPath);
    assert.equal((await restoreAndInspect(snapshotPath)).integrity, 'ok');
    assert.equal(fs.existsSync(`${snapshotPath}.tmp`), false);
  });
});

test('the production server writes webcalendar.db.backup into its data directory at boot', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmpDir, 'prod-'));
  const dbPath = path.join(dataDir, 'webcalendar.db');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      AUTH_METHOD: 'env',
      PORT: '0',
      SSL_KEY_PATH: '',
      SSL_CERT_PATH: '',
      DATABASE_PATH: dbPath,
      SESSION_SECRET: 'issue120-prod-session-secret-0123456789abcdef',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SYSTEM_SYNC_SECRET: 'issue120-system-sync-secret-0123456789abcdef',
      INTERNAL_WEBHOOK_SECRET: 'issue120-internal-webhook-secret-0123456789',
      HTTP_HEADER_AUTH_SECRET: 'issue120-proxy-secret-0123456789abcdef0123',
      BASE_URL: 'https://calendar.shard.example',
      CALDAV_USERNAME: 'testuser',
      CALDAV_EMAIL: 'testuser@example.com',
    },
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(`${dbPath}.backup`) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fs.existsSync(`${dbPath}.backup`), `no snapshot written by the server; output:\n${output}`);
    const conn = await open(`${dbPath}.backup`, sqlite3.OPEN_READONLY);
    try {
      assert.equal(Object.values(await get(conn, 'PRAGMA integrity_check'))[0], 'ok');
      assert.ok((await get(conn, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'")).n === 1);
    } finally {
      await close(conn);
    }
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
});
