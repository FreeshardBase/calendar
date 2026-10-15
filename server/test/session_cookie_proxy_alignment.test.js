'use strict';

/**
 * Issue #263 — Session Cookie & Proxy Production Container Alignment
 *
 * Validates session cookie, Express trust proxy, and production container security alignment:
 *   1. Express trust proxy config respects TRUST_PROXY env var and defaults to one hop in production (#340).
 *   2. Session cookie uses httpOnly: true, configurable sameSite, and secure setting ('auto' or boolean).
 *   3. Production guard throws error when SESSION_SECRET is missing or default fallback in production.
 *   4. docker-compose.yml configures TRUST_PROXY, COOKIE_SECURE, COOKIE_SAME_SITE, and SESSION_SECRET for webcalendar.
 *   5. .env.example documents TRUST_PROXY, COOKIE_SECURE, and COOKIE_SAME_SITE.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getTrustProxySetting, getSessionConfig } = require('../utils/sessionConfig');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #263 — Session Cookie & Proxy Production Container Alignment', () => {

  test('getTrustProxySetting evaluates environment correctly', () => {
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: 'true' }), true);
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: '1' }), 1);
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: 'false' }), false);
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: '0' }), false);
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: '2' }), 2);
    assert.strictEqual(getTrustProxySetting({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }), 'loopback, 10.0.0.0/8');

    // Default behavior when TRUST_PROXY is omitted: one hop, the shard's reverse proxy (#340)
    assert.strictEqual(getTrustProxySetting({ NODE_ENV: 'production' }), 1);
    assert.strictEqual(getTrustProxySetting({ NODE_ENV: 'staging' }), 1);
    assert.strictEqual(getTrustProxySetting({ NODE_ENV: 'development' }), false);
  });

  test('getSessionConfig sets cookie options and enforces production SESSION_SECRET guard', () => {
    // Development default
    const devConfig = getSessionConfig({ NODE_ENV: 'development' });
    assert.strictEqual(devConfig.cookie.httpOnly, true);
    assert.strictEqual(devConfig.cookie.sameSite, 'strict');
    assert.strictEqual(devConfig.cookie.secure, false);
    assert.strictEqual(devConfig.secret, 'freeshard-change-this-in-production');

    // Explicit COOKIE_SECURE & COOKIE_SAME_SITE settings
    const customConfig = getSessionConfig({
      NODE_ENV: 'development',
      COOKIE_SECURE: 'auto',
      COOKIE_SAME_SITE: 'strict',
      SESSION_SECRET: 'custom-dev-secret'
    });
    assert.strictEqual(customConfig.cookie.secure, 'auto');
    assert.strictEqual(customConfig.cookie.sameSite, 'strict');
    assert.strictEqual(customConfig.secret, 'custom-dev-secret');

    // Production success with secure custom SESSION_SECRET
    const prodConfig = getSessionConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'secure-random-prod-secret-12345'
    });
    assert.strictEqual(prodConfig.cookie.secure, 'auto');
    assert.strictEqual(prodConfig.cookie.httpOnly, true);
    assert.strictEqual(prodConfig.secret, 'secure-random-prod-secret-12345');

    // Production guard failure when default or empty SESSION_SECRET is used
    assert.throws(
      () => getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'freeshard-change-this-in-production' }),
      /SESSION_SECRET must be explicitly configured/
    );
    assert.throws(
      () => getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'change-me' }),
      /SESSION_SECRET must be explicitly configured/
    );
    assert.throws(
      () => getSessionConfig({ NODE_ENV: 'production' }),
      /SESSION_SECRET must be explicitly configured/
    );
  });

  test('docker-compose.yml configures TRUST_PROXY, COOKIE_SECURE, COOKIE_SAME_SITE, and SESSION_SECRET', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    assert.ok(content.includes('TRUST_PROXY:'), 'docker-compose.yml must declare TRUST_PROXY');
    assert.ok(content.includes('COOKIE_SECURE:'), 'docker-compose.yml must declare COOKIE_SECURE');
    assert.ok(content.includes('COOKIE_SAME_SITE:'), 'docker-compose.yml must declare COOKIE_SAME_SITE');
    assert.ok(content.includes('SESSION_SECRET:'), 'docker-compose.yml must declare SESSION_SECRET');
  });

  test('.env.example documents proxy and cookie environment variables', () => {
    const envExamplePath = path.join(ROOT_DIR, '.env.example');
    assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
    const content = fs.readFileSync(envExamplePath, 'utf8');

    assert.ok(content.includes('TRUST_PROXY'), '.env.example must document TRUST_PROXY');
    assert.ok(content.includes('COOKIE_SECURE'), '.env.example must document COOKIE_SECURE');
    assert.ok(content.includes('COOKIE_SAME_SITE'), '.env.example must document COOKIE_SAME_SITE');
  });

  test('server/index.js correctly imports and applies sessionConfig', () => {
    const indexContent = fs.readFileSync(path.join(ROOT_DIR, 'server/index.js'), 'utf8');

    assert.ok(indexContent.includes("require('./utils/sessionConfig')"), 'server/index.js must import sessionConfig');
    assert.ok(indexContent.includes('getTrustProxySetting()'), 'server/index.js must invoke getTrustProxySetting()');
    assert.ok(indexContent.includes('getSessionConfig()'), 'server/index.js must invoke getSessionConfig()');
  });

});
