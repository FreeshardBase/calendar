'use strict';

process.env.NODE_ENV = 'test';
// #337: the mock CalDAV server stands in for a remote one — allow it explicitly.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';
process.env.PORT = '3957';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_USER = 'user-157-test';

let Db;
let appServer;
const appPort = 3957;

let mockCalDAVServer;
let mockCalDAVPort;
let mockRequests = [];

// A captive portal / webmail landing page: answers 200 text/html to every request.
let portalServer;
let portalPort;
let portalRequests = [];
// Discovery answers a real 207 multistatus, but the home set answers 200 text/html.
let htmlHomeServer;
let htmlHomePort;
// Answers 207 with whatever body the current test puts in `nextBody`.
let bodyServer;
let bodyPort;
let nextBody = '';

const HTML_PAGE = '<!DOCTYPE html><html><head><title>Portal</title></head><body>Welcome</body></html>';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: appPort, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': TEST_USER,
        ...extraHeaders
      }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Issue #157 — CalDAV credential validation on account add', () => {
  before(async () => {
    // --- Mock CalDAV server ---
    // Simulates a server where discovery PROPFIND on root succeeds unauthenticated
    // but any request to the calendar home-set (/calendars/) requires correct credentials.
    mockCalDAVServer = http.createServer((req, res) => {
      const auth = req.headers['authorization'] || '';
      mockRequests.push({ url: req.url, method: req.method, auth });

      // Root / unauthenticated discovery
      if (req.url === '/' || req.url === '' || req.url === '/.well-known/caldav') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>/calendars/testuser/</d:href>
        </c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      // Calendar home requires authentication
      if (req.url.startsWith('/calendars/')) {
        const expectedAuth = 'Basic ' + Buffer.from('testuser:correctpassword').toString('base64');
        if (auth !== expectedAuth) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CalDAV"' });
          return res.end('Unauthorized');
        }
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/calendars/testuser/</d:href>
    <d:propstat>
      <d:prop><d:displayname>testuser</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise(resolve => mockCalDAVServer.listen(0, '127.0.0.1', resolve));
    mockCalDAVPort = mockCalDAVServer.address().port;

    portalServer = http.createServer((req, res) => {
      portalRequests.push({ url: req.url, method: req.method });
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    });
    portalPort = await listen(portalServer);

    htmlHomeServer = http.createServer((req, res) => {
      req.resume();
      if (req.url === '/') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    });
    htmlHomePort = await listen(htmlHomeServer);

    bodyServer = http.createServer((req, res) => {
      req.resume();
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(nextBody);
    });
    bodyPort = await listen(bodyServer);

    // --- App server ---
    Db = require('../db');
    const index = require('../index');
    appServer = index.server;
    if (!appServer.listening) {
      await new Promise((resolve, reject) => {
        appServer.listen(appPort, '127.0.0.1', resolve);
        appServer.once('error', reject);
      });
    }
  });

  after(async () => {
    Db.clearAll();
    if (mockCalDAVServer) await new Promise(resolve => mockCalDAVServer.close(resolve));
    if (portalServer) await new Promise(resolve => portalServer.close(resolve));
    if (htmlHomeServer) await new Promise(resolve => htmlHomeServer.close(resolve));
    if (bodyServer) await new Promise(resolve => bodyServer.close(resolve));
    if (appServer && appServer.close) await new Promise(resolve => appServer.close(resolve));
  });

  it('wrong password is rejected with 401 even when discovery succeeds unauthenticated', async () => {
    mockRequests = [];
    const { status, body } = await makeRequest('POST', '/api/accounts', {
      url: `http://127.0.0.1:${mockCalDAVPort}/`,
      username: 'testuser',
      password: 'wrongpassword',
      displayName: 'Test CalDAV'
    });

    assert.equal(status, 401,
      `Expected 401 for wrong password, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.error, 'Response must include an error message');
  });

  it('wrong credential is not persisted in the database', async () => {
    const stored = await Db.getAccounts(TEST_USER);
    const leaked = (stored || []).filter(a => a.url && a.url.includes(`${mockCalDAVPort}`));
    assert.equal(leaked.length, 0, 'Wrong credential must not be stored in the database after rejection');
  });

  it('correct password accepted and stored; testConnection() is called against discovered calendar home', async () => {
    mockRequests = [];
    const { status, body } = await makeRequest('POST', '/api/accounts', {
      url: `http://127.0.0.1:${mockCalDAVPort}/`,
      username: 'testuser',
      password: 'correctpassword',
      displayName: 'Test CalDAV'
    });

    assert.equal(status, 201,
      `Expected 201 for correct password, got ${status}: ${JSON.stringify(body)}`);

    // A PROPFIND must have been issued against /calendars/ to verify credentials
    const homeRequests = mockRequests.filter(r => r.url.startsWith('/calendars/'));
    assert.ok(homeRequests.length > 0,
      'testConnection() must issue a PROPFIND against the discovered calendar home to verify credentials');
  });

  it('error message for wrong password does not expose raw "UNAUTHORIZED" protocol string', async () => {
    const { status, body } = await makeRequest('POST', '/api/accounts', {
      url: `http://127.0.0.1:${mockCalDAVPort}/`,
      username: 'testuser',
      password: 'badpassword',
      displayName: 'Test'
    });

    assert.equal(status, 401);
    const errorText = body.error || '';
    assert.ok(!errorText.includes('UNAUTHORIZED'),
      `Error must not expose raw "UNAUTHORIZED" string — got: "${errorText}"`);
    assert.ok(errorText.length > 0, 'Error message must be non-empty');
  });

  // The captive portal / webmail landing page / misconfigured vhost case: a host that
  // answers 200 text/html to every request is not a CalDAV server and must not be accepted.
  it('a host answering 200 text/html to everything is rejected and nothing is persisted', async () => {
    portalRequests = [];
    const { status, body } = await makeRequest('POST', '/api/accounts', {
      url: `http://127.0.0.1:${portalPort}/`,
      username: 'testuser',
      password: 'TOTALLY-WRONG',
      displayName: 'Portal'
    });

    assert.equal(status, 400,
      `Expected 400 for an HTML host, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.error, 'Response must include an error message');
    assert.ok(portalRequests.length > 0, 'the portal must actually have been contacted');

    const stored = await Db.getAccounts(TEST_USER);
    const leaked = (stored || []).filter(a => a.url && a.url.includes(`:${portalPort}`));
    assert.equal(leaked.length, 0, 'An account on an HTML host must not be stored');
  });

  it('discover() throws on a host that answers 200 text/html instead of DAV XML', async () => {
    const CalDAVClient = require('../caldav/client');
    const client = new CalDAVClient({
      url: `http://127.0.0.1:${portalPort}/`, username: 'testuser', password: 'TOTALLY-WRONG'
    });
    await assert.rejects(() => client.discover(), /COULD_NOT_RESOLVE_CALDAV_ENDPOINT/);
  });

  it('testConnection() rejects a 200 text/html answer from the calendar home', async () => {
    const CalDAVClient = require('../caldav/client');
    const client = new CalDAVClient({
      url: `http://127.0.0.1:${portalPort}/`, username: 'testuser', password: 'TOTALLY-WRONG'
    });
    await assert.rejects(() => client.testConnection(), /NOT_CALDAV_RESPONSE/);
  });

  it('a home set answering 200 text/html after a valid 207 discovery is rejected and not persisted', async () => {
    const { status, body } = await makeRequest('POST', '/api/accounts', {
      url: `http://127.0.0.1:${htmlHomePort}/`,
      username: 'testuser',
      password: 'TOTALLY-WRONG',
      displayName: 'HTML home'
    });

    assert.equal(status, 400,
      `Expected 400 (not CalDAV) when the home set is HTML, got ${status}: ${JSON.stringify(body)}`);
    assert.match(body.error, /CalDAV/, 'error must say the server is not a CalDAV server, not blame the password');

    const stored = await Db.getAccounts(TEST_USER);
    const leaked = (stored || []).filter(a => a.url && a.url.includes(`:${htmlHomePort}`));
    assert.equal(leaked.length, 0, 'An account whose home set is HTML must not be stored');
  });

  async function testConnectionWithBody(xml) {
    nextBody = xml;
    const CalDAVClient = require('../caldav/client');
    const client = new CalDAVClient({
      url: `http://127.0.0.1:${bodyPort}/home/`, username: 'testuser', password: 'secret'
    });
    return client.testConnection();
  }

  const MS_RESPONSE = '<response><href>/home/</href></response>';

  it('testConnection() accepts real multistatus shapes (default namespace, upper-case prefix, BOM + declaration)', async () => {
    assert.equal(await testConnectionWithBody(
      `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">${MS_RESPONSE}</multistatus>`), true);
    assert.equal(await testConnectionWithBody(
      `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response/></D:multistatus>`), true);
    assert.equal(await testConnectionWithBody(
      `\uFEFF<?xml version="1.0"?>\n<!-- generated -->\n<d:multistatus\n  xmlns:cs="http://calendarserver.org/ns/"\n  xmlns:d="DAV:"><d:response/></d:multistatus>`), true);
  });

  it('testConnection() rejects a multistatus element outside the DAV: namespace', async () => {
    await assert.rejects(() => testConnectionWithBody(
      `<multistatus>${MS_RESPONSE}</multistatus>`), /NOT_CALDAV_RESPONSE/);
    await assert.rejects(() => testConnectionWithBody(
      `<d:multistatus xmlns:d="urn:example:not-dav"><d:response/></d:multistatus>`), /NOT_CALDAV_RESPONSE/);
    await assert.rejects(() => testConnectionWithBody(
      `<d:multistatus xmlns:x="DAV:"><d:response/></d:multistatus>`), /NOT_CALDAV_RESPONSE/);
    await assert.rejects(() => testConnectionWithBody(
      `<d:multistatus-page xmlns:d="DAV:"><d:response/></d:multistatus-page>`), /NOT_CALDAV_RESPONSE/);
  });

  it('testConnection() rejects a page that merely mentions a multistatus tag below a non-DAV root', async () => {
    await assert.rejects(() => testConnectionWithBody(
      `<html><!-- <d:multistatus xmlns:d="DAV:"> --><body>Welcome</body></html>`), /NOT_CALDAV_RESPONSE/);
    await assert.rejects(() => testConnectionWithBody(
      `<html><body><pre><d:multistatus xmlns:d="DAV:"></d:multistatus></pre></body></html>`), /NOT_CALDAV_RESPONSE/);
  });

  it('discover() applies the same DAV check: a 207 with a non-DAV or commented-out multistatus does not resolve', async () => {
    const CalDAVClient = require('../caldav/client');
    for (const xml of [
      `<multistatus><response><href>/</href></response></multistatus>`,
      `<html><!-- <d:multistatus xmlns:d="DAV:"> --><body>Welcome</body></html>`
    ]) {
      nextBody = xml;
      const client = new CalDAVClient({
        url: `http://127.0.0.1:${bodyPort}/`, username: 'testuser', password: 'secret'
      });
      await assert.rejects(() => client.discover(), /COULD_NOT_RESOLVE_CALDAV_ENDPOINT/, `discover() accepted: ${xml}`);
    }
  });
});
