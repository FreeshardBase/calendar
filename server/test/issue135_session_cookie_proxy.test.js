'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #135 — TLS Proxy Session Cookie Issuance
 * Issue #205 — Internal Webhook Guard Trust Proxy Alignment
 *
 * Validates session cookie issuance behind TLS-terminating proxies and alignment
 * with the internal webhook authentication middleware:
 *   1. Express session behind a TLS proxy issuing X-Forwarded-Proto: https sets
 *      Set-Cookie with HttpOnly, Secure, and SameSite=Lax attributes.
 *   2. createRequireInternalMiddleware utilizes getTrustProxySetting(env) to detect
 *      when trust proxy is active (e.g. NODE_ENV=production), preventing X-Forwarded-For
 *      spoofing on internal webhooks when INTERNAL_WEBHOOK_SECRET is unconfigured.
 *   3. Secret-based authentication for internal webhooks functions as expected.
 *   4. Direct loopback socket access is refused without a secret, even in development
 *      mode with trust proxy off (issue #59: no IP allow-list).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { getTrustProxySetting, getSessionConfig } = require('../utils/sessionConfig');
const { createRequireInternalMiddleware } = require('../utils/internalAuth');

test.describe('Issue #135 & Issue #205 — TLS Proxy Session Cookie & Internal Auth Alignment', () => {

  test('Session cookie is issued with HttpOnly, Secure, and SameSite=Lax behind TLS proxy', async () => {
    const env = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'secure-prod-test-secret-123456789'
    };

    const app = express();
    app.set('trust proxy', getTrustProxySetting(env));
    app.use(session(getSessionConfig(env)));

    app.get('/api/session-test', (req, res) => {
      req.session.userId = 'test-user-123';
      res.json({ ok: true, userId: req.session.userId });
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session-test`, {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '203.0.113.195'
        }
      });

      assert.strictEqual(response.status, 200);
      const setCookie = response.headers.get('set-cookie');
      assert.ok(setCookie, 'Set-Cookie header must be issued on session write');
      assert.ok(setCookie.includes('connect.sid='), 'Set-Cookie must contain connect.sid');
      assert.ok(setCookie.includes('HttpOnly'), 'Set-Cookie must include HttpOnly flag');
      assert.ok(setCookie.includes('Secure'), 'Set-Cookie must include Secure flag when X-Forwarded-Proto is https');
      assert.ok(setCookie.includes('SameSite=Strict') || setCookie.includes('SameSite=strict') || setCookie.includes('SameSite=Lax') || setCookie.includes('SameSite=lax'), 'Set-Cookie must set SameSite attribute');
    } finally {
      server.close();
    }
  });

  test('createRequireInternalMiddleware blocks X-Forwarded-For loopback spoofing in production without secret', async () => {
    const env = { NODE_ENV: 'production' };

    const app = express();
    app.set('trust proxy', getTrustProxySetting(env));
    app.post(
      '/internal/webhooks/user-deleted',
      createRequireInternalMiddleware(env),
      (req, res) => res.json({ success: true })
    );

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
        method: 'POST',
        headers: {
          'X-Forwarded-For': '127.0.0.1'
        }
      });

      assert.strictEqual(response.status, 403, 'Must reject spoofed X-Forwarded-For loopback requests with 403');
      const data = await response.json();
      assert.ok(data.error.includes('INTERNAL_WEBHOOK_SECRET'), 'Error message must name the missing INTERNAL_WEBHOOK_SECRET');
    } finally {
      server.close();
    }
  });

  test('createRequireInternalMiddleware validates x-freeshard-secret header when configured', async () => {
    const env = {
      NODE_ENV: 'production',
      INTERNAL_WEBHOOK_SECRET: 'my-super-secret-token-123'
    };

    const app = express();
    app.set('trust proxy', getTrustProxySetting(env));
    app.post(
      '/internal/webhooks/user-deleted',
      createRequireInternalMiddleware(env),
      (req, res) => res.json({ success: true })
    );

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Invalid secret
      const resBad = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
        method: 'POST',
        headers: { 'x-freeshard-secret': 'wrong-secret' }
      });
      assert.strictEqual(resBad.status, 403);

      // Valid secret
      const resGood = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
        method: 'POST',
        headers: { 'x-freeshard-secret': 'my-super-secret-token-123' }
      });
      assert.strictEqual(resGood.status, 200);
      const data = await resGood.json();
      assert.strictEqual(data.success, true);
    } finally {
      server.close();
    }
  });

  test('createRequireInternalMiddleware refuses loopback without secret in development mode when trust proxy is off', async () => {
    const env = { NODE_ENV: 'development' };

    const app = express();
    app.set('trust proxy', getTrustProxySetting(env)); // false
    app.post(
      '/internal/webhooks/user-deleted',
      createRequireInternalMiddleware(env),
      (req, res) => res.json({ success: true })
    );

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/webhooks/user-deleted`, {
        method: 'POST'
      });

      assert.strictEqual(response.status, 403, 'Direct socket loopback without a secret must be refused');
    } finally {
      server.close();
    }
  });

});
