'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3195';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = process.env.CALDAVURL || `http://localhost:${process.env.PORT}/mock-dav/`;
process.env.CALDAV_USERNAME = 'test';
process.env.CALDAV_PASSWORD = 'password';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Issue #71 — Auth Guard Resilience & CalDAV Default Test Suite', async (t) => {
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3195, resolve));
  }

  t.after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      if (server.close) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (server.unref) {
        server.unref();
      }
    }
  });

  await Db.clearAll().catch(() => {});

  await t.test('Protected API endpoints strictly reject unauthenticated requests with 401', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/calendars' },
      { method: 'POST', path: '/api/calendars' },
      { method: 'GET', path: '/api/events' },
      { method: 'POST', path: '/api/events' },
      { method: 'GET', path: '/api/tasks' },
      { method: 'POST', path: '/api/tasks' },
      { method: 'GET', path: '/api/msgraph/accounts' },
      { method: 'GET', path: '/api/resources' },
      { method: 'GET', path: '/api/delegates' },
      { method: 'GET', path: '/api/working-hours' },
      { method: 'GET', path: '/api/attachments/filebrowser/files' },
      { method: 'POST', path: '/api/quick-add/parse' },
      { method: 'POST', path: '/api/freebusy/query' }
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      assert.strictEqual(res.status, 401, `Endpoint ${ep.method} ${ep.path} should return 401 when unauthenticated`);
      const body = await res.json();
      assert.strictEqual(body.error, 'Authentication required');
    }
  });

  await t.test('Protected API endpoints strictly reject requests with explicit x-test-user-id: unauthenticated', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/calendars' },
      { method: 'GET', path: '/api/events' },
      { method: 'GET', path: '/api/tasks' }
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          'x-test-user-id': 'unauthenticated'
        }
      });
      assert.strictEqual(res.status, 401, `Endpoint ${ep.method} ${ep.path} should return 401 for explicit unauthenticated header`);
      const body = await res.json();
      assert.strictEqual(body.error, 'Authentication required');
    }
  });

  await t.test('CalDAV integration route tests run against mock-dav server by default without skipping', async () => {
    const res = await fetch(`${baseUrl}/api/calendars`, {
      headers: {
        'x-test-user-id': 'testuser'
      }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.calendars));
    assert.ok(body.calendars.length > 0);
    assert.ok(!body.calendars.some(c => c.id && c.id.includes('(local)')), 'Must not return local fallback calendar when CalDAV server is operational');
    const mockCal = body.calendars.find(c => c.name === 'Persönlich');
    assert.ok(mockCal, 'Must return Persönlich calendar from mock-dav server');
    assert.ok(mockCal.href.includes('/mock-dav/'), `Calendar href (${mockCal.href}) must originate from mock-dav endpoint`);
  });
});
