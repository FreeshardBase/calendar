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
 *      2. When INTERNAL_WEBHOOK_SECRET is NOT set and TRUST_PROXY is falsy: allows
 *         loopback-socket connections (dev/CI convenience path).
 *      3. All other cases: 403 Forbidden.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

// ── Test 1: internalAuth.js exists ───────────────────────────────────────────

test('server/utils/internalAuth.js must exist', () => {
  const filePath = path.join(ROOT, 'server/utils/internalAuth.js');
  assert.ok(fs.existsSync(filePath), 'server/utils/internalAuth.js must exist');
});

// ── Test 2: source-level — requireInternal references INTERNAL_WEBHOOK_SECRET ─

test('server/index.js requireInternal must reference INTERNAL_WEBHOOK_SECRET', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(
    src.includes('INTERNAL_WEBHOOK_SECRET') || src.includes('internalAuth'),
    'server/index.js must use INTERNAL_WEBHOOK_SECRET or import internalAuth'
  );
});

// ── Test 3: source-level — no IP-only short-circuit in requireInternal ─────────

test('requireInternal must not short-circuit via IP alone when secret is configured', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');

  const fnStart = src.indexOf('function requireInternal');
  // If requireInternal is in index.js, check it; otherwise check internalAuth
  if (fnStart === -1) {
    // Logic delegated to internalAuth.js — acceptable
    const authSrc = fs.readFileSync(path.join(ROOT, 'server/utils/internalAuth.js'), 'utf8');
    // Must not have: if (isLocal || ... secret ...) return next()  [IP-first short-circuit]
    const hasIpShortCircuit = /if\s*\(\s*isLocal\s*\|\|/.test(authSrc);
    assert.ok(
      !hasIpShortCircuit,
      'createRequireInternalMiddleware must not short-circuit via IP-only (isLocal ||)'
    );
    return;
  }

  let depth = 0, fnEnd = fnStart, started = false;
  for (let i = fnStart; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    if (src[i] === '}') { depth--; }
    if (started && depth === 0) { fnEnd = i; break; }
  }
  const fnBody = src.slice(fnStart, fnEnd + 1);
  const hasIpShortCircuit = /if\s*\(\s*isLocal\s*\|\|/.test(fnBody);
  assert.ok(
    !hasIpShortCircuit,
    'requireInternal must not short-circuit via IP-only (isLocal ||)'
  );
});

// ── Test 4: spoofed loopback IP blocked when secret is configured ───────────────

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

// ── Test 5: correct secret header grants access ──────────────────────────────────

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

// ── Test 6: wrong secret is blocked ─────────────────────────────────────────────

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

// ── Test 7: fallback — no secret + trust proxy off + true loopback ──────────────

test('createRequireInternalMiddleware allows true loopback when no secret configured and trust proxy off', async () => {
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

  assert.strictEqual(statusCode, 200, 'True loopback with no secret configured must pass (200)');
});

// ── Test 8: no secret + trust proxy on → all non-test requests blocked ───────────

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
