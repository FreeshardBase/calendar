'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #334 — POST /api/accounts must reject URLs and usernames that could inject
 * keys or sections into the sync-worker's vdirsyncer config: URL scheme must be
 * http/https and neither URL (submitted or discovered) nor username may contain
 * control characters.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http    = require('node:http');
const Db      = require('../db');
const accountsRouter = require('../routes/accounts');
const CalDAVClient   = require('../caldav/client');

const VALID_URL = 'https://caldav.example.com/dav/';
// #337: discovery is stubbed; skip the DNS check for the placeholder host.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'caldav.example.com';

function listen() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-334', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.userId = 'testuser-334';
    req.session.accounts = [];
    next();
  });
  app.use('/', accountsRouter);
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function post(server, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function stubBackend(t, discoveredUrl) {
  const added = [];
  const contacted = [];
  t.mock.method(CalDAVClient.prototype, 'discover', async function () {
    contacted.push(this.url ?? this.baseUrl ?? true);
    return discoveredUrl;
  });
  t.mock.method(CalDAVClient.prototype, 'testConnection', async () => {});
  t.mock.method(Db, 'findAccountByUrlAndUsername', async () => null);
  t.mock.method(Db, 'addAccount', async (userId, acc) => { added.push(acc); return { id: 'acc-334', displayName: 'x' }; });
  t.mock.method(Db, 'addSyncJob', async () => ({ id: 'job-334' }));
  return { added, contacted };
}

test('#334 valid http(s) account is still accepted', async (t) => {
  const { added } = stubBackend(t, VALID_URL);
  const srv = await listen();
  t.after(() => srv.close());
  const res = await post(srv, { url: VALID_URL, username: 'testuser@example.com', password: 'pa"ss\\word' });
  assert.equal(res.status, 201);
  assert.equal(added.length, 1);
});

for (const [name, body] of [
  ['username with quote + newline section injection',
    { url: VALID_URL, username: 'testuser"\n[storage evil]\nurl = "https://evil.example.com/', password: 'secret' }],
  ['username with carriage return', { url: VALID_URL, username: 'testuser\rverify = false', password: 'secret' }],
  ['url with newline', { url: 'https://caldav.example.com/"\nverify = false', username: 'testuser', password: 'secret' }],
  ['url with non-http scheme', { url: 'file:///etc/passwd', username: 'testuser', password: 'secret' }],
  ['non-string username', { url: VALID_URL, username: ['testuser'], password: 'secret' }],
]) {
  test(`#334 rejects ${name} before contacting the server or storing anything`, async (t) => {
    const { added, contacted } = stubBackend(t, VALID_URL);
    const srv = await listen();
    t.after(() => srv.close());
    const res = await post(srv, body);
    assert.equal(res.status, 400);
    assert.equal(contacted.length, 0);
    assert.equal(added.length, 0);
  });
}

test('#334 rejects a discovered URL containing control characters', async (t) => {
  const { added } = stubBackend(t, 'https://caldav.example.com/dav/"\n[storage evil]\n');
  const srv = await listen();
  t.after(() => srv.close());
  const res = await post(srv, { url: VALID_URL, username: 'testuser', password: 'secret' });
  assert.equal(res.status, 400);
  assert.equal(added.length, 0);
});
