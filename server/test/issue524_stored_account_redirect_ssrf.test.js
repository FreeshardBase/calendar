'use strict';
// Issue #524 — live CalDAV requests for a stored (member-linked) account must not
// reach the internal network: a redirect from the linked server to a loopback /
// private address is refused and nothing is fetched there, and a stored URL that
// now points at a private address (e.g. after a DNS change) is refused as well.
// The operator's internal Radicale account stays the only exception.
// Production semantics; the linked server is "public" through OUTBOUND_FETCH_ALLOW_HOSTS.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue524-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue524.db');
process.env.ENCRYPTION_KEY = 'issue524-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
delete process.env.CALDAVURL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

const USER = 'testuser';
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nEND:VCALENDAR\r\n';
const SECRET = 'INTERNAL-ONLY-SECRET-BODY';

function listen(server, host) {
  return new Promise(resolve => server.listen(0, host, () => resolve(server)));
}

// Stands for shard_core / Radicale / metadata on the shard network.
const internal = { requests: [], server: null };
// The member-controlled server: passes discovery, later redirects every request.
const linked = { requests: [], server: null };
let appServer;
let base;

test.before(async () => {
  internal.server = http.createServer((req, res) => {
    internal.requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(req.method === 'GET' ? `${ICS}X-LEAK:${SECRET}\r\n` : ICS);
  });
  await listen(internal.server, '127.0.0.1');

  linked.server = http.createServer((req, res) => {
    linked.requests.push({ method: req.method, url: req.url });
    res.writeHead(302, { Location: `http://127.0.0.1:${internal.server.address().port}/x` });
    res.end();
  });
  // No host: dual-stack, so "localhost" connects whichever family it resolves to.
  await listen(linked.server);

  process.env.INTERNAL_CALDAV_URL = `http://127.0.0.1:${internal.server.address().port}`;

  await Db.ready;
  await Db.upsertUser(USER, USER, 'testuser@example.com');

  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    req.session = { userId: USER, accounts: await Db.getAccounts(USER) };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  appServer = await listen(http.createServer(app), '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  for (const s of [appServer, linked.server, internal.server]) {
    await new Promise(resolve => s.close(resolve));
  }
});

test.beforeEach(() => {
  internal.requests.length = 0;
  linked.requests.length = 0;
});

function exportCalendar(calendarId) {
  return fetch(`${base}/api/calendars/${encodeURIComponent(calendarId)}/export`);
}

test('#524 export of a stored account does not follow a redirect into the internal network', async () => {
  const account = await Db.addAccount(USER, {
    url: `http://localhost:${linked.server.address().port}/dav/`,
    username: USER,
    password: 'testpass',
    displayName: 'Redirecting server'
  });

  const res = await exportCalendar(`${account.id}::/dav/cal/`);
  const body = await res.text();

  assert.ok(linked.requests.length > 0, 'the linked server must have been asked');
  assert.deepEqual(internal.requests, [], 'the redirect target on loopback must not be contacted');
  assert.ok([400, 502].includes(res.status), `expected 400/502, got ${res.status}: ${body}`);
  assert.equal(body.includes(SECRET), false, 'internal response must not reach the caller');
});

test('#524 export of a stored OAuth2 account does not follow a redirect into the internal network', async () => {
  const account = await Db.addOAuthAccount(USER, {
    url: `http://localhost:${linked.server.address().port}/oauth/`,
    username: `${USER}-oauth`,
    refreshToken: 'testrefresh',
    accessToken: 'testaccess',
    expiresAt: Date.now() + 60 * 60 * 1000,
    displayName: 'Redirecting OAuth server'
  });

  const res = await exportCalendar(`${account.id}::/oauth/cal/`);
  const body = await res.text();

  assert.ok(linked.requests.length > 0, 'the linked server must have been asked');
  assert.deepEqual(internal.requests, [], 'the redirect target on loopback must not be contacted');
  assert.ok([400, 502].includes(res.status), `expected 400/502, got ${res.status}: ${body}`);
  assert.equal(body.includes(SECRET), false);
});

test('#524 a stored account whose URL now points at a private address is refused', async () => {
  // As if the linked hostname's DNS had been changed to an internal address after linking.
  const account = await Db.addAccount(USER, {
    url: `http://127.0.0.1:${internal.server.address().port}/dav/`,
    username: `${USER}-dns`,
    password: 'testpass',
    displayName: 'Rebound server'
  });

  const res = await exportCalendar(`${account.id}::/dav/cal/`);
  const body = await res.text();

  assert.deepEqual(internal.requests, [], 'no request may reach the private address');
  assert.ok([400, 502].includes(res.status), `expected 400/502, got ${res.status}: ${body}`);
  assert.equal(body.includes(SECRET), false);
});

test('#524 the internal Radicale account is still served from the internal host', async () => {
  const res = await exportCalendar(`internal-caldav::/${USER}/personal/`);
  const body = await res.text();

  assert.equal(res.status, 200, body);
  assert.ok(body.includes(SECRET));
  assert.deepEqual(internal.requests.map(r => r.method), ['GET']);
});
