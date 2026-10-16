'use strict';

/**
 * Boots the real server process (`node server/index.js`) under NODE_ENV=production in env mode,
 * on a free port and its own temporary database, and stops it when the test ends.
 * Requests pass the platform proxy gate with the TERMINAL headers (#143/#246).
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'index.js');
const PROXY_SECRET = 'prod-harness-proxy-secret-0123456789abcdef';
const SYSTEM_SYNC_SECRET = 'prod-harness-system-sync-secret-0123456789';
const TERMINAL = { 'X-Freeshard-Secret': PROXY_SECRET, 'X-Ptl-Client-Type': 'terminal' };

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

function productionEnv(tmpDir, port, overrides) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    PORT: String(port),
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, 'webcalendar.db'),
    SESSION_SECRET: 'prod-harness-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET,
    INTERNAL_WEBHOOK_SECRET: 'prod-harness-internal-webhook-secret-01234',
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
        resolve({ child, started: true, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ child, started: false, stderr: () => stderr });
      }
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

/** Returns { base, stderr() } for a running production server; `overrides` may unset a variable with undefined. */
async function bootProductionServer(t, overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-harness-'));
  const port = await freePort();
  const r = await start(productionEnv(tmpDir, port, overrides));
  t.after(async () => {
    await stop(r.child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  assert.equal(r.started, true, `server must start, stderr: ${r.stderr()}`);
  return { base: `http://127.0.0.1:${port}`, stderr: r.stderr };
}

module.exports = { bootProductionServer, TERMINAL, SYSTEM_SYNC_SECRET };
