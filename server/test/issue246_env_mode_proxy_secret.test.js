'use strict';

/**
 * Issue #246 (maintainer decision 2026-10-15) — under NODE_ENV=production, AUTH_METHOD=env accepts
 * only requests that carry the FreeShard platform proxy's shared secret (X-Freeshard-Secret ==
 * HTTP_HEADER_AUTH_SECRET, compared timing-safe). Without it every request is 401, the env identity
 * is never minted, and an existing session cookie alone is not enough. Production refuses to start
 * in env mode without that secret.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue246-proxy-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');
const PROXY_SECRET = 'issue246-proxy-secret-0123456789abcdef0123';

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
    PORT: '0',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, `run-${Math.random().toString(36).slice(2)}.db`),
    SESSION_SECRET: 'issue246-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue246-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue246-internal-webhook-secret-0123456789',
    BASE_URL: 'https://calendar.shard.example',
    CALDAV_USERNAME: 'testuser',
    CALDAV_EMAIL: 'testuser@example.com',
    ...overrides
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

// Starts the server; resolves { child, started, code, stderr } once it listens or exits.
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

test('Issue #246 — production env mode refuses to start without the proxy secret', async (t) => {
  for (const NODE_ENV of ['production', 'staging']) {
    await t.test(`${NODE_ENV}: AUTH_METHOD=env without HTTP_HEADER_AUTH_SECRET exits 1`, async () => {
      const r = await start(prodEnv({ NODE_ENV }));
      if (r.started) await stop(r.child);
      assert.equal(r.started, false, 'production env mode must not start without the proxy secret');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /AUTH_METHOD=env requires HTTP_HEADER_AUTH_SECRET/);
    });
  }

  await t.test('AUTH_METHOD unset (defaults to env) without HTTP_HEADER_AUTH_SECRET exits 1', async () => {
    const r = await start(prodEnv({ AUTH_METHOD: undefined }));
    if (r.started) await stop(r.child);
    assert.equal(r.started, false, 'the default auth method must not start without the proxy secret');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /AUTH_METHOD=env requires HTTP_HEADER_AUTH_SECRET/);
  });

  await t.test('a short proxy secret is refused', async () => {
    const r = await start(prodEnv({ HTTP_HEADER_AUTH_SECRET: 'too-short-secret' }));
    if (r.started) await stop(r.child);
    assert.equal(r.started, false);
    assert.match(r.stderr, /HTTP_HEADER_AUTH_SECRET must be at least 32 characters/);
  });

  await t.test('an unknown AUTH_METHOD is refused instead of silently disabling the gate', async () => {
    const r = await start(prodEnv({ AUTH_METHOD: 'ENV', HTTP_HEADER_AUTH_SECRET: PROXY_SECRET }));
    if (r.started) await stop(r.child);
    assert.equal(r.started, false);
    assert.match(r.stderr, /AUTH_METHOD must be/);
  });

  for (const other of ['INTERNAL_WEBHOOK_SECRET', 'SYSTEM_SYNC_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY']) {
    await t.test(`the proxy secret must not double as ${other}`, async () => {
      const r = await start(prodEnv({ HTTP_HEADER_AUTH_SECRET: prodEnv({})[other] }));
      if (r.started) await stop(r.child);
      assert.equal(r.started, false);
      assert.match(r.stderr, new RegExp(`HTTP_HEADER_AUTH_SECRET must differ from ${other}`));
    });
  }
});

for (const NODE_ENV of ['production', 'staging']) test(`Issue #246 — ${NODE_ENV} env mode accepts only proxied requests`, async (t) => {
  const port = await freePort();
  const r = await start(prodEnv({ NODE_ENV, PORT: String(port), HTTP_HEADER_AUTH_SECRET: PROXY_SECRET }));
  assert.equal(r.started, true, `server must start with the proxy secret, stderr: ${r.stderr}`);
  t.after(() => stop(r.child));

  const base = `http://127.0.0.1:${port}`;
  // #143: the proxy also renders the client type of a paired terminal.
  const proxied = { 'X-Freeshard-Secret': PROXY_SECRET, 'X-Ptl-Client-Type': 'terminal' };
  const cookieOf = (res) => (res.headers.getSetCookie()[0] || '').split(';')[0];

  await t.test('anonymous requests are 401 on the session handshake, the page and the API', async () => {
    for (const p of ['/api/auth/session', '/', '/index.html', '/js/app.js', '/api/calendars', '/api/accounts',
      '/api/working-hours', '/api/public/calendars/share/unknown.ics', '/mock-dav/', '/health/', '/internal']) {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      assert.equal(res.status, 401, `anonymous GET ${p} must be 401`);
      assert.equal(res.headers.getSetCookie().length, 0, `anonymous GET ${p} must not mint a session`);
    }
  });

  await t.test('a wrong or truncated secret is 401', async () => {
    for (const bad of ['wrong', PROXY_SECRET.slice(0, -1), `${PROXY_SECRET}x`, '']) {
      for (const header of ['X-Freeshard-Secret', 'X-Internal-Secret']) {
        const res = await fetch(`${base}/api/auth/session`, { headers: { [header]: bad } });
        assert.equal(res.status, 401, `${header} ${JSON.stringify(bad)} must be refused`);
      }
    }
  });

  await t.test('the INTERNAL_WEBHOOK_SECRET does not pass the proxy gate', async () => {
    const res = await fetch(`${base}/api/auth/session`, { headers: { 'X-Freeshard-Secret': prodEnv({}).INTERNAL_WEBHOOK_SECRET } });
    assert.equal(res.status, 401);
  });

  await t.test('the right secret yields the env user', async () => {
    const res = await fetch(`${base}/api/auth/session`, { headers: proxied });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.userId, 'testuser');
    assert.equal(body.email, 'testuser@example.com');

    const cookie = cookieOf(res);
    assert.ok(cookie, 'the proxied handshake sets a session cookie');
    const api = await fetch(`${base}/api/working-hours`, { headers: { ...proxied, cookie } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).userId, 'testuser');
  });

  await t.test('a session cookie without the secret is 401', async () => {
    const res = await fetch(`${base}/api/auth/session`, { headers: proxied });
    const cookie = cookieOf(res);
    for (const p of ['/api/auth/session', '/api/working-hours', '/api/accounts']) {
      const direct = await fetch(`${base}${p}`, { headers: { cookie } });
      assert.equal(direct.status, 401, `GET ${p} with a cookie but no secret must be 401`);
    }
    // State-changing methods too, even with the app's own Origin (passes the CSRF guard).
    const sameOrigin = { cookie, Origin: 'https://calendar.shard.example', 'Content-Type': 'application/json' };
    for (const [method, p] of [['POST', '/api/accounts'], ['DELETE', '/api/accounts/x'], ['PUT', '/api/working-hours']]) {
      const direct = await fetch(`${base}${p}`, { method, headers: sameOrigin, body: '{}' });
      assert.equal(direct.status, 401, `${method} ${p} with a cookie but no secret must be 401`);
    }
    // Control: the same POST through the proxy is let through to the handler (400: empty body).
    const viaProxy = await fetch(`${base}/api/accounts`, { method: 'POST', headers: { ...sameOrigin, ...proxied }, body: '{}' });
    assert.equal(viaProxy.status, 400);
  });

  await t.test('the container healthcheck stays reachable without the secret', async () => {
    for (const p of ['/health', '/api/health']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, p);
    }
  });
});
