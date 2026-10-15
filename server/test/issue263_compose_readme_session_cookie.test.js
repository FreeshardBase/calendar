'use strict';

/**
 * Issue #263 — the documented Docker quick start must give the reader a working session.
 *
 * Boots the real server process (`node server/index.js`) with the environment the repo's own
 * docker-compose.yml hands the `webcalendar` service (on top of .env.example, as the README's
 * `cp .env.example .env` step does), then requests the URL README.md says the app listens on.
 * That URL must connect, and the response must carry a session cookie the client can send back
 * over that same scheme.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'index.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue263-compose-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const PROXY_SECRET = 'issue263-proxy-secret-0123456789abcdef0123';
// What the FreeShard platform proxy adds for a paired terminal (#246, #143).
const PROXY_HEADERS = { 'X-Freeshard-Secret': PROXY_SECRET, 'X-Ptl-Client-Type': 'terminal' };
// Values the reader puts into .env for the ${VAR} references in docker-compose.yml.
const DOTENV_SECRETS = {
  SESSION_SECRET: 'issue263-prod-session-secret-0123456789abcdef',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SYSTEM_SYNC_SECRET: 'issue263-system-sync-secret-0123456789abcdef',
  INTERNAL_WEBHOOK_SECRET: 'issue263-internal-webhook-secret-0123456789',
  HTTP_HEADER_AUTH_SECRET: PROXY_SECRET,
  BASE_URL: 'http://localhost:3000',
  CALDAV_USERNAME: 'testuser',
  CALDAV_EMAIL: 'testuser@example.com'
};

function parseDotenv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The `environment:` mapping of the `webcalendar` service, with ${VAR} / ${VAR:-default} resolved.
function composeEnvironment(dotenv) {
  const lines = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').split('\n');
  const svc = lines.findIndex((l) => /^ {2}webcalendar:\s*$/.test(l));
  assert.ok(svc >= 0, 'docker-compose.yml must define the webcalendar service');
  const envIdx = lines.findIndex((l, i) => i > svc && /^ {4}environment:\s*$/.test(l));
  assert.ok(envIdx > svc, 'webcalendar service must have an environment mapping');
  const resolve = (v) => v.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*\}?))?\}/g, (_, name, def) => {
    if (dotenv[name] !== undefined && dotenv[name] !== '') return dotenv[name];
    if (def === undefined) return '';
    return resolve(def);
  });
  const env = {};
  for (let i = envIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {6}([A-Z0-9_]+):\s*(.*)$/);
    if (!m) break;
    let value = m[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    env[m[1]] = resolve(value);
  }
  return env;
}

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

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (!settled && stdout.includes('running on')) {
        settled = true;
        resolve({ child, started: true, stdout, stderr });
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ child, started: false, code, stdout, stderr });
      }
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

// GET with the client semantics of the URL's scheme; rejects if the connection fails.
function get(url, headers) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { headers, rejectUnauthorized: false, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout connecting to ${url}`)));
    req.on('error', reject);
  });
}

function documentedAppUrl() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/The app listens on (\S+?)[\s(]/);
  assert.ok(m, 'README.md must state the URL the app listens on');
  return m[1];
}

test('#263: the README quick-start URL connects to the compose stack and issues a usable session cookie', async () => {
  const dotenv = { ...parseDotenv(path.join(ROOT, '.env.example')), ...DOTENV_SECRETS };
  const compose = composeEnvironment(dotenv);
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...dotenv,
    ...compose,
    // Host-side adjustments only: the container's data volume path and its fixed port.
    DATABASE_PATH: path.join(tmpDir, 'compose.db'),
    PORT: String(port)
  };
  assert.equal(env.NODE_ENV, 'production', 'the compose stack runs in production mode');

  const run = await start(env);
  assert.ok(run.started, `server must start under the compose environment: ${run.stderr}`);
  try {
    const documented = new URL(documentedAppUrl());
    assert.equal(documented.hostname, 'localhost');
    assert.equal(documented.port, '3000', 'README documents the compose port mapping 3000');
    const url = `${documented.protocol}//localhost:${port}/`;

    const res = await get(url, PROXY_HEADERS);
    assert.equal(res.status, 200, `${documented.href} must serve the app`);

    const setCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('connect.sid='));
    assert.ok(setCookie, `${documented.href} must issue a session cookie under the compose environment`);
    // A Secure cookie is never sent back over plain HTTP, so it would be no session at all.
    if (documented.protocol === 'http:') {
      assert.doesNotMatch(setCookie, /;\s*Secure/i, 'a cookie issued over http must not be Secure');
    }

    const cookie = setCookie.split(';')[0];
    const again = await get(url, { ...PROXY_HEADERS, cookie });
    assert.equal(again.status, 200);
    const reissued = (again.headers['set-cookie'] || []).find((c) => c.startsWith('connect.sid='));
    assert.ok(!reissued || reissued.split(';')[0] === cookie,
      'the session cookie must be accepted on the next request, not replaced by a fresh session');
  } finally {
    await stop(run.child);
  }
});
