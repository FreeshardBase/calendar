'use strict';

/**
 * Issue #344 — lifecycle and observability.
 *
 * - SIGTERM (shard idle shutdown) stops accepting connections, lets in-flight requests finish,
 *   closes the SQLite database (which checkpoints and removes the WAL) and exits 0.
 * - The server logs one JSON object per line with a level, the request id of the request it
 *   belongs to, and credentials redacted.
 *
 * The server is the real process (`node server/index.js`) under NODE_ENV=production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue344-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');
const INTERNAL_SECRET = 'issue344-internal-webhook-secret-0123456789';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function prodEnv(port, dbPath, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    PORT: String(port),
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: dbPath,
    DISABLE_INTERNAL_CALDAV: 'true',
    SESSION_SECRET: 'issue344-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue344-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: INTERNAL_SECRET,
    HTTP_HEADER_AUTH_SECRET: 'issue344-proxy-secret-0123456789abcdef0123',
    BASE_URL: 'https://calendar.shard.example',
    ...overrides
  };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

async function startServer(overrides) {
  const port = await freePort();
  const dbPath = path.join(tmpDir, `shutdown-${Math.random().toString(36).slice(2)}.db`);
  const child = spawn(process.execPath, [SERVER], { env: prodEnv(port, dbPath, overrides), stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
  exited.then(() => clearTimeout(killer));

  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`server exited during startup: ${out.stderr}`);
    try {
      const res = await get(port, '/health');
      if (res.status === 200) break;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' || i > 150) throw err;
    }
    await delay(100);
  }
  return { child, port, dbPath, out, exited };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
  });
}

function logLines(text) {
  return text.split('\n').filter((l) => l.trim() !== '');
}

test('Issue #344 — SIGTERM drains in-flight requests, closes the database and exits 0', async () => {
  const srv = await startServer();
  try {
    // A request whose body is still arriving: express.json holds it in flight.
    const body = JSON.stringify({ mode: 'TRUNCATE' });
    const socket = await connect(srv.port);
    let response = '';
    socket.on('data', (c) => { response += c; });
    const socketClosed = new Promise((resolve) => socket.on('close', resolve));
    socket.write(
      'POST /internal/db/quiesce HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
      + `X-Internal-Secret: ${INTERNAL_SECRET}\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`
    );
    await delay(300);

    srv.child.kill('SIGTERM');
    await delay(500);

    assert.equal(srv.child.exitCode, null, 'the process must wait for the in-flight request');
    assert.equal(srv.child.signalCode, null, 'SIGTERM must be handled, not kill the process');
    await assert.rejects(connect(srv.port), { code: 'ECONNREFUSED' }, 'no new connection is accepted after SIGTERM');

    socket.write(body.slice(5));
    await socketClosed;
    assert.match(response, /^HTTP\/1\.1 200 /, `the in-flight request is answered, got: ${response}`);

    const { code, signal } = await srv.exited;
    assert.equal(signal, null);
    assert.equal(code, 0, `clean shutdown exits 0, stderr: ${srv.out.stderr}`);
    assert.equal(fs.existsSync(`${srv.dbPath}-wal`), false, 'the database was closed (WAL checkpointed and removed)');
  } finally {
    srv.child.kill('SIGKILL');
  }
});

test('Issue #344 — a request that outlasts SHUTDOWN_TIMEOUT_MS is cut off and the exit code says so', async () => {
  const srv = await startServer({ SHUTDOWN_TIMEOUT_MS: '500' });
  try {
    const socket = await connect(srv.port);
    socket.on('error', () => {});
    const socketClosed = new Promise((resolve) => socket.on('close', resolve));
    socket.write(
      'POST /internal/db/quiesce HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
      + `X-Internal-Secret: ${INTERNAL_SECRET}\r\nContent-Length: 100\r\n\r\n{"mo`
    );
    await delay(300);
    srv.child.kill('SIGTERM');

    const { code, signal } = await srv.exited;
    await socketClosed;
    assert.equal(signal, null);
    assert.equal(code, 1, 'a forced shutdown is not reported as clean');
    assert.ok(logLines(srv.out.stderr).some((l) => /in-flight/.test(JSON.parse(l).msg)), srv.out.stderr);
    assert.equal(fs.existsSync(`${srv.dbPath}-wal`), false, 'the database is closed even after a forced shutdown');
  } finally {
    srv.child.kill('SIGKILL');
  }
});

test('Issue #344 — the server logs JSON lines with levels and answers with a request id', async () => {
  const srv = await startServer();
  try {
    const res = await get(srv.port, '/health');
    assert.match(res.headers['x-request-id'] || '', /^[0-9a-f-]{36}$/);

    srv.child.kill('SIGTERM');
    await srv.exited;
    const lines = [...logLines(srv.out.stdout), ...logLines(srv.out.stderr)];
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level), line);
      assert.equal(typeof entry.msg, 'string', line);
      assert.ok(!Number.isNaN(Date.parse(entry.time)), line);
      assert.ok(!/\p{Extended_Pictographic}/u.test(entry.msg), `no emoji in logs: ${line}`);
    }
    assert.ok(lines.some((l) => /running on/.test(JSON.parse(l).msg)));
  } finally {
    srv.child.kill('SIGKILL');
  }
});

test('Issue #344 — logger levels, request ids and redaction', async (t) => {
  const logger = require('../utils/logger');
  const captured = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  t.beforeEach(() => {
    captured.length = 0;
    for (const name of Object.keys(orig)) console[name] = (line) => captured.push({ stream: name, line });
  });
  t.afterEach(() => Object.assign(console, orig));

  await t.test('one JSON object per call; error and warn go to stderr', () => {
    logger.info('[sync] done', { calendars: 2 });
    logger.error('[sync] failed:', new Error('boom\nsecond line'));
    assert.equal(captured.length, 2);
    assert.equal(captured[0].stream, 'log');
    assert.equal(captured[1].stream, 'error');
    const info = JSON.parse(captured[0].line);
    assert.equal(info.level, 'info');
    assert.match(info.msg, /^\[sync\] done .*calendars: 2/);
    const error = JSON.parse(captured[1].line);
    assert.equal(error.level, 'error');
    assert.match(error.msg, /boom/);
    assert.ok(!captured[1].line.includes('\n'), 'one line per entry');
  });

  await t.test('entries below LOG_LEVEL are dropped', () => {
    const quiet = logger.createLogger({ level: 'warn' });
    quiet.info('hidden');
    quiet.debug('hidden');
    quiet.warn('shown');
    assert.deepEqual(captured.map((c) => JSON.parse(c.line).msg), ['shown']);
    assert.throws(() => logger.createLogger({ level: 'verbose' }), /LOG_LEVEL/);
  });

  await t.test('credentials are redacted from objects and strings', () => {
    logger.info('[accounts] linking', {
      username: 'testuser',
      password: 'hunter2-pw',
      nested: { accessToken: 'tok-123', refresh_token: 'tok-456', Authorization: 'Basic dGVzdA==' },
      secrets: ['x'],
    });
    logger.warn('PROPFIND https://testuser:url-pw@caldav.example/ failed, Authorization: Bearer abc.def.ghi');
    const text = captured.map((c) => c.line).join('\n');
    for (const secret of ['hunter2-pw', 'tok-123', 'tok-456', 'dGVzdA==', 'url-pw', 'abc.def.ghi']) {
      assert.ok(!text.includes(secret), `${secret} must not be logged: ${text}`);
    }
    assert.match(text, /testuser/);
    assert.match(text, /\[REDACTED\]/);
  });

  await t.test('lines logged while serving a request carry its request id', async () => {
    const express = require('express');
    const app = express();
    app.use(logger.requestContext);
    app.get('/x', async (req, res) => {
      await delay(5);
      logger.info('[x] handled');
      res.end('ok');
    });
    const server = app.listen(0);
    try {
      const res = await get(server.address().port, '/x');
      const id = res.headers['x-request-id'];
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(JSON.parse(captured.at(-1).line).reqId, id);
    } finally {
      server.close();
    }
  });
});
