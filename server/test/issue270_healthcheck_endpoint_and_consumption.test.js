'use strict';

/**
 * Issue #270 — the container healthcheck (Dockerfile HEALTHCHECK, docker-compose.yml) runs
 * GET /api/health. It must go unhealthy when the app cannot reach its storage: the internal
 * CalDAV backend (INTERNAL_CALDAV_URL) or the SQLite database file.
 *
 * The real server/index.js is mounted under NODE_ENV=production; INTERNAL_CALDAV_URL points at
 * a loopback stand-in for Radicale that the test can stop or make reject the credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue270-'));
const dbFile = path.join(tmpDir, 'webcalendar.db');
const SYSTEM_SYNC_SECRET = 'issue270-system-sync-secret-0123456789abcdef';

const backend = {
  acceptedSecret: SYSTEM_SYNC_SECRET,
  requests: [],
};
const caldav = http.createServer((req, res) => {
  backend.requests.push({ method: req.method, url: req.url, headers: req.headers });
  const expected = 'Basic ' + Buffer.from(`healthcheck:${backend.acceptedSecret}`).toString('base64');
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Radicale"' });
    return res.end();
  }
  res.writeHead(207, { 'Content-Type': 'text/xml; charset=utf-8' });
  res.end('<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href>'
    + '<propstat><prop/><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>');
});

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => caldav.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: dbFile,
    SESSION_SECRET: 'issue270-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET,
    INTERNAL_WEBHOOK_SECRET: 'issue270-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: 'issue270-proxy-secret-0123456789abcdef',
    BASE_URL: 'https://calendar.shard.example',
    CALDAV_USERNAME: 'testuser',
    CALDAV_EMAIL: 'testuser@example.com',
    INTERNAL_CALDAV_URL: `http://127.0.0.1:${caldav.address().port}`,
  });
  delete process.env.DISABLE_INTERNAL_CALDAV;
  ({ server } = require('../index'));
  await require('../db').ready;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (caldav.listening) await new Promise((resolve) => caldav.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function health(p = '/api/health') {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
}

test('Issue #270 — /api/health reports the storage the app depends on', async (t) => {
  await t.test('backend up and database readable: both health paths answer 200', async () => {
    for (const p of ['/api/health', '/health']) {
      backend.requests = [];
      const { status, body } = await health(p);
      assert.equal(status, 200, `${p}: ${JSON.stringify(body)}`);
      assert.equal(body.status, 'ok');
      assert.equal(backend.requests.length, 1, `${p} must probe the CalDAV backend once`);
      const [probe] = backend.requests;
      assert.equal(probe.method, 'PROPFIND');
      assert.equal(probe.headers.depth, '0');
      assert.equal(probe.headers['accept-encoding'], 'identity');
    }
  });

  await t.test('the backend rejects the system credentials: 503', async () => {
    backend.acceptedSecret = 'a-different-secret';
    try {
      const { status, body } = await health();
      assert.equal(status, 503, JSON.stringify(body));
      assert.equal(body.status, 'error');
      assert.equal(body.caldav, 'unavailable');
    } finally {
      backend.acceptedSecret = SYSTEM_SYNC_SECRET;
    }
    assert.equal((await health()).status, 200, 'health must recover with the backend');
  });

  await t.test('the database file is gone: 503, and 200 again once it is back', async () => {
    const moved = `${dbFile}.moved`;
    fs.renameSync(dbFile, moved);
    try {
      const { status, body } = await health();
      assert.equal(status, 503, JSON.stringify(body));
      assert.equal(body.status, 'error');
      assert.equal(body.database, 'unavailable');
      assert.equal(body.caldav, 'connected', 'the backend itself is still up');
    } finally {
      fs.renameSync(moved, dbFile);
    }
    assert.equal((await health()).status, 200);
  });

  await t.test('the backend is stopped: 503 on both paths', async () => {
    await new Promise((resolve) => caldav.close(resolve));
    for (const p of ['/api/health', '/health']) {
      const { status, body } = await health(p);
      assert.equal(status, 503, `${p}: ${JSON.stringify(body)}`);
      assert.equal(body.status, 'error');
      assert.equal(body.caldav, 'unavailable');
      assert.equal(body.database, 'connected');
    }
  });
});
