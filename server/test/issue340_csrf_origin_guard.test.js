'use strict';

/**
 * Issue #340 — CSRF defence by origin, under NODE_ENV=production semantics.
 *
 * On a shard every app is a sibling subdomain of the same registrable domain, so SameSite
 * cookies do not stop a malicious app from posting to the calendar. A state-changing request
 * is accepted only if its Origin is the BASE_URL origin or, without Origin, Sec-Fetch-Site is
 * 'same-origin'. Server-to-server endpoints authenticated by a secret or a signed token are exempt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue340-csrf-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example/';
const INTERNAL_SECRET = 'issue340-internal-webhook-secret-0123456789';
// #246/#143: in production, env mode serves only requests a paired terminal sends through the platform proxy.
const PROXY = { 'X-Freeshard-Secret': 'issue340-proxy-secret-0123456789abcdef0123', 'X-Ptl-Client-Type': 'terminal' };

test('Issue #340 — origin-based CSRF guard (NODE_ENV=production)', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'env';
  process.env.BASE_URL = BASE_URL;
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue340.db');
  process.env.SESSION_SECRET = 'issue340-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.INTERNAL_WEBHOOK_SECRET = INTERNAL_SECRET;
  delete process.env.HTTP_HEADER_AUTH;
  process.env.HTTP_HEADER_AUTH_SECRET = PROXY['X-Freeshard-Secret'];

  const { app } = require('../index.js');
  const { loginAs } = require('./helpers/testSession');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookie = await loginAs('testuser', { email: 'testuser@example.com' });

  t.after(() => {
    server.close();
    process.env = origEnv;
  });

  // POST /api/accounts with an empty body answers 400 once it is let through.
  function postAccounts(headers, body = '{}', contentType = 'application/json') {
    return fetch(`${origin}/api/accounts`, {
      method: 'POST',
      headers: { ...PROXY, cookie, 'Content-Type': contentType, ...headers },
      body
    });
  }

  await t.test('a sibling app on the same shard (same-site) is refused', async () => {
    const res = await postAccounts({ Origin: 'https://evil.shard.example', 'Sec-Fetch-Site': 'same-site' });
    assert.equal(res.status, 403);
  });

  await t.test('a classic form post from a sibling app is refused', async () => {
    const res = await postAccounts(
      { Origin: 'https://evil.shard.example' },
      'url=https%3A%2F%2Fattacker.example&username=testuser&password=x',
      'application/x-www-form-urlencoded'
    );
    assert.equal(res.status, 403);
  });

  await t.test('an opaque origin ("null", sandboxed iframe) is refused', async () => {
    assert.equal((await postAccounts({ Origin: 'null' })).status, 403);
  });

  await t.test('the same host on another scheme or port is refused', async () => {
    assert.equal((await postAccounts({ Origin: 'http://calendar.shard.example' })).status, 403);
    assert.equal((await postAccounts({ Origin: 'https://calendar.shard.example:8443' })).status, 403);
  });

  await t.test('without Origin, Sec-Fetch-Site other than same-origin is refused', async () => {
    assert.equal((await postAccounts({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await postAccounts({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await postAccounts({ 'Sec-Fetch-Site': 'none' })).status, 403);
  });

  await t.test('a request with neither Origin nor Sec-Fetch-Site is refused', async () => {
    assert.equal((await postAccounts({})).status, 403);
  });

  await t.test('PUT, PATCH and DELETE are guarded too', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${origin}/api/accounts/does-not-exist`, {
        method,
        headers: { ...PROXY, cookie, Origin: 'https://evil.shard.example', 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert.equal(res.status, 403, `${method} from a foreign origin must be refused`);
    }
  });

  await t.test('the app\'s own origin passes the guard', async () => {
    const res = await postAccounts({ Origin: 'https://calendar.shard.example' });
    assert.equal(res.status, 400);
  });

  await t.test('without Origin, Sec-Fetch-Site: same-origin passes the guard', async () => {
    const res = await postAccounts({ 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(res.status, 400);
  });

  await t.test('safe methods are not guarded', async () => {
    const res = await fetch(`${origin}/api/accounts`, { headers: { ...PROXY, cookie, Origin: 'https://evil.shard.example' } });
    assert.equal(res.status, 200);
  });

  await t.test('secret-authenticated internal webhooks (server-to-server) are not guarded', async () => {
    const res = await fetch(`${origin}/internal/webhooks/user-deleted`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(res.status, 400, 'missing user_id, but the request reached the handler');
  });

  await t.test('the OIDC back-channel logout (IdP-to-server, signed token) is not guarded', async () => {
    const res = await fetch(`${origin}/api/auth/backchannel-logout`, {
      method: 'POST',
      headers: { ...PROXY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ''
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), 'Missing logout_token');
  });
});
