'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3174';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

describe('Issue #173 — Response Compression for JS, CSS, HTML and API responses', () => {
  before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT, resolve));
    }
  });

  after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;

  test('GET /js/app.js with Accept-Encoding: gzip returns gzip encoded response', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/js/app.js`, {
        headers: { 'Accept-Encoding': 'gzip' }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip');
    assert.match(res.headers['vary'] || '', /Accept-Encoding/i);

    // Verify payload decompresses cleanly to valid JS code
    const decompressed = zlib.gunzipSync(res.body).toString('utf8');
    assert.match(decompressed, /document\.addEventListener/);
  });

  test('GET /js/app.js without Accept-Encoding returns uncompressed response', async () => {
    const res = await fetch(`${baseUrl}/js/app.js`, {
      headers: { 'Accept-Encoding': 'identity' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-encoding'), null);
    const text = await res.text();
    assert.match(text, /document\.addEventListener/);
  });

  test('GET /api/accounts with Accept-Encoding: gzip returns compressed JSON', async () => {
    const cookie = await loginAs('test-compression-user');
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/api/accounts`, {
        headers: {
          'Accept-Encoding': 'gzip',
          cookie
        }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip');
    assert.match(res.headers['vary'] || '', /Accept-Encoding/i);

    const decompressed = zlib.gunzipSync(res.body).toString('utf8');
    const json = JSON.parse(decompressed);
    assert.ok(Array.isArray(json));
  });

  test('304 Not Modified response is not compressed', async () => {
    const firstRes = await fetch(`${baseUrl}/js/app.js`);
    const etag = firstRes.headers.get('etag');

    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/js/app.js`, {
        headers: {
          'Accept-Encoding': 'gzip',
          'If-None-Match': etag
        }
      }, (res) => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers
        });
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.statusCode, 304);
    assert.strictEqual(res.headers['content-encoding'], undefined);
  });
});
