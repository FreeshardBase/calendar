'use strict';

process.env.NODE_ENV = 'test';
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
});
