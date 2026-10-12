'use strict';

/**
 * Issue #337 — SSRF: account linking (POST /api/accounts) and webcal
 * subscriptions must not fetch loopback, link-local, private or internal
 * targets — neither directly, via DNS, nor via a redirect. Webcal fetches are
 * bounded in time and size.
 *
 * "Public" hosts are simulated with OUTBOUND_FETCH_ALLOW_HOSTS=localhost (the
 * operator allowlist) or a mocked DNS answer; every internal target is a real
 * listening server that counts hits, so "rejected" means "never contacted".
 */

process.env.NODE_ENV = 'production';
delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS;

const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const dns     = require('node:dns');
const express = require('express');
const session = require('express-session');
const Db      = require('../db');
const accountsRouter = require('../routes/accounts');
const webcalRouter   = require('../routes/webcal');
const { fetchAndParseWebcalFeed } = require('../utils/webcalSubscription');

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:e1@example.com\r\n'
  + 'DTSTART:20261012T100000Z\r\nDTEND:20261012T110000Z\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function startServer(handler, host) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, host, () => resolve({ srv, hits, port: srv.address().port }));
  });
}

// Answers like a reachable CalDAV server / ICS feed — what an attacker probes for.
function internalService(req, res) {
  if (req.method === 'PROPFIND') {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href>'
      + '<d:propstat><d:prop><d:displayname>internal</d:displayname></d:prop>'
      + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/calendar' });
  res.end(ICS);
}

function close(s) { return new Promise(r => s.srv.close(r)); }

async function startAccountsApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-337', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.userId = 'testuser-337';
    req.session.accounts = [];
    next();
  });
  app.use('/api/accounts', accountsRouter);
  return startServer(app, '127.0.0.1');
}

async function postAccount(appSrv, url) {
  const res = await fetch(`http://127.0.0.1:${appSrv.port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, username: 'testuser', password: 'testpass' }),
    signal: AbortSignal.timeout(8000)
  });
  return { status: res.status, body: await res.json() };
}

function stubDb(t) {
  const added = [];
  t.mock.method(Db, 'findAccountByUrlAndUsername', async () => null);
  t.mock.method(Db, 'addAccount', async (userId, acc) => { added.push(acc); return { id: 'acc-337', displayName: 'x' }; });
  t.mock.method(Db, 'addSyncJob', async () => ({ id: 'job-337' }));
  t.mock.method(Db, 'updateWebcalSubscriptionSyncTime', async () => {});
  return added;
}

function mockDnsPromises(t, table) {
  const real = dns.promises.lookup;
  t.mock.method(dns.promises, 'lookup', async (host, opts) => {
    if (table[host]) return table[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
    return real.call(dns.promises, host, opts);
  });
}

function assertBlocked(err) {
  assert.equal(err.code, 'OUTBOUND_URL_BLOCKED', `expected an SSRF rejection, got: ${err.code} ${err.message}`);
  return true;
}

// ── POST /api/accounts ────────────────────────────────────────────────────────

test('#337 accounts: loopback, link-local and internal targets are rejected without being contacted', { timeout: 30000 }, async (t) => {
  const added = stubDb(t);
  const internal = await startServer(internalService, '127.0.0.1');
  const appSrv = await startAccountsApp();
  t.after(() => Promise.all([close(internal), close(appSrv)]));

  for (const url of [
    `http://127.0.0.1:${internal.port}/`,
    `http://localhost:${internal.port}/`,
    `http://[::1]:${internal.port}/`,
    `http://[::ffff:127.0.0.1]:${internal.port}/`,
    'http://169.254.169.254/latest/meta-data/',
    'http://caldav-server:5232/',
    'http://10.0.0.5/'
  ]) {
    const res = await postAccount(appSrv, url);
    assert.equal(res.status, 400, `${url} must be rejected with 400, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual(internal.hits, [], 'internal service must never be contacted');
  assert.deepEqual(added, [], 'no account may be stored');
});

test('#337 accounts: a hostname resolving to 10.x is rejected', { timeout: 15000 }, async (t) => {
  const added = stubDb(t);
  mockDnsPromises(t, { 'intranet.example.com': ['10.1.2.3'] });
  const appSrv = await startAccountsApp();
  t.after(() => close(appSrv));

  const res = await postAccount(appSrv, 'https://intranet.example.com/dav/');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(added, []);
});

test('#337 accounts: a public URL redirecting to 127.0.0.1 is rejected', { timeout: 15000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  t.after(() => { delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS; });
  const added = stubDb(t);
  const internal = await startServer(internalService, '127.0.0.1');
  const publicHost = await startServer((req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${internal.port}/dav/` });
    res.end();
  });
  const appSrv = await startAccountsApp();
  t.after(() => Promise.all([close(internal), close(publicHost), close(appSrv)]));

  const res = await postAccount(appSrv, `http://localhost:${publicHost.port}/dav/`);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(publicHost.hits.length > 0, 'the public host itself is contacted');
  assert.deepEqual(internal.hits, [], 'the redirect target must never be contacted');
  assert.deepEqual(added, []);
});

// ── Webcal subscriptions ──────────────────────────────────────────────────────

test('#337 webcal: loopback, link-local and private targets are rejected without being contacted', { timeout: 30000 }, async (t) => {
  stubDb(t);
  mockDnsPromises(t, { 'feeds.example.com': ['10.20.30.40'] });
  const internal = await startServer(internalService, '127.0.0.1');
  t.after(() => close(internal));

  for (const url of [
    `http://127.0.0.1:${internal.port}/feed.ics`,
    `webcal://localhost:${internal.port}/feed.ics`,
    `http://[::1]:${internal.port}/feed.ics`,
    'http://169.254.169.254/latest/meta-data/',
    'https://feeds.example.com/feed.ics'
  ]) {
    await assert.rejects(fetchAndParseWebcalFeed({ url }), assertBlocked, url);
  }
  assert.deepEqual(internal.hits, []);
});

test('#337 webcal route: subscriptions to internal targets are refused and not stored', { timeout: 15000 }, async (t) => {
  stubDb(t);
  const created = [];
  t.mock.method(Db, 'createWebcalSubscription', async (sub) => { created.push(sub); return { id: 'sub-337', ...sub }; });
  t.mock.method(Db, 'getWebcalSubscription', async () => null);
  const internal = await startServer(internalService, '127.0.0.1');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 'testuser-337' }; next(); });
  app.use('/api/webcal', webcalRouter);
  const appSrv = await startServer(app, '127.0.0.1');
  t.after(() => Promise.all([close(internal), close(appSrv)]));

  for (const url of [`http://127.0.0.1:${internal.port}/feed.ics`, 'webcal://169.254.169.254/feed.ics']) {
    const res = await fetch(`http://127.0.0.1:${appSrv.port}/api/webcal/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', url }),
      signal: AbortSignal.timeout(8000)
    });
    assert.equal(res.status, 400, `${url}: ${res.status}`);
  }
  assert.deepEqual(created, []);
  assert.deepEqual(internal.hits, []);
});

test('#337 webcal: a public URL redirecting to 127.0.0.1 is rejected', { timeout: 15000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  t.after(() => { delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS; });
  stubDb(t);
  const internal = await startServer(internalService, '127.0.0.1');
  const publicHost = await startServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/feed.ics` });
    res.end();
  });
  t.after(() => Promise.all([close(internal), close(publicHost)]));

  await assert.rejects(fetchAndParseWebcalFeed({ url: `http://localhost:${publicHost.port}/feed.ics` }), assertBlocked);
  assert.ok(publicHost.hits.length > 0);
  assert.deepEqual(internal.hits, []);
});

test('#337 webcal: DNS answer that changes to 127.0.0.1 at connect time is rejected', { timeout: 15000 }, async (t) => {
  stubDb(t);
  const internal = await startServer(internalService, '127.0.0.1');
  t.after(() => close(internal));
  mockDnsPromises(t, { 'rebind.example.com': ['93.184.216.34'] });
  const realLookup = dns.lookup;
  let connectLookups = 0;
  t.mock.method(dns, 'lookup', (host, opts, cb) => {
    if (host !== 'rebind.example.com') return realLookup.call(dns, host, opts, cb);
    connectLookups++;
    if (opts && opts.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
    return cb(null, '127.0.0.1', 4);
  });

  await assert.rejects(
    fetchAndParseWebcalFeed({ url: `http://rebind.example.com:${internal.port}/feed.ics` }),
    (err) => assertBlocked(err.cause?.code === 'OUTBOUND_URL_BLOCKED' ? err.cause : err)
  );
  assert.ok(connectLookups > 0, 'the public pre-check answer must pass; the connect-time lookup must be what blocks');
  assert.deepEqual(internal.hits, []);
});

test('#337 webcal: redirects are capped', { timeout: 15000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  t.after(() => { delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS; });
  stubDb(t);
  const loop = await startServer((req, res) => {
    res.writeHead(302, { Location: `/hop${Number(req.url.replace(/\D/g, '') || 0) + 1}` });
    res.end();
  });
  t.after(() => close(loop));

  await assert.rejects(fetchAndParseWebcalFeed({ url: `http://localhost:${loop.port}/hop0` }), /Too many redirects/);
  assert.ok(loop.hits.length <= 6, `followed ${loop.hits.length} hops`);
});

test('#337 webcal: response bodies over 10 MB are rejected', { timeout: 30000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  t.after(() => { delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS; });
  const synced = [];
  stubDb(t);
  t.mock.method(Db, 'updateWebcalSubscriptionSyncTime', async (...args) => { synced.push(args); });
  const chunk = Buffer.alloc(1024 * 1024, 'X');
  let sent = 0;
  const huge = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' }); // chunked, no Content-Length
    const pump = () => {
      while (sent < 64) {
        sent++;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => { sent = Infinity; });
    pump();
  });
  t.after(() => close(huge));

  await assert.rejects(
    fetchAndParseWebcalFeed({ id: 'sub-337', url: `http://localhost:${huge.port}/huge.ics` }),
    (err) => err.code === 'RESPONSE_TOO_LARGE'
  );
  assert.deepEqual(synced, []);
});

test('#337 webcal: a server that never answers times out', { timeout: 15000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  process.env.OUTBOUND_FETCH_TIMEOUT_MS = '500';
  t.after(() => {
    delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS;
    delete process.env.OUTBOUND_FETCH_TIMEOUT_MS;
  });
  stubDb(t);
  const pending = [];
  const silent = await startServer((req, res) => { pending.push(res); });
  t.after(() => { pending.forEach(r => r.destroy()); return close(silent); });

  const started = Date.now();
  await assert.rejects(fetchAndParseWebcalFeed({ url: `http://localhost:${silent.port}/slow.ics` }));
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('#337 webcal: an allowed public feed is still fetched and parsed', { timeout: 15000 }, async (t) => {
  process.env.OUTBOUND_FETCH_ALLOW_HOSTS = 'localhost';
  t.after(() => { delete process.env.OUTBOUND_FETCH_ALLOW_HOSTS; });
  stubDb(t);
  const feed = await startServer(internalService);
  t.after(() => close(feed));

  const events = await fetchAndParseWebcalFeed({ url: `webcal://http://localhost:${feed.port}/feed.ics` });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Test');
});
