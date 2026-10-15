'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #343 — fail fast: no swallowed errors.
 *
 *   1. A failing schema migration stops the server before it listens (exit 1), under NODE_ENV=production.
 *   2. The columns that used to be added by unversioned ALTERs come from the versioned migrations.
 *   3. The session store passes database errors on instead of reporting "no session".
 *   4. Routes answer a database failure with an error, not with a plausible empty result.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue343-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue343.db');
process.env.ENCRYPTION_KEY = 'issue343-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');

const Db = require('../db');
const { runMigrations, getSchemaVersion, migrations } = require('../utils/migrations');
const { SqliteSessionStore } = require('../utils/sessionStore');
const eventsRouter = require('../routes/events');
const tasksRouter = require('../routes/tasks');
const authRouter = require('../routes/auth');
const { publicRouter } = require('../routes/calendars');
const { fetchFileBrowserFiles } = require('../utils/filebrowser');
const { MSGraphSyncEngine } = require('../utils/msgraph');

const ROOT_DIR = path.join(__dirname, '../..');
const INDEX_MODULE = path.join(ROOT_DIR, 'server/index.js');
const KEY = 'issue343-install-key-0123456789abcdef0123456789';

function openDb(file) {
  const db = new sqlite3.Database(file);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  const close = () => new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  return { db, run, all, close };
}

function encryptWith(secret, plaintext) {
  const key = crypto.scryptSync(secret, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return { encrypted: cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex'), iv: iv.toString('hex') };
}

async function withApp(mount, fn, session = () => ({ userId: 'testuser', accounts: [] })) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session();
    next();
  });
  mount(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origError = console.error;
  console.error = () => {};
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    console.error = origError;
    await new Promise((resolve) => server.close(resolve));
  }
}

// A CalDAV server that answers with `handler(req)` and records every request method.
async function withDav(handler, fn) {
  const methods = [];
  const dav = http.createServer((req, res) => {
    methods.push(req.method);
    req.resume();
    req.on('end', () => {
      const out = handler(req);
      res.writeHead(out.status, { 'Content-Type': 'text/calendar' });
      res.end(out.body || '');
    });
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${dav.address().port}/`, methods);
  } finally {
    await new Promise((resolve) => dav.close(resolve));
  }
}

function basicAccount(id, url) {
  return { id, authType: 'basic', url, username: 'testuser', password: 'testuser-password' };
}

function json(method, url, body) {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const bootEnv = (dbPath, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'production',
  DATABASE_PATH: dbPath,
  ENCRYPTION_KEY: KEY,
  SESSION_SECRET: 'issue343-session-secret-0123456789abcdef0123',
  SYSTEM_SYNC_SECRET: 'issue343-system-sync-secret-0123456789abcdef',
  INTERNAL_WEBHOOK_SECRET: 'issue343-internal-webhook-secret-0123456789',
  HTTP_HEADER_AUTH_SECRET: 'issue343-proxy-secret-0123456789abcdef0123',
  BASE_URL: 'https://calendar.example.com',
  PORT: '0',
  SSL_KEY_PATH: '',
  SSL_CERT_PATH: '',
  DISABLE_INTERNAL_CALDAV: '1',
  ...extra,
});

function bootServer(env) {
  return spawnSync(process.execPath, [INDEX_MODULE], { env, encoding: 'utf8', timeout: 20000 });
}

async function withStub(target, name, impl, fn) {
  const original = target[name];
  target[name] = impl;
  try {
    await fn();
  } finally {
    target[name] = original;
  }
}

const dbFailure = async () => { throw new Error('SQLITE_IOERR: disk I/O error'); };

test.describe('Issue #343 — fail-fast startup and error propagation', () => {

  test('a failing schema migration aborts startup before the server listens', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'boot-'));
    const dbPath = path.join(dir, 'webcalendar.db');
    // A database at schema version 4 whose rows violate migration 005 (unique url/username per user).
    // Its credentials decrypt with KEY, so the encryption key check alone would let it start.
    const legacy = openDb(dbPath);
    await legacy.run(`CREATE TABLE linked_accounts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL, iv TEXT NOT NULL, display_name TEXT NOT NULL,
      auth_type TEXT DEFAULT 'basic', access_token TEXT, expires_at INTEGER)`);
    for (const id of ['acc-1', 'acc-2']) {
      const { encrypted, iv } = encryptWith(KEY, 'testuser-caldav-password');
      await legacy.run('INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, 'testuser', 'https://caldav.example.com/', 'testuser', encrypted, iv, 'Test User']);
    }
    await legacy.run('PRAGMA user_version = 4');
    await legacy.close();

    const result = bootServer(bootEnv(dbPath));

    assert.equal(result.signal, null, `server kept running after a failed migration: ${result.stdout}${result.stderr}`);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /\[startup\] Schema migration 005_linked_accounts_unique_url_username failed: .*UNIQUE/);
    assert.doesNotMatch(result.stdout, /WebCalendar running/, 'the server must not listen before the migrations succeeded');
  });

  test('the columns of the former ad-hoc ALTERs are added by versioned migrations', async () => {
    const legacy = openDb(path.join(tmpDir, 'legacy-schema.db'));
    try {
      // Tables as created before the columns existed, at the last version before #343.
      await legacy.run('CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL)');
      await legacy.run('CREATE TABLE calendar_shares (token TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL)');
      await legacy.run(`CREATE TABLE resources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'ROOM',
        capacity INTEGER NOT NULL DEFAULT 1, location TEXT, status TEXT NOT NULL DEFAULT 'AVAILABLE', created_at INTEGER NOT NULL)`);
      await legacy.run(`CREATE TABLE webcal_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6', refresh_interval INTEGER NOT NULL DEFAULT 3600, last_synced_at INTEGER, created_at INTEGER NOT NULL)`);
      await legacy.run(`INSERT INTO calendar_shares VALUES ('tok', 'acc::/testuser/cal/', 'Test', 0)`);
      await legacy.run('PRAGMA user_version = 5');

      await runMigrations(legacy.db, migrations);

      const columns = async (table) => (await legacy.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
      assert.ok((await columns('users')).includes('email'));
      assert.ok((await columns('resources')).includes('owner_id'));
      const webcal = await columns('webcal_subscriptions');
      for (const column of ['cached_events', 'cached_ics', 'last_error', 'last_error_at']) {
        assert.ok(webcal.includes(column), `webcal_subscriptions.${column} missing`);
      }
      const [share] = await legacy.all('SELECT detail FROM calendar_shares');
      assert.equal(share.detail, 'busy', 'existing public shares become free/busy (#341)');
      assert.equal(await getSchemaVersion(legacy.db), migrations[migrations.length - 1].version);
    } finally {
      await legacy.close();
    }
  });

  test('Db.ready resolves only after the migrations brought the schema to the latest version', async () => {
    await Db.ready;
    assert.equal(await Db.getSchemaVersion(), migrations[migrations.length - 1].version);
  });

  test('session store passes database errors on instead of reporting "no session"', async () => {
    const store = new SqliteSessionStore({
      db: {
        getRawSession: async () => ({ sid: 's1', sess: '{}', expired: Date.now() - 1000 }),
        deleteSession: dbFailure,
        saveSession: dbFailure,
      },
    });

    const viaCallback = await new Promise((resolve) => store.get('s1', (err, sess) => resolve({ err, sess })));
    assert.match(String(viaCallback.err && viaCallback.err.message), /SQLITE_IOERR/, 'get() must report the failed eviction');

    await assert.rejects(store.set('s1', { cookie: { maxAge: 1000 } }), /SQLITE_IOERR/,
      'set() without a callback must reject, not resolve');
  });

  test('invitations endpoint fails instead of listing nothing when the accounts cannot be loaded', async () => {
    await withStub(Db, 'getAccounts', dbFailure, () => withApp((app) => app.use('/api/events', eventsRouter), async (base) => {
      const res = await fetch(`${base}/api/events/invitations`);
      assert.equal(res.status, 500, `expected an error, got ${res.status} ${await res.text()}`);
    }));
  });

  test('session endpoint fails instead of reporting no e-mail when the user lookup fails', async () => {
    await withStub(Db, 'getUserEmailByUserId', dbFailure, () => withApp((app) => app.use('/api/auth', authRouter), async (base) => {
      const res = await fetch(`${base}/api/auth/session`);
      assert.equal(res.status, 500, `expected an error, got ${res.status} ${await res.text()}`);
    }));
  });

  test('public ICS export does not skip the rate limit when the fetch log cannot be read', async () => {
    await withStub(Db, 'getIcsFetchCount', dbFailure, () => withApp((app) => app.use('/api/public/calendars', publicRouter), async (base) => {
      const res = await fetch(`${base}/api/public/calendars/share/testtoken.ics`);
      assert.equal(res.status, 500, `expected an error, got ${res.status} ${await res.text()}`);
    }));
  });
  test('booting server/db.js makes no unversioned schema change', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'schema-'));
    const dbPath = path.join(dir, 'webcalendar.db');
    // Already at the latest version, but without a column a migration would add: only the
    // versioned runner may change the schema, and it has nothing left to run.
    const db = openDb(dbPath);
    await db.run(`CREATE TABLE resources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'ROOM',
      capacity INTEGER NOT NULL DEFAULT 1, location TEXT, status TEXT NOT NULL DEFAULT 'AVAILABLE', created_at INTEGER NOT NULL)`);
    await db.run(`PRAGMA user_version = ${migrations[migrations.length - 1].version}`);
    await db.close();

    const code = `
      const Db = require(${JSON.stringify(path.join(ROOT_DIR, 'server/db.js'))});
      Db.ready.then(() => Db.db.all('PRAGMA table_info(resources)', (err, rows) => {
        if (err) throw err;
        console.log('COLUMNS ' + rows.map((r) => r.name).join(','));
        Db.db.close(() => process.exit(0));
      }), (err) => { console.log('REJECTED ' + err.message); process.exit(3); });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { env: bootEnv(dbPath), encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const columns = /COLUMNS (.*)/.exec(result.stdout)[1].split(',');
    assert.ok(columns.includes('name'));
    assert.ok(!columns.includes('owner_id'), 'server/db.js added a column outside the versioned migrations');
  });

  test('every session store method passes database errors on', async () => {
    const store = new SqliteSessionStore({
      db: {
        getRawSession: dbFailure,
        deleteSession: dbFailure,
        touchSession: dbFailure,
        deleteSessionsForUser: dbFailure,
        getSessionsForUser: dbFailure,
      },
    });
    const calls = {
      get: (cb) => store.get('s1', cb),
      destroy: (cb) => store.destroy('s1', cb),
      touch: (cb) => store.touch('s1', { cookie: { maxAge: 1000 } }, cb),
      destroyUserSessions: (cb) => store.destroyUserSessions('testuser', cb),
      getUserSessions: (cb) => store.getUserSessions('testuser', cb),
    };
    for (const [name, call] of Object.entries(calls)) {
      const err = await new Promise((resolve) => call((e) => resolve(e)));
      assert.match(String(err && err.message), /SQLITE_IOERR/, `${name}() must pass the error to its callback`);
      await assert.rejects(call(), /SQLITE_IOERR/, `${name}() without a callback must reject`);
    }
  });

  test('a session row that is not JSON is an error for get(), not "no session"', async () => {
    const store = new SqliteSessionStore({ db: { getRawSession: async () => ({ sid: 's1', sess: '{broken', expired: Date.now() + 60000 }) } });
    await assert.rejects(store.get('s1'), SyntaxError);
  });

  test('public ICS export fails instead of answering "not found" when the share lookup or cache cleanup fails', async () => {
    const mount = (app) => app.use('/api/public/calendars', publicRouter);
    await withStub(Db, 'getIcsFetchCount', async () => 0, async () => {
      await withStub(Db, 'getCalendarShareByToken', dbFailure, () => withApp(mount, async (base) => {
        const res = await fetch(`${base}/api/public/calendars/share/testtoken.ics`);
        assert.equal(res.status, 500, 'a failed share lookup must not look like an unknown token');
      }));
      await withStub(Db, 'getCalendarShareByToken', async () => null, () =>
        withStub(Db, 'deleteIcsCache', dbFailure, () => withApp(mount, async (base) => {
          const res = await fetch(`${base}/api/public/calendars/share/testtoken.ics`);
          assert.equal(res.status, 500, 'a failed cache cleanup must be reported');
        })));
    });
  });

  test('saving an event or task never overwrites the stored one when it cannot be read first', async () => {
    await withDav((req) => (req.method === 'GET' ? { status: 500, body: 'Internal Server Error' } : { status: 201 }), async (davUrl, methods) => {
      const session = () => ({ userId: 'testuser', accounts: [basicAccount('acc', davUrl)] });
      await withApp((app) => {
        app.use('/api/events', eventsRouter);
        app.use('/api/tasks', tasksRouter);
      }, async (base) => {
        const ev = await json('PUT', `${base}/api/events/issue343`, {
          calendarId: 'acc::/testuser/cal/', href: '/testuser/cal/issue343.ics', title: 'Test User meeting',
          start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z', scope: 'series',
        });
        assert.ok(ev.status >= 500, `event save must fail, got ${ev.status}`);
        const task = await json('PUT', `${base}/api/tasks/issue343`, {
          calendarId: 'acc::/testuser/cal/', href: '/testuser/cal/issue343-task.ics', title: 'Test User task',
        });
        assert.ok(task.status >= 500, `task save must fail, got ${task.status}`);
      }, session);
      assert.deepEqual(methods.filter((m) => m === 'PUT'), [], 'nothing may be written over an unread resource');
      assert.ok(methods.includes('GET'), 'the failure must come from reading the stored resource');
    });
    // Positive control: a resource that does not exist yet (404) is created, not refused.
    await withDav((req) => (req.method === 'GET' ? { status: 404, body: 'Not Found' } : { status: 201 }), async (davUrl, methods) => {
      const session = () => ({ userId: 'testuser', accounts: [basicAccount('acc', davUrl)] });
      await withApp((app) => app.use('/api/events', eventsRouter), async (base) => {
        const ev = await json('PUT', `${base}/api/events/issue343-new`, {
          calendarId: 'acc::/testuser/cal/', href: '/testuser/cal/issue343-new.ics', title: 'Test User meeting',
          start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z', scope: 'series',
        });
        assert.ok(ev.status < 300, `a new event must be saved, got ${ev.status} ${await ev.text()}`);
      }, session);
      assert.ok(methods.includes('PUT'), 'a new event must be written');
    });
  });

  test('a sharee delete is refused, not carried out unprotected, when the cross-user deletion cannot be recorded', async () => {
    const calendarId = 'internal-caldav::/testowner/cal/';
    await withDav(() => ({ status: 204 }), async (davUrl, methods) => {
      const session = () => ({ userId: 'testuser', accounts: [basicAccount('internal-caldav', davUrl)] });
      await withStub(Db, 'getSharedCalendarsForUser', async () => [{ calendar_id: calendarId, role: 'WRITE', status: 'ACCEPTED', read_write: 1 }], () =>
        withStub(Db, 'hasExternalAccounts', async () => true, () =>
          withStub(Db, 'recordCrossUserDeletion', dbFailure, () =>
            withApp((app) => app.use('/api/events', eventsRouter), async (base) => {
              const res = await json('DELETE', `${base}/api/events/issue343`, { calendarId, href: '/testowner/cal/issue343.ics' });
              assert.equal(res.status, 500, `expected an error, got ${res.status} ${await res.text()}`);
            }, session))));
      assert.deepEqual(methods, ['GET'], 'the owner\'s event must not be deleted without its protection record');
    });
  });

  test('a sharee delete that fails on the server withdraws its cross-user deletion record', async () => {
    await Db.ready;
    const calendarId = 'internal-caldav::/testowner-del/cal/';
    // The event is read (and recorded), then the DELETE itself fails.
    const dav = (req) => (req.method === 'GET'
      ? { status: 200, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }
      : { status: 500, body: 'Internal Server Error' });
    await withDav(dav, async (davUrl, methods) => {
      const session = () => ({ userId: 'testuser', accounts: [basicAccount('internal-caldav', davUrl)] });
      await withStub(Db, 'getSharedCalendarsForUser', async () => [{ calendar_id: calendarId, role: 'WRITE', status: 'ACCEPTED', read_write: 1 }], () =>
        withStub(Db, 'hasExternalAccounts', async () => true, () =>
          withApp((app) => app.use('/api/events', eventsRouter), async (base) => {
            const res = await json('DELETE', `${base}/api/events/issue343-del`, { calendarId, href: '/testowner-del/cal/issue343-del.ics' });
            assert.ok(res.status >= 500, `expected an error, got ${res.status}`);
          }, session)));
      assert.ok(methods.includes('DELETE'), 'the delete must have been attempted after recording');
    });
    assert.deepEqual(await Db.getCrossUserDeletions('testowner-del'), [],
      'an event that was not deleted must not be restored over by the sync worker');
  });

  test('a failing or unreachable FileBrowser is an error, not a made-up file listing', async () => {
    const failing = http.createServer((req, res) => { res.writeHead(500); res.end('down'); });
    await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const port = failing.address().port;
    const previous = process.env.FILEBROWSER_URL;
    try {
      process.env.FILEBROWSER_URL = `http://127.0.0.1:${port}`;
      await assert.rejects(fetchFileBrowserFiles('/', 'testuser-token'), /FileBrowser listing of \/ failed \(500\)/);
      await new Promise((resolve) => failing.close(resolve));
      await assert.rejects(fetchFileBrowserFiles('/', 'testuser-token'), /fetch failed/);
    } finally {
      if (previous === undefined) delete process.env.FILEBROWSER_URL;
      else process.env.FILEBROWSER_URL = previous;
      failing.close();
    }
  });

  test('an MS Graph push answered without a readable event id stores no invented mapping', async () => {
    await Db.ready;
    const account = { id: 'issue343-graph', accessToken: 'testuser-token', expiresAt: Date.now() + 3600000 };
    const event = { uid: 'issue343-graph-event', title: 'Test User sync', start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z' };
    const notJson = new MSGraphSyncEngine(account, async () => new Response('<html>proxy error</html>', { status: 200 }));
    await assert.rejects(notJson.pushLocalEvent(event), SyntaxError);
    const noId = new MSGraphSyncEngine(account, async () => new Response('{}', { status: 201 }));
    await assert.rejects(noId.pushLocalEvent(event), /without an event id/);
    assert.equal(await Db.getMSGraphEventMapping(event.uid), null, 'no fake Graph id may be stored');
  });

  test('deleting a user fails when a plaintext credential file cannot be removed', async () => {
    await Db.ready;
    const userId = `issue343-${crypto.randomUUID()}`;
    const stuck = path.join('/tmp', `vdir_${userId}.ini`);
    fs.mkdirSync(stuck);
    try {
      await assert.rejects(Db.deleteUser(userId), (err) => ['EISDIR', 'EPERM'].includes(err.code));
    } finally {
      fs.rmSync(stuck, { recursive: true, force: true });
    }
  });

  test('an unreadable TLS certificate aborts startup instead of serving plain HTTP', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'tls-'));
    // Present but unreadable as a file.
    fs.mkdirSync(path.join(dir, 'key.pem'));
    fs.mkdirSync(path.join(dir, 'cert.pem'));
    const result = bootServer(bootEnv(path.join(dir, 'webcalendar.db'), {
      SSL_KEY_PATH: path.join(dir, 'key.pem'),
      SSL_CERT_PATH: path.join(dir, 'cert.pem'),
    }));
    assert.equal(result.signal, null, `server kept running without its certificate: ${result.stdout}${result.stderr}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EISDIR/);
    assert.doesNotMatch(result.stdout, /WebCalendar running/);
  });

  test('an unusable share key file aborts startup instead of using a throwaway key', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'sharekey-'));
    fs.mkdirSync(path.join(dir, '.share_key'));
    const result = bootServer(bootEnv(path.join(dir, 'webcalendar.db')));
    assert.equal(result.signal, null, `server kept running with a throwaway share key: ${result.stdout}${result.stderr}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EISDIR/);
  });
});
