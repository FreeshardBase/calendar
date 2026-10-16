'use strict';

/**
 * Issue #224 — a failed first request must not look like "no accounts".
 *
 * The browser half (re-authenticate prompt on 401, error state instead of an empty sidebar) is
 * covered in e2e/calendar.spec.js. Here, under NODE_ENV=production semantics:
 *  - GET /api/accounts answers 500, not an empty list, when the account loader failed.
 *  - With AUTH_METHOD=oidc and no session, the page itself redirects to the login, so the SPA is
 *    not served to a signed-out user whose every API call then fails with 401.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue224-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

// Set before anything loads server/db.js, which reads them once.
process.env.NODE_ENV = 'production';
process.env.AUTH_METHOD = 'oidc';
process.env.BASE_URL = 'https://calendar.shard.example';
process.env.DATABASE_PATH = path.join(tmpDir, 'issue224.db');
process.env.SESSION_SECRET = 'issue224-prod-session-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER_URL = 'http://127.0.0.1:9';
process.env.OIDC_CLIENT_ID = 'webcalendar';
process.env.OIDC_CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';
delete process.env.HTTP_HEADER_AUTH;
delete process.env.HTTP_HEADER_AUTH_SECRET;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('GET /api/accounts answers 500 without the cause when the account loader failed', async () => {
  const express = require('express');
  const app = express();
  app.use((req, res, next) => {
    req.accountLoadError = 'Database disk I/O error';
    next();
  });
  app.use('/api/accounts', require('../routes/accounts'));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts`);
    assert.equal(res.status, 500);
    // #160: the root cause is logged by server/index.js, never sent to the client.
    assert.deepEqual(await res.json(), { error: 'Fehler beim Laden der Kontodaten.' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AUTH_METHOD=oidc: the page redirects a signed-out browser to the login (NODE_ENV=production)', async (t) => {
  const { app } = require('../index.js');
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  for (const page of ['/', '/index.html']) {
    const res = await fetch(`http://127.0.0.1:${port}${page}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `${page} must not serve the SPA without a session`);
    assert.equal(res.headers.get('location'), '/api/auth/login', `${page} must redirect to the login`);
  }

  // Static assets carry no user data and stay public.
  const asset = await fetch(`http://127.0.0.1:${port}/css/app.css`, { redirect: 'manual' });
  assert.equal(asset.status, 200);

  const api = await fetch(`http://127.0.0.1:${port}/api/accounts`, { redirect: 'manual' });
  assert.equal(api.status, 401, 'API routes answer 401, the page answers with a redirect');
});
