'use strict';

/**
 * Issue #59 — HIGH: /internal/webhooks/user-deleted trusts req.ip with trust-proxy on
 *
 * Reproduces @ClaydeCode review audit finding:
 * Under NODE_ENV=production with TRUST_PROXY=true and INTERNAL_WEBHOOK_SECRET unset,
 * Express derives req.ip from X-Forwarded-For. A remote attacker sending:
 *   X-Forwarded-For: 127.0.0.1
 * would bypass the legacy requireInternal IP allowlist and reach the route handlers.
 *
 * This test suite asserts that:
 * 1. Both internal routes (/internal/webhooks/user-deleted and /internal/db/quiesce)
 *    in server/index.js are protected by createRequireInternalMiddleware.
 * 2. Under production config without INTERNAL_WEBHOOK_SECRET, X-Forwarded-For loopback
 *    spoofing attempts are strictly rejected with HTTP 403.
 * 3. With INTERNAL_WEBHOOK_SECRET set, access is granted ONLY with matching secret header
 *    using constant-time comparison.
 * 4. Falsification: a vulnerable middleware implementation accepting spoofed loopback
 *    is proved to turn the suite red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

test('Issue #59: server/index.js wires createRequireInternalMiddleware and has no local requireInternal bypass', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');

  // Verify createRequireInternalMiddleware is imported and called
  assert.ok(
    indexSrc.includes("createRequireInternalMiddleware"),
    'server/index.js must import and reference createRequireInternalMiddleware'
  );
  assert.ok(
    /createRequireInternalMiddleware\s*\(/.test(indexSrc),
    'server/index.js must invoke createRequireInternalMiddleware()'
  );

  // Verify that the legacy vulnerable function requireInternal is NOT defined in server/index.js
  const hasLocalFn = /function\s+requireInternal\s*\(/.test(indexSrc);
  assert.strictEqual(
    hasLocalFn,
    false,
    'server/index.js must not define a local function requireInternal (must use createRequireInternalMiddleware)'
  );
});

test('Issue #59: safeCompare performs constant-time comparison on secrets', () => {
  const { safeCompare } = require(path.join(ROOT, 'server/utils/internalAuth'));
  assert.strictEqual(typeof safeCompare, 'function', 'internalAuth must export safeCompare');

  // Matching strings
  assert.strictEqual(safeCompare('super-secret-token-123', 'super-secret-token-123'), true);

  // Mismatched strings same length
  assert.strictEqual(safeCompare('super-secret-token-123', 'super-secret-token-456'), false);

  // Mismatched lengths
  assert.strictEqual(safeCompare('short', 'much-longer-string'), false);

  // Non-string or empty inputs
  assert.strictEqual(safeCompare('', ''), false);
  assert.strictEqual(safeCompare('abc', ''), false);
  assert.strictEqual(safeCompare('', 'abc'), false);
  assert.strictEqual(safeCompare(null, 'abc'), false);
  assert.strictEqual(safeCompare('abc', undefined), false);
  assert.strictEqual(safeCompare(123, 123), false);
});

test('Issue #59: Live probe against server/index.js app in production rejects spoofed X-Forwarded-For without secret', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'test-prod-session-secret-9876543210123456';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.TRUST_PROXY = 'true';
  process.env.PREVENT_AUTO_LISTEN = 'true';
  delete process.env.INTERNAL_WEBHOOK_SECRET;

  // Clear module cache to ensure clean load with production environment
  delete require.cache[require.resolve('../index.js')];
  const { app } = require('../index.js');
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  t.after(() => {
    server.close();
    process.env = origEnv;
    delete require.cache[require.resolve('../index.js')];
  });

  // Probe C: POST /internal/webhooks/user-deleted with X-Forwarded-For: 127.0.0.1 and NO secret
  const resWebhook = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '127.0.0.1'
    },
    body: JSON.stringify({ user_id: 'victim-user-123' })
  });

  assert.strictEqual(
    resWebhook.status,
    403,
    'POST /internal/webhooks/user-deleted with X-Forwarded-For: 127.0.0.1 must be rejected with 403 when secret unset'
  );
  const webhookBody = await resWebhook.json();
  assert.ok(
    webhookBody.error && webhookBody.error.includes('Set INTERNAL_WEBHOOK_SECRET'),
    'Error response must indicate INTERNAL_WEBHOOK_SECRET is required when trust proxy is enabled'
  );

  // Probe D: POST /internal/db/quiesce with X-Forwarded-For: 127.0.0.1 and NO secret
  const resQuiesce = await fetch(`http://127.0.0.1:${port}/internal/db/quiesce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '127.0.0.1'
    },
    body: JSON.stringify({ mode: 'TRUNCATE' })
  });

  assert.strictEqual(
    resQuiesce.status,
    403,
    'POST /internal/db/quiesce with X-Forwarded-For: 127.0.0.1 must be rejected with 403 when secret unset'
  );

  // Probe A/B: Direct socket connection without secret is also rejected under trust proxy
  const resDirect = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'victim-user-123' })
  });
  assert.strictEqual(resDirect.status, 403, 'Direct socket request without secret must be rejected with 403');
});

test('Issue #59: Live probe against server/index.js app with INTERNAL_WEBHOOK_SECRET configured', async (t) => {
  const secret = 'custom-configured-webhook-secret-xyz';
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'test-prod-session-secret-9876543210123456';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.TRUST_PROXY = 'true';
  process.env.PREVENT_AUTO_LISTEN = 'true';
  process.env.INTERNAL_WEBHOOK_SECRET = secret;

  delete require.cache[require.resolve('../index.js')];
  const { app } = require('../index.js');
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  t.after(() => {
    server.close();
    process.env = origEnv;
    delete require.cache[require.resolve('../index.js')];
  });

  // 1. Missing secret header -> 403
  const resNoSecret = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '127.0.0.1'
    },
    body: JSON.stringify({ user_id: 'victim-user-123' })
  });
  assert.strictEqual(resNoSecret.status, 403);

  // 2. Wrong secret header -> 403
  const resWrongSecret = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '127.0.0.1',
      'x-freeshard-secret': 'wrong-secret'
    },
    body: JSON.stringify({ user_id: 'victim-user-123' })
  });
  assert.strictEqual(resWrongSecret.status, 403);

  // 3. Correct secret via x-freeshard-secret -> passes guard
  // Empty body gives 400 ("user_id is required"), proving the auth guard passed to the handler
  const resValidFreeshard = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-freeshard-secret': secret
    },
    body: JSON.stringify({})
  });
  assert.strictEqual(resValidFreeshard.status, 400, 'Valid secret reaches handler and returns 400 for empty body');
  const dataFreeshard = await resValidFreeshard.json();
  assert.strictEqual(dataFreeshard.error, 'user_id is required');

  // 4. Correct secret via x-internal-secret -> passes guard
  const resValidInternal = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret
    },
    body: JSON.stringify({})
  });
  assert.strictEqual(resValidInternal.status, 400, 'Valid x-internal-secret reaches handler');

  // 5. Correct secret on /internal/db/quiesce -> passes guard and returns 200
  const resQuiesce = await fetch(`http://127.0.0.1:${port}/internal/db/quiesce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-freeshard-secret': secret
    },
    body: JSON.stringify({ mode: 'TRUNCATE' })
  });
  assert.strictEqual(resQuiesce.status, 200, 'Valid secret allows database quiesce');
});

test('Issue #59: Falsification - vulnerable requireInternal implementation allows spoofed XFF bypass', async () => {
  // Simulate the vulnerable 11b4e53 requireInternal function
  function vulnerableRequireInternal(req, res, next) {
    if (process.env.NODE_ENV === 'test') return next();
    const ip = req.ip || req.connection.remoteAddress;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const secret = req.headers['x-freeshard-secret'];
    const expectedSecret = process.env.INTERNAL_WEBHOOK_SECRET;

    if (expectedSecret) {
      if (secret === expectedSecret) return next();
      return res.status(403).json({ error: 'Access denied: Invalid webhook secret' });
    }

    if (isLocal) return next();

    return res.status(403).json({ error: 'Access denied: Internal only' });
  }

  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/internal/webhooks/user-deleted', vulnerableRequireInternal, (req, res) => {
    if (!req.body.user_id) return res.status(400).json({ error: 'user_id is required' });
    res.json({ message: 'Successfully deleted user ' + req.body.user_id });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '127.0.0.1'
      },
      body: JSON.stringify({ user_id: 'test' })
    });

    // Under the vulnerable logic, status is 200 (bypass succeeds)
    assert.strictEqual(res.status, 200, 'Vulnerable implementation must allow bypass (proving test falsification)');
  } finally {
    server.close();
  }
});
