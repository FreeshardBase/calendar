'use strict';

/**
 * Issue #526 — the session store must not hold credentials. linked_accounts are encrypted at rest;
 * the session row (sessions.sess, plain JSON, copied into backups) must carry neither a decrypted
 * account password nor SYSTEM_SYNC_SECRET of the internal Radicale account. The accounts are still
 * available to every request, rebuilt from the database.
 *
 * Runs the real server app under NODE_ENV=production with the real SQLite session store.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const sqlite3 = require('sqlite3');
const { createTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue526-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const HEADER_SECRET = 'issue526-header-auth-secret-0123456789abcdef';
const SYNC_SECRET = 'issue526-system-sync-secret-0123456789abcdef';
const ACCOUNT_PASSWORD = 'issue526-linked-account-password-0123456789';
const REFRESH_TOKEN = 'issue526-oauth-refresh-token-0123456789';
const ACCESS_TOKEN = 'issue526-oauth-access-token-0123456789';
const SECRETS = { SYSTEM_SYNC_SECRET: SYNC_SECRET, password: ACCOUNT_PASSWORD, refreshToken: REFRESH_TOKEN, accessToken: ACCESS_TOKEN };
const USER = 'testuser';
const DB_PATH = path.join(tmpDir, 'issue526.db');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readSessionRows(dbPath = DB_PATH) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    db.all('SELECT sess FROM sessions', [], (err, rows) => {
      db.close();
      if (err) return reject(err);
      resolve(rows.map((r) => r.sess));
    });
  });
}

test('Issue #526 — sessions.sess holds no account password and no SYSTEM_SYNC_SECRET (NODE_ENV=production)', async (t) => {
  const origEnv = { ...process.env };
  let server = null;
  t.after(() => {
    if (server) server.close();
    process.env = origEnv;
  });
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'env';
  process.env.HTTP_HEADER_AUTH = 'true';
  process.env.HTTP_HEADER_AUTH_SECRET = HEADER_SECRET;
  process.env.DATABASE_PATH = DB_PATH;
  process.env.SESSION_SECRET = 'issue526-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SYSTEM_SYNC_SECRET = SYNC_SECRET;
  // A stand-in for Radicale that records the credentials it receives.
  const radicaleAuth = [];
  const radicale = https.createServer(createTestCertificate(), (req, res) => {
    radicaleAuth.push(req.headers.authorization || '');
    res.writeHead(500);
    res.end();
  });
  t.after(() => radicale.close());
  process.env.INTERNAL_CALDAV_URL = `https://127.0.0.1:${await listen(radicale)}`;
  delete process.env.DISABLE_INTERNAL_CALDAV;
  delete process.env.CALDAVURL;
  delete process.env.CALDAV_USERNAME;
  delete process.env.CALDAV_PASSWORD;

  // A session row that still carries credentials (as written before #526) and has not expired:
  // it must be gone before the server serves a request or writes a backup.
  const legacySess = JSON.stringify({
    cookie: { expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
    userId: USER,
    accounts: [
      { id: 'internal-caldav', username: USER, password: SYNC_SECRET },
      { id: 'legacy-oauth', username: 'testuser@example.com', password: ACCOUNT_PASSWORD, refreshToken: REFRESH_TOKEN, accessToken: ACCESS_TOKEN }
    ]
  });
  await new Promise((resolve, reject) => {
    const seed = new sqlite3.Database(DB_PATH);
    seed.serialize(() => {
      seed.run('CREATE TABLE sessions (sid TEXT PRIMARY KEY, user_id TEXT, sess TEXT NOT NULL, expired INTEGER NOT NULL)');
      seed.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', ['legacy-sid', USER, legacySess, Date.now() + 24 * 60 * 60 * 1000]);
      // Other rows: a current session without credentials stays (no logout on restart); an
      // expired one and a corrupt one go.
      seed.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', ['clean-sid', USER, JSON.stringify({ cookie: {}, userId: USER }), Date.now() + 24 * 60 * 60 * 1000]);
      seed.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', ['expired-sid', USER, JSON.stringify({ cookie: {}, userId: USER }), Date.now() - 1000]);
      seed.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', ['corrupt-sid', USER, '{"userId":', Date.now() + 24 * 60 * 60 * 1000]);
    });
    seed.close((err) => (err ? reject(err) : resolve()));
  });

  const { app } = require('../index.js');
  const Db = require('../db');
  await Db.ready;
  assert.deepEqual(await readSessionRows(), [JSON.stringify({ cookie: {}, userId: USER })],
    'only the current session without credentials survives the boot');
  // Nor do its bytes survive in free pages or the WAL, which the shard backup copies file by file.
  for (const file of [DB_PATH, `${DB_PATH}-wal`]) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.ok(!raw.includes(secret), `${name} must not remain in ${path.basename(file)}`);
    }
  }
  const backupPath = path.join(tmpDir, 'issue526.db.backup');
  await Db.createBackup(backupPath);
  const backupRaw = fs.readFileSync(backupPath);
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!backupRaw.includes(secret), `${name} must not be copied into the backup`);
  }
  server = http.createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;

  const proxy = { 'x-freeshard-secret': HEADER_SECRET, 'x-ptl-client-type': 'terminal' };
  const login = await fetch(`${origin}/api/auth/session`, { headers: { ...proxy, 'x-forwarded-user': USER } });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  assert.ok(cookie, 'a session cookie is issued');

  const linked = await Db.addAccount(USER, {
    url: 'https://caldav.invalid/dav/',
    username: 'testuser@example.com',
    password: ACCOUNT_PASSWORD,
    displayName: 'Test User'
  });
  const oauth = await Db.addOAuthAccount(USER, {
    url: 'https://oauth-caldav.invalid/dav/',
    username: 'testuser@example.com',
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    expiresAt: Date.now() + 60 * 60 * 1000,
    displayName: 'Test User OAuth'
  });

  const assertNoSecrets = async () => {
    const rows = await readSessionRows();
    assert.ok(rows.some((sess) => JSON.parse(sess).userId === USER), 'the logged-in session is stored');
    for (const sess of rows) {
      for (const [name, secret] of Object.entries(SECRETS)) {
        assert.ok(!sess.includes(secret), `${name} must not be stored in the session`);
      }
    }
  };

  const calendars = await fetch(`${origin}/api/calendars`, { headers: { ...proxy, cookie, 'x-forwarded-user': USER } });
  await calendars.arrayBuffer();
  await assertNoSecrets();

  // The internal account still authenticates with SYSTEM_SYNC_SECRET, built at request time.
  const expected = 'Basic ' + Buffer.from(`${USER}:${SYNC_SECRET}`).toString('base64');
  assert.ok(radicaleAuth.includes(expected), 'Radicale receives the master credentials for the user');

  // The accounts are still there for each request, loaded from the database.
  const accounts = await fetch(`${origin}/api/accounts`, { headers: { ...proxy, cookie, 'x-forwarded-user': USER } });
  assert.equal(accounts.status, 200);
  const ids = (await accounts.json()).map((a) => a.id);
  assert.ok(ids.includes(linked.id), 'the linked account is listed');
  assert.ok(ids.includes(oauth.id), 'the OAuth account is listed');
  assert.ok(ids.includes('internal-caldav'), 'the internal account is listed');
  await assertNoSecrets();
});
