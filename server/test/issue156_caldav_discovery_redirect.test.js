'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const CalDAVClient = require('../caldav/client');

test('Issue #156 — CalDAV discovery resolves relative hrefs against post-redirect base & preserves Authorization across same-origin redirects', async (t) => {
  let serverA;
  let portA;

  let serverARequestCount = 0;
  let serverBHeaders = null;
  let serverBRequestedUrl = null;

  test.before(async () => {
    // Redirects /caldav to the DAV root on the same origin. Cross-origin
    // redirects strip Authorization (#336), so this stays same-origin.
    serverA = http.createServer((req, res) => {
      serverARequestCount++;
      if (req.url === '/caldav') {
        res.writeHead(302, { Location: '/remote.php/dav/' });
        return res.end();
      }

      // WebDAV / CalDAV endpoint requiring Authorization header
      serverBHeaders = req.headers;
      serverBRequestedUrl = req.url;

      const auth = req.headers['authorization'];
      if (!auth) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('Unauthorized');
      }

      if (req.url === '/remote.php/dav/' || req.url === '/remote.php/dav') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>calendars/testuser/</d:href>
        </c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve));

    portA = serverA.address().port;
  });

  test.after(async () => {
    if (serverA) await new Promise((resolve) => serverA.close(resolve));
  });

  await t.test('discover() preserves Authorization header and resolves relative href against post-redirect base URL', async () => {
    const client = new CalDAVClient({
      url: `http://127.0.0.1:${portA}/caldav`,
      username: 'testuser',
      password: 'testpassword'
    });

    const discoveredUrl = await client.discover();

    // 1. Verify Authorization header was preserved across the same-origin redirect
    assert.ok(serverBHeaders, 'DAV root should have received request');
    assert.ok(serverBHeaders['authorization'], 'DAV root must receive Authorization header across same-origin redirect');
    const expectedAuth = 'Basic ' + Buffer.from('testuser:testpassword').toString('base64');
    assert.equal(serverBHeaders['authorization'], expectedAuth);

    // 2. Verify relative href 'calendars/testuser/' was resolved against POST-REDIRECT base URL (/remote.php/dav/, NOT /caldav)
    const expectedUrl = `http://127.0.0.1:${portA}/remote.php/dav/calendars/testuser/`;
    assert.equal(discoveredUrl, expectedUrl, 'Returned discovered URL must use post-redirect host and path');
    assert.equal(client.baseUrl, expectedUrl, 'client.baseUrl must be updated to post-redirect home-set URL');
  });

  await t.test('_request follows redirects while retaining Authorization header and updates res.url', async () => {
    const client = new CalDAVClient({
      url: `http://127.0.0.1:${portA}/caldav`,
      username: 'testuser',
      password: 'testpassword'
    });

    const res = await client._request('PROPFIND', `http://127.0.0.1:${portA}/caldav`);
    assert.equal(res.status, 207);
    assert.equal(res.url, `http://127.0.0.1:${portA}/remote.php/dav/`);
  });
});
