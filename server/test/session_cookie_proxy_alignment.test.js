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
 *   6. The booted production server applies both settings to its session cookie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getTrustProxySetting, getSessionConfig } = require('../utils/sessionConfig');
const { bootProductionServer, TERMINAL } = require('./helpers/productionServer');

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
    assert.strictEqual(devConfig.cookie.sameSite, 'lax');
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

  // The booted production server applies getTrustProxySetting() and getSessionConfig(): the
  // cookie is HttpOnly and SameSite=Lax (#491), and 'auto' Secure follows the proxy's
  // X-Forwarded-Proto only when the proxy hop is trusted.
  async function sessionCookie(base, headers) {
    const res = await fetch(`${base}/api/auth/session`, { headers: { ...TERMINAL, ...headers } });
    assert.equal(res.status, 200);
    const [cookie] = res.headers.getSetCookie();
    assert.ok(cookie, 'the session handshake sets a cookie');
    return cookie;
  }

  test('production server issues an HttpOnly, SameSite=Lax cookie, Secure behind the trusted https proxy', async (t) => {
    const { base } = await bootProductionServer(t, { TRUST_PROXY: undefined });
    const proxied = await sessionCookie(base, { 'X-Forwarded-Proto': 'https' });
    assert.match(proxied, /;\s*HttpOnly/i);
    assert.match(proxied, /;\s*SameSite=Lax/i);
    assert.match(proxied, /;\s*Secure/i, 'one trusted hop by default: the https proxy makes the cookie Secure');

    const plain = await sessionCookie(base, {});
    assert.doesNotMatch(plain, /;\s*Secure/i, 'a cookie issued over plain http is not Secure');
  });

  test('production server honours TRUST_PROXY=false and COOKIE_SAME_SITE', async (t) => {
    const { base } = await bootProductionServer(t, { TRUST_PROXY: 'false', COOKIE_SAME_SITE: 'strict' });
    const cookie = await sessionCookie(base, { 'X-Forwarded-Proto': 'https' });
    assert.doesNotMatch(cookie, /;\s*Secure/i, 'an untrusted X-Forwarded-Proto must not make the cookie Secure');
    assert.match(cookie, /;\s*SameSite=Strict/i);
  });

});
