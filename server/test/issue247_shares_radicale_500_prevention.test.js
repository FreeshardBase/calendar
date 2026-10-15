'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http = require('node:http');
const Db = require('../db');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const CalDAVClient = require('../caldav/client');

test('Issue #247 — POST/PUT/DELETE /api/calendars/:id/shares returns 405/501 instead of 500 on unsupported CalDAV/Radicale servers', async (t) => {
  let server;
  let mockRadicaleServer;
  let baseUrl;
  let mockRadicaleUrl;

  t.before(async () => {
    // 1. Setup mock Radicale server returning 405 Method Not Allowed to POST requests on calendar collections
    mockRadicaleServer = http.createServer((req, res) => {
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${req.url}</d:href>
    <d:propstat>
      <d:status>HTTP/1.1 404 Not Found</d:status>
      <d:prop><cs:invite xmlns:cs="http://calendarserver.org/ns/"/><o:invite xmlns:o="http://owncloud.org/ns"/></d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }
      if (req.method === 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('405 Method Not Allowed');
      }
      res.writeHead(200);
      res.end();
    });

    await new Promise((resolve) => {
      mockRadicaleServer.listen(0, '127.0.0.1', () => {
        const addr = mockRadicaleServer.address();
        mockRadicaleUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 2. Register test users in DB & seed internal share
    await Db.upsertUser('owner_247', 'owner_247', 'owner_247@example.com');
    await Db.upsertUser('sharee_247', 'sharee_247', 'sharee_247@example.com');
    await Db.addUserShare('internal-caldav::/owner_247/personal/', 'sharee_247', true, 'ACCEPTED', 'WRITE');

    // 3. Setup Express app with calendarsRouter
    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret-247',
      resave: false,
      saveUninitialized: true
    }));

    app.use((req, res, next) => {
      req.session.userId = 'owner_247';
      req.session.accounts = [
        {
          id: 'radicale-ext',
          url: `${mockRadicaleUrl}/owner_247/`,
          username: 'owner_247',
          password: 'password'
        },
        {
          id: 'internal-caldav',
          url: 'http://localhost:5232/owner_247/',
          username: 'owner_247',
          password: 'password'
        }
      ];
      next();
    });

    app.use('/api/calendars', calendarsRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockRadicaleServer) await new Promise((resolve) => mockRadicaleServer.close(resolve));
  });

  await t.test('1. POST /api/calendars/:id/shares returns 405 or 501 (NOT 500) against Radicale server', async () => {
    const extCalId = encodeURIComponent(`radicale-ext::${mockRadicaleUrl}/owner_247/personal/`);
    const res = await fetch(`${baseUrl}/api/calendars/${extCalId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharee: 'sharee_247', readWrite: true })
    });

    assert.notStrictEqual(res.status, 500, 'POST /shares must not fail with 500 Internal Server Error');
    assert.ok(res.status === 405 || res.status === 501, `Expected status 405 or 501, got ${res.status}`);
    const data = await res.json();
    assert.ok(data.error, 'Error message should be present');
  });

  await t.test('2. PUT /api/calendars/:id/shares/:shareeId succeeds for internal-caldav and returns 405/501 for Radicale', async () => {
    const internalCalId = encodeURIComponent('internal-caldav::/owner_247/personal/');
    const intRes = await fetch(`${baseUrl}/api/calendars/${internalCalId}/shares/sharee_247`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'WRITE', readWrite: true })
    });
    assert.strictEqual(intRes.status, 200, 'PUT /shares/:shareeId must succeed with 200 for internal-caldav');

    const extCalId = encodeURIComponent(`radicale-ext::${mockRadicaleUrl}/owner_247/personal/`);
    const extRes = await fetch(`${baseUrl}/api/calendars/${extCalId}/shares/sharee_247`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'WRITE', readWrite: true })
    });
    assert.notStrictEqual(extRes.status, 500, 'PUT /shares/:shareeId must not fail with 500 Internal Server Error for external CalDAV');
    assert.ok(extRes.status === 405 || extRes.status === 501, `Expected status 405 or 501, got ${extRes.status}`);
  });

  await t.test('3. DELETE /api/calendars/:id/shares returns 405 or 501 (NOT 500) against Radicale server', async () => {
    const extCalId = encodeURIComponent(`radicale-ext::${mockRadicaleUrl}/owner_247/personal/`);
    const res = await fetch(`${baseUrl}/api/calendars/${extCalId}/shares`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharee: 'sharee_247' })
    });

    assert.notStrictEqual(res.status, 500, 'DELETE /shares must not fail with 500 Internal Server Error');
    assert.ok(res.status === 405 || res.status === 501, `Expected status 405 or 501, got ${res.status}`);
  });

  await t.test('4. CalDAVClient.updateCalendarShares sets err.status on failed response', async () => {
    const client = new CalDAVClient({
      url: mockRadicaleUrl,
      username: 'owner_247',
      password: 'password'
    });

    try {
      await client.updateCalendarShares(`${mockRadicaleUrl}/owner_247/personal/`, { href: 'sharee_247', readWrite: true });
      assert.fail('Should have thrown an error');
    } catch (err) {
      assert.ok(err.status === 405 || err.status === 501, `err.status should be 405 or 501, got ${err.status}`);
    }
  });
});
