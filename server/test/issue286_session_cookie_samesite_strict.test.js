'use strict';

/**
 * Issue #286 — the session cookie always declares its SameSite attribute. Chromium's 2-minute
 * Lax+POST grace window applies only to cookies without one, so a declared SameSite=Lax never
 * rides a cross-site POST. Since #491 the default is Lax (the OAuth/OIDC return is a cross-site
 * top-level GET); CSRF protection for state-changing requests is the origin check (#340).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const { getSessionConfig } = require('../utils/sessionConfig');

test.describe('Issue #286 — Session Cookie declares SameSite', () => {

  test('getSessionConfig defaults cookie.sameSite to lax when COOKIE_SAME_SITE is unset', () => {
    const config = getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(config.cookie.sameSite, 'lax');
  });

  test('getSessionConfig respects explicit COOKIE_SAME_SITE environment setting', () => {
    const laxConfig = getSessionConfig({ NODE_ENV: 'production', COOKIE_SAME_SITE: 'lax', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(laxConfig.cookie.sameSite, 'lax');

    const strictConfig = getSessionConfig({ NODE_ENV: 'production', COOKIE_SAME_SITE: 'strict', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(strictConfig.cookie.sameSite, 'strict');
  });

  test('Express session middleware emits an explicit SameSite=Lax in Set-Cookie header by default', async () => {
    const app = express();
    app.use(session(getSessionConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret-1234567890' })));
    app.get('/test-session', (req, res) => {
      req.session.userId = 'test-user-oidc';
      res.send('ok');
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-session`);
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie, 'Set-Cookie header must be present');
      assert.match(setCookie, /;\s*SameSite=Lax/i, 'Set-Cookie header must declare SameSite=Lax');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

});
