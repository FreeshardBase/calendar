'use strict';

/**
 * Issue #340 — header-auth secret and per-IP rate limiting, under NODE_ENV=production semantics.
 *
 *  - The proxy header identity is accepted only with HTTP_HEADER_AUTH_SECRET, compared in
 *    constant time; INTERNAL_WEBHOOK_SECRET no longer opens it.
 *  - Login/auth routes and public routes answer 429 once a client IP exceeds its budget.
 *    The client IP is the one the shard's reverse proxy appended to X-Forwarded-For, so a
 *    client cannot mint fresh IPs by prepending its own entries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue340-limits-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const HEADER_SECRET = 'issue340-header-auth-secret-0123456789ab';
const INTERNAL_SECRET = 'issue340-internal-webhook-secret-0123456789';

test('Issue #340 — header secret & rate limits (NODE_ENV=production)', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  // oidc, so the #246 env-mode proxy gate does not answer first and the header identity is measured alone.
  process.env.AUTH_METHOD = 'oidc';
  process.env.BASE_URL = 'https://calendar.shard.example';
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue340.db');
  process.env.SESSION_SECRET = 'issue340-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.INTERNAL_WEBHOOK_SECRET = INTERNAL_SECRET;
  process.env.HTTP_HEADER_AUTH = 'true';
  delete process.env.TRUST_PROXY;
  delete process.env.OIDC_ISSUER_URL;

  const { app } = require('../index.js');
  const { AUTH_RATE_LIMIT, PUBLIC_RATE_LIMIT } = require('../utils/rateLimit');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    process.env = origEnv;
  });

  function asProxiedUser(secret) {
    return fetch(`${origin}/api/accounts`, {
      headers: { 'x-freeshard-secret': secret, 'x-forwarded-user': 'testuser', 'x-forwarded-email': 'testuser@example.com' }
    });
  }

  await t.test('INTERNAL_WEBHOOK_SECRET does not open the header identity', async () => {
    delete process.env.HTTP_HEADER_AUTH_SECRET;
    assert.equal((await asProxiedUser(INTERNAL_SECRET)).status, 401);
  });

  await t.test('a wrong header secret of the same length is refused', async () => {
    process.env.HTTP_HEADER_AUTH_SECRET = HEADER_SECRET;
    const wrong = HEADER_SECRET.slice(0, -1) + (HEADER_SECRET.endsWith('b') ? 'c' : 'b');
    assert.equal((await asProxiedUser(wrong)).status, 401);
    assert.equal((await asProxiedUser(INTERNAL_SECRET)).status, 401);
  });

  await t.test('the header secret is compared in constant time', async (tt) => {
    process.env.HTTP_HEADER_AUTH_SECRET = HEADER_SECRET;
    const calls = [];
    const original = crypto.timingSafeEqual;
    crypto.timingSafeEqual = function (a, b) {
      calls.push([Buffer.from(a).toString(), Buffer.from(b).toString()]);
      return original.call(this, a, b);
    };
    tt.after(() => { crypto.timingSafeEqual = original; });

    const res = await asProxiedUser(HEADER_SECRET);
    assert.equal(res.status, 200, 'the proxy identity with the right secret is accepted');
    assert.ok(
      calls.some(([a, b]) => a === HEADER_SECRET && b === HEADER_SECRET),
      'the provided secret must be checked with crypto.timingSafeEqual'
    );
  });

  // The shard proxy appends the real peer; the client controls everything before it.
  const viaProxy = (spoofed, real) => ({ 'X-Forwarded-For': `${spoofed}, ${real}` });

  await t.test('auth routes answer 429 per client IP; spoofed X-Forwarded-For entries do not help', async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) {
      const res = await fetch(`${origin}/api/auth/login`, { headers: viaProxy(`10.9.${i >> 8}.${i & 255}`, '198.51.100.7'), redirect: 'manual' });
      assert.notEqual(res.status, 429, `request ${i + 1} is within the budget`);
    }
    const limited = await fetch(`${origin}/api/auth/login`, { headers: viaProxy('10.200.0.1', '198.51.100.7'), redirect: 'manual' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After must be set');

    const other = await fetch(`${origin}/api/auth/login`, { headers: viaProxy('10.200.0.1', '198.51.100.8'), redirect: 'manual' });
    assert.notEqual(other.status, 429, 'another client IP has its own budget');
  });

  await t.test('public routes answer 429 per client IP across different share tokens', async () => {
    for (let i = 0; i < PUBLIC_RATE_LIMIT.max; i++) {
      const res = await fetch(`${origin}/api/public/calendars/share/unknown-${i}.ics`, { headers: viaProxy('10.0.0.1', '203.0.113.9') });
      assert.notEqual(res.status, 429, `request ${i + 1} is within the budget`);
    }
    const limited = await fetch(`${origin}/api/public/calendars/share/unknown-last.ics`, { headers: viaProxy('10.0.0.2', '203.0.113.9') });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After must be set');

    const other = await fetch(`${origin}/api/public/calendars/share/unknown-last.ics`, { headers: viaProxy('10.0.0.2', '203.0.113.10') });
    assert.notEqual(other.status, 429, 'another client IP has its own budget');
  });
});
