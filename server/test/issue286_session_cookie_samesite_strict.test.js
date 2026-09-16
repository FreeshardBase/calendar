'use strict';

/**
 * Issue #286 — HIGH: session cookie declares SameSite=Strict by default to prevent
 * cross-site POST requests from riding the session cookie inside Chromium's 2-minute Lax grace window (AUTH_METHOD=oidc).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const { getSessionConfig } = require('../utils/sessionConfig');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #286 — Session Cookie SameSite=Strict Default Guard', () => {

  test('getSessionConfig defaults cookie.sameSite to strict when COOKIE_SAME_SITE is unset', () => {
    const config = getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(
      config.cookie.sameSite,
      'strict',
      'Session cookie sameSite must default to "strict" to block cross-site POST requests during Chromium 2-min Lax grace window'
    );
  });

  test('getSessionConfig respects explicit COOKIE_SAME_SITE environment setting', () => {
    const laxConfig = getSessionConfig({ NODE_ENV: 'production', COOKIE_SAME_SITE: 'lax', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(laxConfig.cookie.sameSite, 'lax');

    const strictConfig = getSessionConfig({ NODE_ENV: 'production', COOKIE_SAME_SITE: 'strict', SESSION_SECRET: 'valid-secure-production-secret-12345' });
    assert.strictEqual(strictConfig.cookie.sameSite, 'strict');
  });

  test('Express session middleware emits SameSite=Strict in Set-Cookie header by default', async () => {
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
      assert.match(setCookie, /SameSite=Strict/i, 'Set-Cookie header must specify SameSite=Strict');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('docker-compose.yml configures COOKIE_SAME_SITE to strict', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');
    assert.match(
      content,
      /COOKIE_SAME_SITE:\s*"strict"/,
      'docker-compose.yml must set COOKIE_SAME_SITE to "strict"'
    );
  });

  test('.env.example documents COOKIE_SAME_SITE=strict default', () => {
    const envExamplePath = path.join(ROOT_DIR, '.env.example');
    const content = fs.readFileSync(envExamplePath, 'utf8');
    assert.match(
      content,
      /COOKIE_SAME_SITE=strict/,
      '.env.example must document COOKIE_SAME_SITE=strict'
    );
  });

});
