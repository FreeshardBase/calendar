'use strict';
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

  test('GET non-api route still returns 200 HTML page from SPA catch-all', async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.strictEqual(res.status, 200, `Expected status 200 for SPA route, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('text/html'), `Expected text/html content-type for SPA route, got ${contentType}`);

    const body = await res.text();
    assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'Response should be index.html page');
  });
});
