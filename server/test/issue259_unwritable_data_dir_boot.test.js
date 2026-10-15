'use strict';

/**
 * Issue #259 — the documented Docker quick start crash-looped: the app's data directory was not
 * writable by its uid, the process died with SQLITE_CANTOPEN, and `restart: unless-stopped`
 * restarted it forever. Each cycle printed the success banner ("running on …") before the
 * database error, so the logs looked like a healthy start.
 *
 * Exercised by booting the real server process (`node server/index.js`) in production against a
 * data directory its own uid cannot write — the exact condition the root-owned mount produced.
 * A server that cannot open its database must exit non-zero, must never announce that it is
 * running, and must name the database path it could not open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue259-'));
process.on('exit', () => {
  for (const entry of fs.readdirSync(tmpDir)) fs.chmodSync(path.join(tmpDir, entry), 0o755);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SERVER = path.join(__dirname, '..', 'index.js');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function prodEnv(dataDir, overrides) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    PORT: '0',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(dataDir, 'webcalendar.db'),
    SESSION_SECRET: 'issue259-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue259-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue259-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: 'issue259-proxy-secret-0123456789abcdef0123',
    BASE_URL: 'https://calendar.shard.example',
    CALDAV_USERNAME: 'testuser',
    CALDAV_EMAIL: 'testuser@example.com',
    ...overrides,
  };
}

// Runs the server until it exits (or 15 s pass); returns exit code and both streams.
function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function readOnlyDir(name, files = {}) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  fs.chmodSync(dir, 0o555);
  return dir;
}

test.describe('Issue #259 — unwritable data directory is a loud boot failure', { skip: isRoot && 'root ignores directory modes' }, () => {
  test('fresh read-only data directory: exits non-zero without the success banner', async () => {
    const dataDir = readOnlyDir('fresh');
    const res = await run(prodEnv(dataDir));

    assert.equal(res.signal, null, `server must exit by itself, not hang: ${res.stdout}${res.stderr}`);
    assert.notEqual(res.code, 0, 'server must fail when it cannot write its data directory');
    assert.doesNotMatch(res.stdout, /running on/, 'success banner must not be printed before the failure');
    assert.match(res.stderr, /EACCES|SQLITE_CANTOPEN/);
  });

  test('only the database cannot be created: exits non-zero, no banner, names the database path', async () => {
    // Both key sidecars already exist, so the database open is the only write that can fail.
    const key = prodEnv('').ENCRYPTION_KEY;
    const dataDir = readOnlyDir('db-only', { '.encryption_key': key, '.share_key': Buffer.alloc(32, 7) });
    const env = prodEnv(dataDir);
    const res = await run(env);

    assert.equal(res.signal, null, `server must exit by itself, not hang: ${res.stdout}${res.stderr}`);
    assert.notEqual(res.code, 0, 'server must fail when it cannot open its database');
    assert.doesNotMatch(res.stdout, /running on/, 'success banner must not be printed before the database is open');
    assert.ok(res.stderr.includes(env.DATABASE_PATH), `error must name the database path: ${res.stderr}`);
  });
});
