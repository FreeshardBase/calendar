'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '3958';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_USER = 'user-158-test';

let Db;
let appServer;
let testUserCookie;
const appPort = 3958;

function makeRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: appPort,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie: testUserCookie,
        ...extraHeaders
      }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Issue #158 — Satisfiable search-users assertions across internal and external accounts', () => {
  before(async () => {
    Db = require('../db');
    await Db.clearAll();
    await Db.upsertUser(TEST_USER, TEST_USER);

    const index = require('../index');
    appServer = index.server;
    if (!appServer.listening) {
      await new Promise((resolve, reject) => {
        appServer.once('listening', resolve);
        appServer.once('error', reject);
      });
    }
    testUserCookie = await require('./helpers/testSession').loginAs(TEST_USER);
  });

  after(async () => {
    await Db.clearAll();
    if (appServer && appServer.close) {
      await new Promise(resolve => appServer.close(resolve));
    }
  });

  it('GET /api/calendars/search-users returns matched users for internal-caldav account', async () => {
    // Add another test user into DB to search for
    await Db.upsertUser('searched-user-158', 'searched-user-158');

    const { status, body } = await makeRequest('GET', '/api/calendars/search-users?q=searched-user-158');

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body), 'Response must be an array of users');
    assert.ok(body.length > 0, 'Must return at least one matched user');

    const matched = body.find(u => u.displayname === 'searched-user-158' || u.href === 'searched-user-158');
    assert.ok(matched, 'Found user must include searched-user-158');
    assert.ok(matched.displayname, 'User object must contain non-empty displayname');
    assert.ok(matched.email, 'User object must contain non-empty email');
    assert.ok(matched.href, 'User object must contain non-empty href');
  });

  it('GET /api/calendars/search-users returns empty array when query does not match any user', async () => {
    const { status, body } = await makeRequest('GET', '/api/calendars/search-users?q=nonexistent_query_xyz_9999');

    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });
});
