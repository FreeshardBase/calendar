'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3172';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Db = require('../db');
const { SqliteSessionStore } = require('../utils/sessionStore');
const { app, server } = require('../index');

describe('Issue #172 — Prevent SQLite write & fsync on static files, 304s, 404s, and unchanged sessions', () => {
  after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;

  test('Static file request does not trigger Db.upsertUser or SqliteSessionStore.set', async () => {
    let upsertCalled = false;
    let sessionSetCalled = false;

    const origUpsert = Db.upsertUser;
    const origSet = SqliteSessionStore.prototype.set;

    Db.upsertUser = async (...args) => {
      upsertCalled = true;
      return origUpsert.apply(Db, args);
    };
    SqliteSessionStore.prototype.set = function(...args) {
      sessionSetCalled = true;
      return origSet.apply(this, args);
    };

    try {
      const res = await fetch(`${baseUrl}/js/app.js`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(upsertCalled, false, 'Static file request must not execute Db.upsertUser');
      assert.strictEqual(sessionSetCalled, false, 'Static file request must not execute sessionStore.set');
    } finally {
      Db.upsertUser = origUpsert;
      SqliteSessionStore.prototype.set = origSet;
    }
  });

  test('Unmatched static asset 404 request does not trigger Db.upsertUser or SqliteSessionStore.set', async () => {
    let upsertCalled = false;
    let sessionSetCalled = false;

    const origUpsert = Db.upsertUser;
    const origSet = SqliteSessionStore.prototype.set;

    Db.upsertUser = async (...args) => {
      upsertCalled = true;
      return origUpsert.apply(Db, args);
    };
    SqliteSessionStore.prototype.set = function(...args) {
      sessionSetCalled = true;
      return origSet.apply(this, args);
    };

    try {
      const res = await fetch(`${baseUrl}/css/non-existent-file.css`);
      assert.strictEqual(upsertCalled, false, 'Static asset 404 request must not execute Db.upsertUser');
      assert.strictEqual(sessionSetCalled, false, 'Static asset 404 request must not execute sessionStore.set');
    } finally {
      Db.upsertUser = origUpsert;
      SqliteSessionStore.prototype.set = origSet;
    }
  });

  test('304 Not Modified request does not trigger Db.upsertUser or SqliteSessionStore.set', async () => {
    const firstRes = await fetch(`${baseUrl}/js/app.js`);
    const etag = firstRes.headers.get('etag');

    let upsertCalled = false;
    let sessionSetCalled = false;

    const origUpsert = Db.upsertUser;
    const origSet = SqliteSessionStore.prototype.set;

    Db.upsertUser = async (...args) => {
      upsertCalled = true;
      return origUpsert.apply(Db, args);
    };
    SqliteSessionStore.prototype.set = function(...args) {
      sessionSetCalled = true;
      return origSet.apply(this, args);
    };

    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: process.env.PORT,
          path: '/js/app.js',
          method: 'GET',
          headers: etag ? { 'if-none-match': etag } : {}
        }, resolve);
        req.on('error', reject);
        req.end();
      });

      assert.strictEqual(res.statusCode, 304);
      assert.strictEqual(upsertCalled, false, '304 Not Modified request must not execute Db.upsertUser');
      assert.strictEqual(sessionSetCalled, false, '304 Not Modified request must not execute sessionStore.set');
    } finally {
      Db.upsertUser = origUpsert;
      SqliteSessionStore.prototype.set = origSet;
    }
  });

  test('Subsequent authenticated GET request with unchanged session does not trigger Db.upsertUser or sessionStore.set', async () => {
    const initRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': 'test-fsync-user' }
    });
    const cookie = initRes.headers.get('set-cookie');

    let upsertCount = 0;
    let sessionSetCount = 0;

    const origUpsert = Db.upsertUser;
    const origSet = SqliteSessionStore.prototype.set;

    Db.upsertUser = async (...args) => {
      upsertCount++;
      return origUpsert.apply(Db, args);
    };
    SqliteSessionStore.prototype.set = function(...args) {
      sessionSetCount++;
      return origSet.apply(this, args);
    };

    try {
      const res = await fetch(`${baseUrl}/api/accounts`, {
        headers: {
          'x-test-user-id': 'test-fsync-user',
          'Cookie': cookie ? cookie.split(';')[0] : ''
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(upsertCount, 0, 'Subsequent GET request with same user must not re-run Db.upsertUser');
      assert.strictEqual(sessionSetCount, 0, 'Subsequent GET request with unchanged session must not re-run sessionStore.set');
    } finally {
      Db.upsertUser = origUpsert;
      SqliteSessionStore.prototype.set = origSet;
    }
  });
});
