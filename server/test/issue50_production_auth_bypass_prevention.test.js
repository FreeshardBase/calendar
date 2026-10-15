'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Production semantics on an isolated database: the repository's default
// webcalendar.db is shared with other suites that use other encryption keys (#333).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue50-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.DATABASE_PATH = path.join(tmpDir, 'issue50.db');

test('Issue #50: Impersonation via X-Test-User-Id / X-Forwarded-User is strictly blocked in production', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'oidc';
  process.env.SESSION_SECRET = 'test-prod-session-secret-9876543210123456';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  delete process.env.HTTP_HEADER_AUTH_SECRET;
  delete process.env.INTERNAL_WEBHOOK_SECRET;

  const { app } = require('../index.js');
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  t.after(() => {
    server.close();
    process.env = origEnv;
  });

  async function sendReq(path, headers = {}, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const endpoints = [
    { method: 'GET', path: '/api/calendars' },
    { method: 'POST', path: '/api/calendars', body: JSON.stringify({ name: 'Hacked' }) },
    { method: 'GET', path: '/api/accounts' },
    { method: 'POST', path: '/api/accounts', body: JSON.stringify({ url: 'http://127.0.0.1:9999', username: 'victim-0001', password: 'password' }) },
    { method: 'GET', path: '/api/msgraph/accounts' },
    { method: 'GET', path: '/api/notifications/push-subscriptions' },
    { method: 'GET', path: '/api/resources/bookings' },
    { method: 'POST', path: '/api/resources/bookings', body: JSON.stringify({ resourceId: 1, startTime: '2026-01-01', endTime: '2026-01-02' }) },
    { method: 'GET', path: '/api/freebusy/search' },
    { method: 'GET', path: '/api/availability-slots' },
    { method: 'GET', path: '/api/webcal/subscriptions' }
  ];

  await t.test('Control: Unauthenticated requests return 401 Unauthorized across all protected routes', async () => {
    for (const ep of endpoints) {
      const res = await sendReq(ep.path, {}, ep.method, ep.body);
      assert.strictEqual(res.status, 401, `Expected 401 without auth credentials on ${ep.method} ${ep.path}, got ${res.status}`);
    }
  });

  await t.test('Attack vector 1: X-Test-User-Id header rejected with 401 across all protected routes', async () => {
    for (const ep of endpoints) {
      const res = await sendReq(ep.path, { 'x-test-user-id': 'victim-user-0001' }, ep.method, ep.body);
      assert.strictEqual(res.status, 401, `Expected 401 on ${ep.method} ${ep.path} with X-Test-User-Id, got ${res.status}`);
    }
  });

  await t.test('Attack vector 2: X-Forwarded-User header rejected with 401 without proxy secret', async () => {
    for (const ep of endpoints) {
      const res = await sendReq(ep.path, { 'x-forwarded-user': 'victim-user-0001' }, ep.method, ep.body);
      assert.strictEqual(res.status, 401, `Expected 401 on ${ep.method} ${ep.path} with X-Forwarded-User, got ${res.status}`);
    }
  });

  await t.test('Attack vector 3: X-User-Id & Remote-User headers rejected with 401 without proxy secret', async () => {
    const resRemote = await sendReq('/api/calendars', { 'remote-user': 'victim-user-0001' });
    assert.strictEqual(resRemote.status, 401);
    const resUserId = await sendReq('/api/calendars', { 'x-user-id': 'victim-user-0001' });
    assert.strictEqual(resUserId.status, 401);
  });

  await t.test('Attack vector 4: Unauthenticated POST /api/accounts cannot set session identity or bypass auth to impersonate victim', async () => {
    // Attack: caller sends unauthenticated POST /api/accounts with victim's username
    const attackRes = await sendReq('/api/accounts', {}, 'POST', JSON.stringify({
      url: 'http://127.0.0.1:9999',
      username: 'victim-user-0001',
      password: 'password'
    }));
    assert.strictEqual(attackRes.status, 401, `Expected 401 on unauthenticated POST /api/accounts, got ${attackRes.status}`);

    // If any session cookie was issued, ensure subsequent requests with that cookie cannot authenticate as victim
    const setCookie = attackRes.headers['set-cookie'];
    if (setCookie) {
      const cookieHeader = Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : setCookie.split(';')[0];
      const sessionRes = await sendReq('/api/auth/session', { cookie: cookieHeader });
      const sessionBody = JSON.parse(sessionRes.body || '{}');
      assert.notStrictEqual(sessionBody.userId, 'victim-user-0001', 'Attacker must not be able to set session userId');
      assert.strictEqual(sessionBody.authenticated, false, 'Attacker session must not be authenticated');

      const calRes = await sendReq('/api/calendars', { cookie: cookieHeader });
      assert.strictEqual(calRes.status, 401, 'Attacker session must not be able to access calendars');

      const accRes = await sendReq('/api/accounts', { cookie: cookieHeader });
      assert.strictEqual(accRes.status, 401, 'Attacker session must not be able to access accounts');
    }
  });

  await t.test('Attack vector 5: Shard configuration with INTERNAL_WEBHOOK_SECRET rejects wrong secret and X-Test-User-Id', async () => {
    process.env.INTERNAL_WEBHOOK_SECRET = 'shard-webhook-secret-xyz';

    try {
      // 1. Wrong secret with proxy header -> 401
      const resWrongSecret = await sendReq('/api/calendars', {
        'x-freeshard-secret': 'wrong-secret',
        'x-forwarded-user': 'victim-user-0001'
      });
      assert.strictEqual(resWrongSecret.status, 401, 'Expected 401 with wrong secret');

      // 2. Missing secret with proxy header -> 401
      const resNoSecret = await sendReq('/api/calendars', {
        'x-forwarded-user': 'victim-user-0001'
      });
      assert.strictEqual(resNoSecret.status, 401, 'Expected 401 without secret');

      // 3. X-Test-User-Id rejected even if correct secret is provided (test headers never work in prod)
      const resTestUserWithSecret = await sendReq('/api/calendars', {
        'x-freeshard-secret': 'shard-webhook-secret-xyz',
        'x-test-user-id': 'victim-user-0001'
      });
      assert.strictEqual(resTestUserWithSecret.status, 401, 'Expected 401 for X-Test-User-Id even with secret in prod');
    } finally {
      delete process.env.INTERNAL_WEBHOOK_SECRET;
    }
  });
});
