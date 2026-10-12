'use strict';

// Issue #336 — the CalDAV client must not forward credentials (Authorization,
// Cookie) across a redirect that changes scheme, host or port, and a redirect
// must not opt a hop into the internal Radicale TLS exception.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const CalDAVClient = require('../caldav/client');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const EXPECTED_AUTH = 'Basic ' + Buffer.from('testuser:testpassword').toString('base64');

test('Issue #336 — cross-origin redirect strips credentials', async (t) => {
  let attackerHeaders = null;
  const attacker = await listen((req, res) => {
    attackerHeaders = req.headers;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const attackerPort = attacker.address().port;

  let sameOriginHeaders = null;
  const origin = await listen((req, res) => {
    if (req.url === '/to-attacker') {
      res.writeHead(307, { Location: `http://127.0.0.1:${attackerPort}/steal` });
      return res.end();
    }
    if (req.url === '/to-self') {
      res.writeHead(301, { Location: '/dav/' });
      return res.end();
    }
    sameOriginHeaders = req.headers;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const originPort = origin.address().port;

  t.after(async () => {
    await close(attacker);
    await close(origin);
  });

  const client = new CalDAVClient({
    url: `http://127.0.0.1:${originPort}/dav/`,
    username: 'testuser',
    password: 'testpassword'
  });

  await t.test('Authorization and Cookie are not sent to a different port', async () => {
    attackerHeaders = null;
    const res = await client._request('PROPFIND', `http://127.0.0.1:${originPort}/to-attacker`, {
      headers: { Depth: '0', Cookie: 'session=testsession' }
    });
    assert.equal(res.status, 207);
    assert.ok(attackerHeaders, 'redirect target must have been contacted');
    assert.equal(attackerHeaders['authorization'], undefined, 'Authorization leaked to cross-origin redirect target');
    assert.equal(attackerHeaders['cookie'], undefined, 'Cookie leaked to cross-origin redirect target');
    assert.equal(attackerHeaders['depth'], '0', 'non-credential headers are still forwarded');
    assert.equal(attackerHeaders['accept-encoding'], 'identity');
  });

  await t.test('same-origin redirect keeps Authorization', async () => {
    sameOriginHeaders = null;
    const res = await client._request('PROPFIND', `http://127.0.0.1:${originPort}/to-self`, {
      headers: { Depth: '0' }
    });
    assert.equal(res.status, 207);
    assert.equal(sameOriginHeaders['authorization'], EXPECTED_AUTH);
  });
});

test('Issue #336 — redirect from an external host does not use the internal TLS dispatcher', async (t) => {
  const internal = await listen((req, res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const internalPort = internal.address().port;
  const external = await listen((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/radicale/` });
    res.end();
  });
  const externalPort = external.address().port;

  const prevInternal = process.env.INTERNAL_CALDAV_URL;
  process.env.INTERNAL_CALDAV_URL = `http://127.0.0.1:${internalPort}`;

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), dispatcher: opts && opts.dispatcher });
    return realFetch(url, opts);
  };

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevInternal === undefined) delete process.env.INTERNAL_CALDAV_URL;
    else process.env.INTERNAL_CALDAV_URL = prevInternal;
    await close(internal);
    await close(external);
  });

  const client = new CalDAVClient({
    url: `http://127.0.0.1:${externalPort}/dav/`,
    username: 'testuser',
    password: 'testpassword'
  });
  const res = await client._request('PROPFIND', `http://127.0.0.1:${externalPort}/dav/`, {
    headers: { Depth: '0' }
  });
  assert.equal(res.status, 207);

  const hop = calls.find((c) => c.url.startsWith(`http://127.0.0.1:${internalPort}/`));
  assert.ok(hop, 'redirect to internal host must have been followed');
  assert.equal(hop.dispatcher, undefined, 'redirected hop must not use the verification-disabled internal dispatcher');

  // Direct requests to the internal host still get the internal dispatcher.
  calls.length = 0;
  const internalClient = new CalDAVClient({
    url: `http://127.0.0.1:${internalPort}/radicale/`,
    username: 'testuser',
    password: 'testpassword'
  });
  await internalClient._request('PROPFIND', `http://127.0.0.1:${internalPort}/radicale/`, { headers: { Depth: '0' } });
  assert.ok(calls[0].dispatcher, 'direct internal request keeps the internal dispatcher');
});
