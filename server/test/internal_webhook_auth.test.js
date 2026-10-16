'use strict';

/**
 * Issue #59 — HIGH: /internal/webhooks/user-deleted trusts req.ip with trust-proxy on
 *
 * When trust proxy is enabled (production/shard), req.ip reflects X-Forwarded-For,
 * which is attacker-controlled. A caller behind any loopback proxy can inject
 * X-Forwarded-For: 127.0.0.1 and bypass the IP-based guard in requireInternal.
 *
 * Fix: extract requireInternal logic into server/utils/internalAuth.js as
 *      createRequireInternalMiddleware(env), which:
 *      1. When INTERNAL_WEBHOOK_SECRET is set: requires exact header match, IP ignored.
 *      2. When INTERNAL_WEBHOOK_SECRET is NOT set: 403 Forbidden for every caller,
 *         loopback included, whatever TRUST_PROXY says (no IP allow-list).
 */

// That server/index.js guards its internal routes with this middleware is probed against the
// real app in issue59_internal_webhook_proxy_bypass.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

// ── Test 1: spoofed loopback IP blocked when secret is configured ───────────────

test('createRequireInternalMiddleware blocks spoofed 127.0.0.1 when secret is configured', async () => {
  const { createRequireInternalMiddleware } = require(path.join(ROOT, 'server/utils/internalAuth'));

  const middleware = createRequireInternalMiddleware({
    INTERNAL_WEBHOOK_SECRET: 'test-secret-abc123',
    NODE_ENV: 'production',
    TRUST_PROXY: 'true'
  });

  let statusCode;
  await new Promise((resolve) => {
    const mockReq = {
      ip: '127.0.0.1', // spoofed via X-Forwarded-For
      connection: { remoteAddress: '10.0.0.5' },
      headers: {} // no secret
    };
    const mockRes = {
      status(code) { statusCode = code; return this; },
      json() { resolve(); return this; }
    };
    middleware(mockReq, mockRes, () => { statusCode = 200; resolve(); });
  });

  assert.strictEqual(statusCode, 403, 'Spoofed loopback IP with no secret must be blocked (403)');
});

// ── Test 2: correct secret header grants access ──────────────────────────────────

test('createRequireInternalMiddleware allows request with correct secret header', async () => {
  const { createRequireInternalMiddleware } = require(path.join(ROOT, 'server/utils/internalAuth'));

  const middleware = createRequireInternalMiddleware({
    INTERNAL_WEBHOOK_SECRET: 'test-secret-abc123',
    NODE_ENV: 'production',
    TRUST_PROXY: 'true'
  });

  let statusCode;
  await new Promise((resolve) => {
    const mockReq = {
      ip: '10.0.0.5',
      connection: { remoteAddress: '10.0.0.5' },
      headers: { 'x-freeshard-secret': 'test-secret-abc123' }
    };
    const mockRes = {
      status(code) { statusCode = code; return this; },
      json() { resolve(); return this; }
    };
    middleware(mockReq, mockRes, () => { statusCode = 200; resolve(); });
  });

  assert.strictEqual(statusCode, 200, 'Correct secret must allow access (200)');
});

// ── Test 3: wrong secret is blocked ─────────────────────────────────────────────

test('createRequireInternalMiddleware blocks wrong secret header', async () => {
  const { createRequireInternalMiddleware } = require(path.join(ROOT, 'server/utils/internalAuth'));

  const middleware = createRequireInternalMiddleware({
    INTERNAL_WEBHOOK_SECRET: 'test-secret-abc123',
    NODE_ENV: 'production',
    TRUST_PROXY: 'true'
  });

  let statusCode;
  await new Promise((resolve) => {
    const mockReq = {
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
      headers: { 'x-freeshard-secret': 'wrong-secret' }
    };
    const mockRes = {
      status(code) { statusCode = code; return this; },
      json() { resolve(); return this; }
    };
    middleware(mockReq, mockRes, () => { statusCode = 200; resolve(); });
  });

  assert.strictEqual(statusCode, 403, 'Wrong secret must be blocked (403)');
});

// ── Test 4: no secret + trust proxy off + true loopback → still blocked ─────────

test('createRequireInternalMiddleware blocks true loopback when no secret configured and trust proxy off', async () => {
  const { createRequireInternalMiddleware } = require(path.join(ROOT, 'server/utils/internalAuth'));

  const middleware = createRequireInternalMiddleware({
    NODE_ENV: 'production',
    TRUST_PROXY: 'false'
    // No INTERNAL_WEBHOOK_SECRET
  });

  let statusCode;
  await new Promise((resolve) => {
    const mockReq = {
      ip: '127.0.0.1', // Real socket address when trust proxy is off
      connection: { remoteAddress: '127.0.0.1' },
      headers: {}
    };
    const mockRes = {
      status(code) { statusCode = code; return this; },
      json() { resolve(); return this; }
    };
    middleware(mockReq, mockRes, () => { statusCode = 200; resolve(); });
  });

  assert.strictEqual(statusCode, 403, 'Loopback without a configured secret must be blocked (403)');
});

// ── Test 5: no secret + trust proxy on → all non-test requests blocked ───────────

test('createRequireInternalMiddleware blocks all requests when no secret and trust proxy on', async () => {
  const { createRequireInternalMiddleware } = require(path.join(ROOT, 'server/utils/internalAuth'));

  const middleware = createRequireInternalMiddleware({
    NODE_ENV: 'production',
    TRUST_PROXY: 'true'
    // No INTERNAL_WEBHOOK_SECRET — unsafe config
  });

  let statusCode;
  await new Promise((resolve) => {
    const mockReq = {
      ip: '127.0.0.1', // spoofable
      connection: { remoteAddress: '10.0.0.5' },
      headers: {}
    };
    const mockRes = {
      status(code) { statusCode = code; return this; },
      json() { resolve(); return this; }
    };
    middleware(mockReq, mockRes, () => { statusCode = 200; resolve(); });
  });

  assert.strictEqual(statusCode, 403, 'No secret + trust proxy on must block all external callers (403)');
});
