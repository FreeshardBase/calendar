'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3196';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const securityHeaders = require('../utils/securityHeaders');
const { server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Issue #116 — Security Headers & Content Security Policy (CSP)', async (t) => {
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3196, resolve));
  }

  t.after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      if (server.close) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (server.unref) {
        server.unref();
      }
    }
  });

  await t.test('server/utils/securityHeaders.js exists', () => {
    const filePath = path.join(__dirname, '../utils/securityHeaders.js');
    assert.ok(fs.existsSync(filePath), 'server/utils/securityHeaders.js must exist');
  });

  await t.test('securityHeaders middleware sets CSP and security response headers', () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/test', (req, res) => res.send('ok'));

    const req = {};
    const headers = {};
    const res = {
      setHeader(name, val) {
        headers[name.toLowerCase()] = val;
      }
    };
    let nextCalled = false;
    securityHeaders(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true, 'securityHeaders middleware must call next()');
    assert.ok(headers['content-security-policy'], 'Content-Security-Policy header must be set');
    assert.ok(headers['content-security-policy'].includes("default-src 'self'"), "CSP must include default-src 'self'");
    assert.ok(headers['content-security-policy'].includes("frame-ancestors 'none'"), "CSP must include frame-ancestors 'none'");
    assert.strictEqual(headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options must be nosniff');
    assert.strictEqual(headers['x-frame-options'], 'DENY', 'X-Frame-Options must be DENY');
    assert.strictEqual(headers['x-xss-protection'], '1; mode=block', 'X-XSS-Protection must be 1; mode=block');
    assert.strictEqual(headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Referrer-Policy must be strict-origin-when-cross-origin');
    assert.ok(headers['strict-transport-security'], 'Strict-Transport-Security header must be set');
    assert.strictEqual(headers['x-permitted-cross-domain-policies'], 'none', 'X-Permitted-Cross-Domain-Policies must be set to none');
  });

  await t.test('HTTP response from webcalendar includes Content-Security-Policy header', async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'Content-Security-Policy header must be present on HTTP response');
    assert.ok(csp.includes("default-src 'self'"), "CSP must include default-src 'self'");
    assert.ok(csp.includes("frame-ancestors 'none'"), "CSP must include frame-ancestors 'none'");
  });

  await t.test('HTTP response from webcalendar includes standard security hardening headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options must be nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options must be DENY');
    assert.strictEqual(res.headers.get('x-xss-protection'), '1; mode=block', 'X-XSS-Protection must be 1; mode=block');
    assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy must be strict-origin-when-cross-origin');
    assert.ok(res.headers.get('strict-transport-security'), 'Strict-Transport-Security header must be present');
    assert.strictEqual(res.headers.get('x-permitted-cross-domain-policies'), 'none', 'X-Permitted-Cross-Domain-Policies must be none');
  });

  await t.test('API routes also set security headers', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      headers: { 'x-test-user-id': 'test-user-headers' }
    });
    assert.ok(res.headers.get('content-security-policy'), 'API route must include Content-Security-Policy');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', 'API route must include X-Content-Type-Options');
  });
});
