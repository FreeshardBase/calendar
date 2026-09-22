'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

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
    { method: 'GET', path: '/api/msgraph/accounts' },
    { method: 'GET', path: '/api/notifications/push-subscriptions' },
    { method: 'GET', path: '/api/resources/bookings' },
    { method: 'POST', path: '/api/resources/bookings', body: JSON.stringify({ resourceId: 1, startTime: '2026-01-01', endTime: '2026-01-02' }) },
    { method: 'GET', path: '/api/freebusy/search' },
    { method: 'GET', path: '/api/availability-slots' },
    { method: 'GET', path: '/api/webcal/subscriptions' }
  ];

  await t.test('Control: Unauthenticated requests return 401 Unauthorized', async () => {
    const res = await sendReq('/api/calendars');
    assert.strictEqual(res.status, 401, 'Expected 401 without auth credentials');
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
});
