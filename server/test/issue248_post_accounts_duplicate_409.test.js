'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// #337: the mock CalDAV server stands in for a remote one — allow it explicitly.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

/**
 * Issue #248 — POST /api/accounts links the same CalDAV server twice,
 * returning 201 where the contract demands 409.
 *
 * Root cause: the duplicate check in routes/accounts.js reads
 * req.session.accounts (session cache populated at request start).
 * A second POST that arrives before the middleware re-reads the DB
 * — or any POST in a test context with no session accounts — bypasses
 * the guard entirely and calls Db.addAccount() a second time.
 *
 * Fix: replace the session cache check with a DB query
 * (Db.findAccountByUrlAndUsername) so the check is always authoritative,
 * regardless of session state. A UNIQUE(user_id, url, username) migration
 * is added as a DB-level backstop.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http    = require('node:http');
const Db      = require('../db');
const accountsRouter = require('../routes/accounts');
const CalDAVClient   = require('../caldav/client');

// ── helpers ──────────────────────────────────────────────────────────────────

function buildApp(userId, mockDavUrl) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-248', resave: false, saveUninitialized: false }));

  // Inject session with empty accounts (simulates stale/cold session cache)
  app.use((req, res, next) => {
    req.session.userId   = userId;
    req.session.accounts = [];   // ← deliberately empty — the bug vector
    next();
  });

  // Stub CalDAVClient so no real network calls happen
  app.use((req, res, next) => {
    req._mockDavUrl = mockDavUrl;
    next();
  });

  app.use('/', accountsRouter);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function post(server, path, body, headers = {}) {
  const addr    = server.address();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Mock CalDAV server ────────────────────────────────────────────────────────

function startMockDav() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // Respond to PROPFIND (discovery + testConnection)
      const body = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${req.url}</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/mock248/</d:href></d:current-user-principal>
        <c:calendar-home-set><d:href>/mock248/</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'text/xml' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Issue #248 — POST /api/accounts: first request returns 201', async (t) => {
  const mockDav = await startMockDav();
  const mockUrl = `http://127.0.0.1:${mockDav.address().port}/mock248/`;

  // Stub discover + testConnection on CalDAVClient prototype
  const origDiscover = CalDAVClient.prototype.discover;
  const origTest     = CalDAVClient.prototype.testConnection;
  CalDAVClient.prototype.discover        = async function () { return mockUrl; };
  CalDAVClient.prototype.testConnection  = async function () {};

  const userId = 'testuser-248a';
  await Db.upsertUser(userId, 'testuser@example.com');

  const app = buildApp(userId, mockUrl);
  const srv = await listen(app);

  t.after(async () => {
    srv.close();
    mockDav.close();
    CalDAVClient.prototype.discover       = origDiscover;
    CalDAVClient.prototype.testConnection = origTest;
    await Db.deleteUserAccounts(userId);
  });

  const { status, body } = await post(srv, '/', {
    url: mockUrl, username: 'testuser', password: 'secret'
  });

  assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.id,  'Response should contain account id');
});

test('Issue #248 — POST /api/accounts: second POST for same url+username returns 409', async (t) => {
  const mockDav = await startMockDav();
  const mockUrl = `http://127.0.0.1:${mockDav.address().port}/mock248/`;

  const origDiscover = CalDAVClient.prototype.discover;
  const origTest     = CalDAVClient.prototype.testConnection;
  CalDAVClient.prototype.discover        = async function () { return mockUrl; };
  CalDAVClient.prototype.testConnection  = async function () {};

  const userId = 'testuser-248b';
  await Db.upsertUser(userId, 'testuser@example.com');

  const app = buildApp(userId, mockUrl);
  const srv = await listen(app);

  t.after(async () => {
    srv.close();
    mockDav.close();
    CalDAVClient.prototype.discover       = origDiscover;
    CalDAVClient.prototype.testConnection = origTest;
    await Db.deleteUserAccounts(userId);
  });

  const payload = { url: mockUrl, username: 'testuser', password: 'secret' };

  const first  = await post(srv, '/', payload);
  assert.equal(first.status, 201, `First POST should be 201, got ${first.status}`);

  // Second POST — same (user_id, url, username) — must return 409 even though
  // req.session.accounts is empty (the old bug: returned 201 again).
  const second = await post(srv, '/', payload);
  assert.equal(second.status, 409, `Second POST should be 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.ok(second.body.error, 'Response body should contain error field');
});

test('Issue #248 — POST /api/accounts: different username on same server is allowed (201)', async (t) => {
  const mockDav = await startMockDav();
  const mockUrl = `http://127.0.0.1:${mockDav.address().port}/mock248/`;

  const origDiscover = CalDAVClient.prototype.discover;
  const origTest     = CalDAVClient.prototype.testConnection;
  CalDAVClient.prototype.discover        = async function () { return mockUrl; };
  CalDAVClient.prototype.testConnection  = async function () {};

  const userId = 'testuser-248c';
  await Db.upsertUser(userId, 'testuser@example.com');

  const app = buildApp(userId, mockUrl);
  const srv = await listen(app);

  t.after(async () => {
    srv.close();
    mockDav.close();
    CalDAVClient.prototype.discover       = origDiscover;
    CalDAVClient.prototype.testConnection = origTest;
    await Db.deleteUserAccounts(userId);
  });

  const first  = await post(srv, '/', { url: mockUrl, username: 'alice',   password: 'secret' });
  assert.equal(first.status, 201, `First POST (alice) should be 201`);

  const second = await post(srv, '/', { url: mockUrl, username: 'bob',     password: 'secret' });
  assert.equal(second.status, 201, `Second POST (bob, different user) should be 201`);
});

test('Issue #248 — Db.findAccountByUrlAndUsername returns existing row', async (t) => {
  const userId = 'testuser-248d';
  await Db.upsertUser(userId, 'testuser@example.com');

  const url      = 'http://caldav.example.com/248d/';
  const username = 'testuser';

  // Should not exist yet
  const before = await Db.findAccountByUrlAndUsername(userId, url, username);
  assert.equal(before, null, 'Should return null when no account exists');

  await Db.addAccount(userId, { url, username, password: 'pw', displayName: 'Test' });

  const after = await Db.findAccountByUrlAndUsername(userId, url, username);
  assert.ok(after,              'Should return the account row after insertion');
  assert.equal(after.url,      url);
  assert.equal(after.username, username);

  t.after(async () => { await Db.deleteUserAccounts(userId); });
});
