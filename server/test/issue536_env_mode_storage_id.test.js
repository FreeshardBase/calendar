'use strict';

/**
 * Issue #536 — in AUTH_METHOD=env, CALDAV_USERNAME is the storage identity: it names the Radicale
 * collection root and the sync worker's status directory. An unsafe value stops the start-up.
 *
 * The real server process (`node server/index.js`) is booted with NODE_ENV=production and otherwise
 * valid configuration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue536-env-id-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');

function prodEnv(overrides) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    PORT: '0',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, `startup-${Math.random().toString(36).slice(2)}.db`),
    SESSION_SECRET: 'issue536-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue536-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue536-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: 'issue536-proxy-secret-0123456789abcdef0123',
    BASE_URL: 'https://calendar.shard.example',
    AUTH_METHOD: 'env',
    ...overrides
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.includes('running on')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ started: stdout.includes('running on'), code, stderr });
    });
  });
}

test('Issue #536 — env mode refuses an unsafe CALDAV_USERNAME at start-up', async (t) => {
  await t.test('control: a safe CALDAV_USERNAME starts', async () => {
    const r = await boot(prodEnv({ CALDAV_USERNAME: 'testuser@example.com' }));
    assert.equal(r.started, true, `server must start, stderr: ${r.stderr}`);
  });

  await t.test('unsafe values exit with code 1 before the server binds', async () => {
    for (const bad of ['../testuser', 'testuser/other', '.', '..', '.testuser', 'test user', 'testuser%2F..', 'testuser?x', 'testuser#x', 'testuser:x', 'testuser\\x']) {
      const r = await boot(prodEnv({ CALDAV_USERNAME: bad }));
      assert.equal(r.started, false, `CALDAV_USERNAME=${bad} must be refused`);
      assert.equal(r.code, 1, `CALDAV_USERNAME=${bad} must exit with 1`);
      assert.match(r.stderr, /CALDAV_USERNAME/);
    }
  });

  await t.test('env is the default mode: unset AUTH_METHOD is checked too, padded values are refused', async () => {
    for (const bad of ['../testuser', ' testuser', 'testuser ']) {
      const r = await boot(prodEnv({ AUTH_METHOD: undefined, CALDAV_USERNAME: bad }));
      assert.equal(r.started, false, `CALDAV_USERNAME=${JSON.stringify(bad)} must be refused`);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /CALDAV_USERNAME/);
    }
  });
});
