'use strict';

/**
 * Issue #58 — HIGH: SESSION_SECRET falls back to a hardcoded literal
 *
 * Root cause: getSessionConfig() uses 'freeshard-change-this-in-production' as
 * the fallback secret in every environment that is NOT NODE_ENV=production.
 * Staging, development, and the unset-NODE_ENV shipping container all silently
 * accept the world-readable default, making every session cookie forgeable.
 *
 * Fix contract:
 *   1. NODE_ENV=production + missing/default secret → throws (existing behaviour).
 *   2. NODE_ENV=staging + missing/default secret    → throws (new).
 *   3. NODE_ENV=<other non-test> + missing/default  → emits console.error warning
 *      but does NOT throw, so a developer's cold start still works.
 *   4. NODE_ENV=test + missing secret              → no throw, no warning.
 *   5. Any env + explicit secure secret            → no throw, no warning.
 *   6. getSessionConfig() returns the configured secret value.
 *   7. Known hardcoded literals rejected in production/staging.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sessionConfigPath = path.join(__dirname, '../utils/sessionConfig.js');

function freshGetSessionConfig(env, options = {}) {
  delete require.cache[require.resolve(sessionConfigPath)];
  const { getSessionConfig } = require(sessionConfigPath);
  return getSessionConfig(env, options);
}

// ── Test 1: production + missing secret → throws ─────────────────────────────

test('#58 — production + no SESSION_SECRET throws', () => {
  assert.throws(
    () => freshGetSessionConfig({ NODE_ENV: 'production' }),
    /SESSION_SECRET must be explicitly configured/i
  );
});

// ── Test 2: production + default literal → throws ────────────────────────────

test('#58 — production + default literal throws', () => {
  assert.throws(
    () => freshGetSessionConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'freeshard-change-this-in-production'
    }),
    /SESSION_SECRET must be explicitly configured/i
  );
});

// ── Test 3: staging + no SESSION_SECRET → throws ─────────────────────────────

test('#58 — staging + no SESSION_SECRET throws', () => {
  assert.throws(
    () => freshGetSessionConfig({ NODE_ENV: 'staging' }),
    /SESSION_SECRET must be explicitly configured/i
  );
});

// ── Test 4: staging + default literal → throws ───────────────────────────────

test('#58 — staging + default literal throws', () => {
  assert.throws(
    () => freshGetSessionConfig({
      NODE_ENV: 'staging',
      SESSION_SECRET: 'freeshard-change-this-in-production'
    }),
    /SESSION_SECRET must be explicitly configured/i
  );
});

// ── Test 5: dev + no secret → warns, does not throw ─────────────────────────

test('#58 — dev NODE_ENV + no SESSION_SECRET emits warning but does not throw', () => {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = freshGetSessionConfig({ NODE_ENV: 'development' });
  } finally {
    console.error = origError;
  }
  assert.ok(warnings.some(w => /SESSION_SECRET/i.test(w)),
    'Expected a console.error warning about SESSION_SECRET in development');
  assert.ok(result && result.secret, 'getSessionConfig must still return a config object');
});

// ── Test 6: test env + no secret → no throw, no warning ─────────────────────

test('#58 — test env + no SESSION_SECRET is silent (test convenience path)', () => {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = freshGetSessionConfig({ NODE_ENV: 'test' });
  } finally {
    console.error = origError;
  }
  assert.ok(!warnings.some(w => /SESSION_SECRET/i.test(w)),
    'No SESSION_SECRET warning should fire in test environment');
  assert.ok(result && result.secret, 'getSessionConfig must return a config in test env');
});

// ── Test 7: any env + secure secret → no throw, no warning ──────────────────

test('#58 — explicit secure SESSION_SECRET produces no warning in production', () => {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = freshGetSessionConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-long-random-secret-that-is-clearly-not-the-default-abc123xyz'
    });
  } finally {
    console.error = origError;
  }
  assert.ok(!warnings.some(w => /SESSION_SECRET/i.test(w)),
    'No warning when a real secret is configured');
  assert.strictEqual(result.secret,
    'a-long-random-secret-that-is-clearly-not-the-default-abc123xyz');
});

// ── Test 8: returned config.secret reflects SESSION_SECRET env var ───────────

test('#58 — returned config.secret reflects SESSION_SECRET env var', () => {
  const cfg = freshGetSessionConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'my-test-secret-xyz'
  });
  assert.strictEqual(cfg.secret, 'my-test-secret-xyz');
});
