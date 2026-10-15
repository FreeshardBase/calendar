'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3134';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, server } = require('../index');

describe('Issue #164 — SPA catch-all does not answer unmatched /api paths with HTML', () => {
  after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;

  test('GET unmatched /api path returns 404 JSON, not 200 HTML index page', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent-route-12345`);
    assert.strictEqual(res.status, 404, `Expected status 404, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json content-type, got ${contentType}`);

    const data = await res.json();
    assert.ok(data && typeof data === 'object');
    assert.strictEqual(data.error, 'Not Found');
  });

  test('POST unmatched /api path returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/some/unknown/nested/endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.strictEqual(res.status, 404, `Expected status 404, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json content-type, got ${contentType}`);

    const data = await res.json();
    assert.strictEqual(data.error, 'Not Found');
  });

  // express.static percent-decodes the path, so these resolve into public/ and would be answered with
  // index.html (301 to a trailing slash, then 200 text/html) before any /api router sees them.
  for (const apiPath of [
    '/api/nope/..%2F..',
    '/api/nope/..%2F../',
    '/API/nope/..%2F..',
    '/./api/nope/..%2F..',
    '//api/nonexistent',
  ]) {
    test(`GET ${apiPath} returns 404 JSON, not the SPA page`, async () => {
      const res = await fetch(`${baseUrl}${apiPath}`, { redirect: 'manual' });
      assert.strictEqual(res.status, 404, `Expected status 404, got ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      assert.ok(contentType.includes('application/json'), `Expected application/json content-type, got ${contentType}`);
      assert.strictEqual((await res.json()).error, 'Not Found');
    });
  }

  test('GET /api/resources/..%2F.. (built by ResourcesAPI.get("../..")) is not answered with the SPA page', async () => {
    const res = await fetch(`${baseUrl}/api/resources/..%2F..`, { redirect: 'manual' });
    assert.ok(res.status >= 400, `Expected an error status, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('application/json'), `Expected application/json content-type, got ${contentType}`);
  });

  test('static assets are still served', async () => {
    const res = await fetch(`${baseUrl}/js/api.js`);
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('javascript'));
  });

  test('GET non-api route still returns 200 HTML page from SPA catch-all', async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.strictEqual(res.status, 200, `Expected status 200 for SPA route, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('text/html'), `Expected text/html content-type for SPA route, got ${contentType}`);

    const body = await res.text();
    assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'Response should be index.html page');
  });
});
