'use strict';

/**
 * Issue #143 — the platform proxy's access decision is also checked in the app. On a private path
 * shard_core renders `X-Ptl-Client-Type: {{ auth.client_type }}` ("terminal", "peer", "anonymous");
 * in production env mode every request outside /api/public/ must carry `terminal`, on top of the
 * proxy secret (#246). `X-Ptl-Client-Id` identifies a device and is never a user identity
 * (CONCEPTS.md, Identity).
 *
 * Exercised by booting the real server process (`node server/index.js`) in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue143-client-type-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');
const PROXY_SECRET = 'issue143-proxy-secret-0123456789abcdef0123';

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

function prodEnv(overrides) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, `run-${Math.random().toString(36).slice(2)}.db`),
    SESSION_SECRET: 'issue143-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue143-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue143-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: PROXY_SECRET,
    BASE_URL: 'https://calendar.shard.example',
    CALDAV_USERNAME: 'testuser',
    CALDAV_EMAIL: 'testuser@example.com',
    ...overrides
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (!settled && stdout.includes('running on')) {
        settled = true;
        resolve({ child, started: true, stderr });
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ child, started: false, code, stderr });
      }
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

async function boot(t, overrides) {
  const port = await freePort();
  const r = await start(prodEnv({ PORT: String(port), ...overrides }));
  assert.equal(r.started, true, `server must start, stderr: ${r.stderr}`);
  t.after(() => stop(r.child));
  return `http://127.0.0.1:${port}`;
}

const PROXY = { 'X-Freeshard-Secret': PROXY_SECRET };
const TERMINAL = { ...PROXY, 'X-Ptl-Client-Type': 'terminal' };
const cookieOf = (res) => (res.headers.getSetCookie()[0] || '').split(';')[0];

for (const NODE_ENV of ['production', 'staging']) test(`Issue #143 — ${NODE_ENV}: only a paired terminal reaches private routes`, async (t) => {
  const base = await boot(t, { NODE_ENV });
  const privatePaths = ['/', '/index.html', '/js/app.js', '/api/auth/session', '/api/calendars', '/api/accounts',
    '/api/working-hours', '/api/msgraph/accounts'];

  await t.test('proxy secret but no X-Ptl-Client-Type is 401 and mints no session', async () => {
    for (const p of privatePaths) {
      const res = await fetch(`${base}${p}`, { headers: PROXY, redirect: 'manual' });
      assert.equal(res.status, 401, `GET ${p} without a client type must be 401`);
      assert.equal(res.headers.getSetCookie().length, 0, `GET ${p} without a client type must not mint a session`);
    }
  });

  await t.test('any client type other than "terminal" is 401', async () => {
    for (const type of ['peer', 'anonymous', 'attacker', 'Terminal', 'terminal,peer', '']) {
      for (const p of ['/', '/api/auth/session', '/api/accounts']) {
        const res = await fetch(`${base}${p}`, { headers: { ...PROXY, 'X-Ptl-Client-Type': type }, redirect: 'manual' });
        assert.equal(res.status, 401, `GET ${p} with client type ${JSON.stringify(type)} must be 401`);
        assert.equal(res.headers.getSetCookie().length, 0);
      }
    }
  });

  await t.test('a terminal yields the env user', async () => {
    const res = await fetch(`${base}/api/auth/session`, { headers: TERMINAL });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, 'testuser');
    const cookie = cookieOf(res);
    assert.ok(cookie, 'the terminal handshake sets a session cookie');
    const api = await fetch(`${base}/api/working-hours`, { headers: { ...TERMINAL, cookie } });
    assert.equal(api.status, 200);
  });

  await t.test("a terminal's session cookie replayed by a peer or without a client type is 401", async () => {
    const cookie = cookieOf(await fetch(`${base}/api/auth/session`, { headers: TERMINAL }));
    for (const extra of [{ 'X-Ptl-Client-Type': 'peer' }, {}]) {
      for (const p of ['/api/auth/session', '/api/accounts', '/api/working-hours']) {
        const res = await fetch(`${base}${p}`, { headers: { ...PROXY, ...extra, cookie } });
        assert.equal(res.status, 401, `GET ${p} with ${JSON.stringify(extra)} must be 401`);
      }
    }
    const post = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { ...PROXY, 'X-Ptl-Client-Type': 'peer', cookie, Origin: 'https://calendar.shard.example', 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(post.status, 401);
  });

  await t.test('the public path stays reachable for anonymous and peer clients', async () => {
    for (const type of ['anonymous', 'peer']) {
      const res = await fetch(`${base}/api/public/calendars/share/unknown.ics`, { headers: { ...PROXY, 'X-Ptl-Client-Type': type } });
      assert.notEqual(res.status, 401, `public path refused a ${type} client`);
    }
  });

  await t.test('the container healthcheck needs no client type', async () => {
    for (const p of ['/health', '/api/health']) {
      assert.equal((await fetch(`${base}${p}`)).status, 200, p);
    }
  });
});

test('Issue #143 — X-Ptl-Client-Id (a device id) is not a user identity', async (t) => {
  const base = await boot(t, { HTTP_HEADER_AUTH: 'true' });
  const res = await fetch(`${base}/api/auth/session`, { headers: { ...TERMINAL, 'X-Ptl-Client-Id': 'testdevice-123' } });
  assert.equal(res.status, 401, 'a device id must not sign anybody in');
  // Control: the proxy's user header still does.
  const user = await fetch(`${base}/api/auth/session`, { headers: { ...TERMINAL, 'X-Forwarded-User': 'testuser' } });
  assert.equal(user.status, 200);
  assert.equal((await user.json()).userId, 'testuser');
});
