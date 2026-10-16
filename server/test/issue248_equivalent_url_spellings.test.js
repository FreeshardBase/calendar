'use strict';
require('./helpers/sameOriginFetch');

// discover() and testConnection() are stubbed below, so nothing is contacted.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost,127.0.0.1,cal.example.com';

/**
 * Issue #248 — a second spelling of an already linked CalDAV server must be
 * refused with 409, not linked as a second account. The earlier test
 * (issue248_post_accounts_duplicate_409.test.js) posts the same string twice;
 * these post two different spellings of one server and user.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http    = require('node:http');
const Db      = require('../db');
const accountsRouter = require('../routes/accounts');
const CalDAVClient   = require('../caldav/client');

let seq = 0;

function startApp(userId, sessionAccounts) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-248-spellings', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.userId = userId;
    req.session.accounts = sessionAccounts;
    next();
  });
  app.use('/', accountsRouter);
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function post(srv, body) {
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function rowsFor(userId) {
  return (await Db.getAccounts(userId)).map(a => ({ url: a.url, username: a.username }));
}

/**
 * Links `existingUrl` (in the DB, or only in the session like env-default),
 * then POSTs `postedUrl` whose discovery yields `discoveredUrl`.
 */
async function secondSpelling(t, { existingUrl, postedUrl, discoveredUrl, username = 'testuser', postedUsername = username, existingIn = 'db' }) {
  const userId = `testuser-248-spell-${++seq}`;
  await Db.upsertUser(userId, `testuser${seq}@example.com`);

  const origDiscover = CalDAVClient.prototype.discover;
  const origTest     = CalDAVClient.prototype.testConnection;
  CalDAVClient.prototype.discover       = async function () { return discoveredUrl; };
  CalDAVClient.prototype.testConnection = async function () {};

  let sessionAccounts = [];
  if (existingIn === 'db') {
    await Db.addAccount(userId, { url: existingUrl, username, password: 'secret', displayName: 'Test User' });
  } else {
    sessionAccounts = [{ id: 'env-default', url: existingUrl, username, displayName: username }];
  }
  const srv = await startApp(userId, sessionAccounts);

  t.after(async () => {
    srv.close();
    CalDAVClient.prototype.discover       = origDiscover;
    CalDAVClient.prototype.testConnection = origTest;
    await Db.deleteUserAccounts(userId);
  });

  const res = await post(srv, { url: postedUrl, username: postedUsername, password: 'secret' });
  return { res, rows: await rowsFor(userId) };
}

test('#248: base domain discovered as server root vs. linked calendar home → 409, one row', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'http://localhost:5232/test/',
    postedUrl: 'http://localhost:5232',
    discoveredUrl: 'http://localhost:5232/'
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test('#248: calendar home posted while the server root is linked → 409', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'http://localhost:5232/',
    postedUrl: 'http://localhost:5232/test/',
    discoveredUrl: 'http://localhost:5232/test/'
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test('#248: trailing slash only → 409', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'http://localhost:5232/test/',
    postedUrl: 'http://localhost:5232/test',
    discoveredUrl: 'http://localhost:5232/test'
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test('#248: host case, default port and %-escaped unreserved chars → 409', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'https://cal.example.com/dav/test~user/',
    postedUrl: 'HTTPS://CAL.Example.COM:443/dav/test%7euser',
    discoveredUrl: 'HTTPS://CAL.Example.COM:443/dav/test%7euser'
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test('#248: second spelling of the session-only env-default account → 409, nothing stored', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingIn: 'session',
    existingUrl: 'http://localhost:5232/test/',
    postedUrl: 'http://localhost:5232',
    discoveredUrl: 'http://localhost:5232/'
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(rows, []);
});

test('#248: sibling paths on the same origin are different accounts → 201', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'https://cal.example.com/radicale/',
    postedUrl: 'https://cal.example.com/nextcloud/remote.php/dav/',
    discoveredUrl: 'https://cal.example.com/nextcloud/remote.php/dav/'
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(rows.length, 2);
});

test('#248: same server, different username → 201', async (t) => {
  const { res, rows } = await secondSpelling(t, {
    existingUrl: 'http://localhost:5232/test/',
    postedUrl: 'http://localhost:5232',
    discoveredUrl: 'http://localhost:5232/',
    postedUsername: 'testuser2'
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(rows.length, 2);
});

test('#248: Db.addAccount refuses an overlapping spelling itself (race backstop)', async (t) => {
  const userId = `testuser-248-spell-${++seq}`;
  await Db.upsertUser(userId, `testuser${seq}@example.com`);
  t.after(() => Db.deleteUserAccounts(userId));

  await Db.addAccount(userId, { url: 'http://localhost:5232/test/', username: 'testuser', password: 'pw' });
  const results = await Promise.allSettled([
    Db.addAccount(userId, { url: 'http://LOCALHOST:5232/', username: 'testuser', password: 'pw' }),
    Db.addAccount(userId, { url: 'http://localhost:5232/test', username: 'testuser', password: 'pw' })
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.code, 'ACCOUNT_EXISTS');
  }
  assert.equal((await rowsFor(userId)).length, 1);
});
