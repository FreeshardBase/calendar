'use strict';

// Issue #211: the Playwright suite must exercise the shipping configuration. This boots
// server/index.js with the env of playwright.config.js's webServer — plus E2E_TEST=true, the key
// the earlier bypass hid behind — and asserts that the test-mode identity switches are off.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const repoRoot = path.join(__dirname, '../..');
const { webServer } = require(path.join(repoRoot, 'playwright.config.js'));
const suiteEnv = webServer.env || {};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Only PATH/HOME are inherited, so the developer's shell cannot change what is measured.
function bootServer(t, overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue211-'));
  const dbFile = path.join(tmpDir, 'webcalendar.db');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...suiteEnv,
    DATABASE_PATH: dbFile,
    E2E_TEST: 'true',
    ...overrides,
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  // Resolves with the exit code, or 'still running' if the server stays up (boot was not aborted).
  const exited = Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    new Promise(resolve => setTimeout(() => resolve('still running'), 15000).unref()),
  ]);
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return { child, dbFile, exited, stderr: () => stderr };
}

async function waitForHealth(baseUrl, srv) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (srv.child.exitCode !== null) throw new Error(`server exited with ${srv.child.exitCode}: ${srv.stderr()}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.status < 500) return;
    } catch (err) {
      if (!['ECONNREFUSED', 'ECONNRESET'].includes(err.cause?.code)) throw err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy: ${srv.stderr()}`);
}

function queryAll(dbFile, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY);
    db.all(sql, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
  });
}

test('Issue #211 — the Playwright webServer runs the shipping auth configuration', async (t) => {
  assert.strictEqual(suiteEnv.NODE_ENV, 'production');
  assert.ok(suiteEnv.DATABASE_PATH, 'the suite must not write its fixtures into the default webcalendar.db');
  assert.notStrictEqual(path.resolve(repoRoot, suiteEnv.DATABASE_PATH), path.join(repoRoot, 'webcalendar.db'));
  // No process-wide TLS opt-out (CLAUDE.md §3.4) and no auth-mode override the shipping compose lacks.
  for (const key of ['NODE_TLS_REJECT_UNAUTHORIZED', 'AUTH_METHOD', 'HTTP_HEADER_AUTH', 'E2E_TEST']) {
    assert.ok(!(key in suiteEnv), `webServer.env must not set ${key}`);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const srv = bootServer(t, { PORT: String(port) });
  await waitForHealth(baseUrl, srv);

  // A spoofed test identity header must not log the caller in as someone else — neither via the
  // session middleware nor via the per-router fallbacks of routers mounted without requireAuth.
  // The browser plays the platform proxy (#246): every request carries its secret.
  assert.ok(suiteEnv.HTTP_HEADER_AUTH_SECRET, 'production env mode needs the proxy secret');
  const proxied = { 'X-Freeshard-Secret': suiteEnv.HTTP_HEADER_AUTH_SECRET };
  const spoof = { ...proxied, 'X-Test-User-Id': 'victim-user' };
  for (const p of ['/api/accounts', '/api/webcal/subscriptions', '/api/notifications/push-subscriptions', '/api/availability-slots']) {
    const res = await fetch(`${baseUrl}${p}`, { headers: spoof });
    assert.strictEqual(res.status, 401, `${p}: X-Test-User-Id was honoured: ${await res.text()}`);
  }

  const session = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { ...spoof, 'X-Test-Email': 'victim@example.com' },
  });
  const sessionBody = await session.json();
  assert.notStrictEqual(sessionBody.userId, 'victim-user');
  assert.notStrictEqual(sessionBody.email, 'victim@example.com');

  // Env auth signs the browser in on the entry paths only; a bare API call stays unauthenticated.
  const bare = await fetch(`${baseUrl}/api/tasks`, { headers: proxied });
  assert.strictEqual(bare.status, 401);

  // The browser flow: loading the gzipped SPA entry `/` establishes the session the SPA's API calls use.
  const index = await fetch(`${baseUrl}/`, { headers: { ...proxied, 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(index.status, 200);
  assert.strictEqual(index.headers.get('content-encoding'), 'gzip');
  const cookie = index.headers.get('set-cookie');
  assert.ok(cookie, 'loading / must establish a session');
  const withCookie = await fetch(`${baseUrl}/api/accounts`, { headers: { ...proxied, cookie: cookie.split(';')[0] } });
  assert.strictEqual(withCookie.status, 200);

  // No fake users are seeded into the database, and spoofed ids are not persisted.
  const users = (await queryAll(srv.dbFile, 'SELECT user_id FROM users')).map(r => r.user_id);
  assert.ok(!users.includes('testuser-id'), `fake user seeded: ${users.join(', ')}`);
  assert.ok(!users.includes('victim-user'), `spoofed user persisted: ${users.join(', ')}`);
});

test('Issue #211 — E2E_TEST=true does not switch off the production secret validators', async (t) => {
  const weakEncryption = bootServer(t, { PORT: String(await freePort()), ENCRYPTION_KEY: 'change-me' });
  const encryptionExit = await weakEncryption.exited;
  assert.ok(typeof encryptionExit === 'number' && encryptionExit !== 0, `a weak ENCRYPTION_KEY must abort boot (${encryptionExit})`);
  assert.match(weakEncryption.stderr(), /ENCRYPTION_KEY must be explicitly configured/);

  const weakSyncSecret = bootServer(t, {
    PORT: String(await freePort()),
    SYSTEM_SYNC_SECRET: 'change-me',
    ALLOW_INSECURE_SYSTEM_SYNC_SECRET: '',
  });
  const syncExit = await weakSyncSecret.exited;
  assert.ok(typeof syncExit === 'number' && syncExit !== 0, `a weak SYSTEM_SYNC_SECRET must abort boot (${syncExit})`);
  assert.match(weakSyncSecret.stderr(), /SYSTEM_SYNC_SECRET must be explicitly configured/);
});
