'use strict';

/**
 * Issue #340 — BASE_URL is mandatory in production and X-Forwarded-Host is never trusted;
 * the header-auth secret is its own variable, separate from INTERNAL_WEBHOOK_SECRET.
 *
 * The startup checks are exercised by booting the real server process (`node server/index.js`)
 * with NODE_ENV=production and otherwise valid configuration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue340-startup-'));
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
    SESSION_SECRET: 'issue340-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue340-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue340-internal-webhook-secret-0123456789',
    // #246: production env mode (the default) needs the platform proxy secret.
    HTTP_HEADER_AUTH_SECRET: 'issue340-proxy-secret-0123456789abcdef0123',
    BASE_URL: 'https://calendar.shard.example',
    ...overrides
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

// Resolves with how the process ended: it exited, or it came up and was stopped.
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

test('Issue #340 — production startup configuration', async (t) => {
  await t.test('control: a complete production configuration starts', async () => {
    const r = await boot(prodEnv({}));
    assert.equal(r.started, true, `server must start, stderr: ${r.stderr}`);
  });

  await t.test('production refuses to start without BASE_URL', async () => {
    const r = await boot(prodEnv({ BASE_URL: undefined }));
    assert.equal(r.started, false);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /BASE_URL/);
  });

  await t.test('production refuses to start with a BASE_URL that is not an http(s) URL', async () => {
    for (const bad of [
      'calendar.shard.example', 'javascript:alert(1)', 'ftp://calendar.shard.example',
      'https://calendar.shard.example/?x=1', 'https://calendar.shard.example/#top', 'https://testuser:pw@calendar.shard.example'
    ]) {
      const r = await boot(prodEnv({ BASE_URL: bad }));
      assert.equal(r.started, false, `BASE_URL=${bad} must be refused`);
      assert.match(r.stderr, /BASE_URL/);
    }
  });

  await t.test('production refuses header auth without its own HTTP_HEADER_AUTH_SECRET', async () => {
    const r = await boot(prodEnv({ HTTP_HEADER_AUTH: 'true', HTTP_HEADER_AUTH_SECRET: undefined }));
    assert.equal(r.started, false);
    assert.match(r.stderr, /HTTP_HEADER_AUTH=true requires HTTP_HEADER_AUTH_SECRET/);
  });

  await t.test('production refuses a header-auth secret that doubles as INTERNAL_WEBHOOK_SECRET', async () => {
    const r = await boot(prodEnv({
      HTTP_HEADER_AUTH: 'true',
      HTTP_HEADER_AUTH_SECRET: 'issue340-internal-webhook-secret-0123456789'
    }));
    assert.equal(r.started, false);
    assert.match(r.stderr, /HTTP_HEADER_AUTH_SECRET/);
  });

  await t.test('control: header auth with its own secret starts', async () => {
    const r = await boot(prodEnv({ HTTP_HEADER_AUTH: 'true', HTTP_HEADER_AUTH_SECRET: 'issue340-header-auth-secret-0123456789ab' }));
    assert.equal(r.started, true, `server must start, stderr: ${r.stderr}`);
  });
});

test('Issue #340 — getBaseUrl never trusts X-Forwarded-Host', async (t) => {
  const { getBaseUrl, getPublicShareUrl } = require('../utils/baseUrl');
  const origEnv = { ...process.env };
  t.afterEach(() => { process.env = { ...origEnv }; });

  const forgedReq = {
    protocol: 'http',
    get: (h) => ({ host: 'localhost:3000', 'x-forwarded-host': 'attacker.example' })[h.toLowerCase()] || null
  };

  await t.test('production without BASE_URL fails instead of deriving the URL from the request', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BASE_URL;
    assert.throws(() => getPublicShareUrl(forgedReq, 'tok'), /BASE_URL/);
  });

  await t.test('production with BASE_URL ignores the forged host', () => {
    process.env.NODE_ENV = 'production';
    process.env.BASE_URL = 'https://calendar.shard.example/';
    assert.equal(getPublicShareUrl(forgedReq, 'tok'), 'https://calendar.shard.example/api/public/calendars/share/tok.ics');
  });

  await t.test('development without BASE_URL uses the Host header, never X-Forwarded-Host', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BASE_URL;
    assert.equal(getBaseUrl(forgedReq), 'http://localhost:3000');
  });
});
