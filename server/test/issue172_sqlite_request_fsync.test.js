'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3172';
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
server.listen(process.env.PORT);
const { loginAs } = require('./helpers/testSession');

after(() => {
  if (server && server.close) server.close();
});

describe('Issue #172 — Prevent SQLite write & fsync on static files, 304s, 404s, and unchanged sessions', () => {
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
    const cookie = await loginAs('test-fsync-user');
    // First request settles the session (user upsert, accounts) so the next one is unchanged.
    const initRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.strictEqual(initRes.status, 200);

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
          cookie
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

// A browser sends the session cookie on every same-origin asset request of a page load, so the
// requests below carry it. Every Db method that loads or writes session/user state is counted.
describe('Issue #172 — cookie-bearing requests cause no database work beyond what they need', () => {
  const baseUrl = `http://localhost:${process.env.PORT}`;
  const WATCHED = ['getRawSession', 'saveSession', 'touchSession', 'upsertUser', 'getAccounts', 'getUsernameByUserId', 'getUserEmailByUserId'];

  async function countDbCalls(fn) {
    const counts = {};
    const originals = {};
    for (const name of WATCHED) {
      originals[name] = Db[name];
      Db[name] = (...args) => {
        counts[name] = (counts[name] || 0) + 1;
        return originals[name].apply(Db, args);
      };
    }
    try {
      const result = await fn();
      // express-session writes/touches the session after the response has been sent.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { result, counts };
    } finally {
      for (const name of WATCHED) Db[name] = originals[name];
    }
  }

  async function settledCookie(userId) {
    const cookie = await loginAs(userId);
    const res = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return cookie;
  }

  test('static 200 with the session cookie touches no session or account data', async () => {
    const cookie = await settledCookie('testuser-172-static');
    const { result, counts } = await countDbCalls(() => fetch(`${baseUrl}/js/app.js`, { headers: { cookie } }));
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(counts, {});
  });

  test('304 with the session cookie touches no session or account data', async () => {
    const cookie = await settledCookie('testuser-172-304');
    const get = (headers) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: process.env.PORT, path: '/js/app.js', method: 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      });
      req.on('error', reject);
      req.end();
    });
    const first = await get({ cookie });
    const etag = first.headers.etag;
    assert.ok(etag);
    const { result, counts } = await countDbCalls(() => get({ cookie, 'if-none-match': etag }));
    assert.strictEqual(result.statusCode, 304);
    assert.deepStrictEqual(counts, {});
  });

  test('missing static asset with the session cookie touches no session or account data', async () => {
    const cookie = await settledCookie('testuser-172-missing');
    const { counts } = await countDbCalls(() => fetch(`${baseUrl}/css/non-existent-file.css`, { headers: { cookie } }));
    assert.deepStrictEqual(counts, {});
  });

  test('a repeated API request reads the session but does not write it', async () => {
    const cookie = await settledCookie('testuser-172-api');
    const { result, counts } = await countDbCalls(() => fetch(`${baseUrl}/api/accounts`, { headers: { cookie } }));
    assert.strictEqual(result.status, 200);
    assert.strictEqual(counts.getRawSession, 1, 'API requests still load the session');
    assert.strictEqual(counts.touchSession, undefined, 'a fresh session must not be re-touched on every request');
    assert.strictEqual(counts.saveSession, undefined);
    assert.strictEqual(counts.upsertUser, undefined);
  });
});

describe('Issue #172 — SqliteSessionStore.touch only writes when the expiry moved materially', () => {
  const HOUR = 60 * 60 * 1000;

  function countingDb() {
    const calls = [];
    const rows = new Map();
    return {
      calls,
      getRawSession: async (sid) => rows.get(sid) || null,
      saveSession: async (sid, userId, sess, expired) => { calls.push(['save', expired]); rows.set(sid, { sid, sess, expired }); },
      touchSession: async (sid, expired) => { calls.push(['touch', expired]); },
      deleteSession: async (sid) => { calls.push(['delete']); rows.delete(sid); },
    };
  }

  test('a touch within the throttle window after get() is not written', async () => {
    const db = countingDb();
    const store = new SqliteSessionStore({ db });
    const expires = new Date(Date.now() + 7 * 24 * HOUR);
    await store.set('s1', { cookie: { expires: expires.toISOString() }, userId: 'testuser' });
    const fresh = new SqliteSessionStore({ db });
    await fresh.get('s1');
    await fresh.touch('s1', { cookie: { expires: new Date(expires.getTime() + 5 * 60 * 1000).toISOString() } });
    assert.deepStrictEqual(db.calls.filter(([k]) => k === 'touch'), []);
  });

  test('a touch that extends the expiry by more than the window is written', async () => {
    const db = countingDb();
    const store = new SqliteSessionStore({ db });
    const expires = new Date(Date.now() + 7 * 24 * HOUR);
    await store.set('s1', { cookie: { expires: expires.toISOString() }, userId: 'testuser' });
    const later = expires.getTime() + 2 * HOUR;
    await store.touch('s1', { cookie: { expires: new Date(later).toISOString() } });
    assert.deepStrictEqual(db.calls.filter(([k]) => k === 'touch'), [['touch', later]]);
    // The written expiry becomes the new baseline.
    await store.touch('s1', { cookie: { expires: new Date(later + 60 * 1000).toISOString() } });
    assert.strictEqual(db.calls.filter(([k]) => k === 'touch').length, 1);
  });

  test('a touch for a session the store has not seen is written', async () => {
    const db = countingDb();
    const store = new SqliteSessionStore({ db });
    const expires = Date.now() + 7 * 24 * HOUR;
    await store.touch('unknown', { cookie: { expires: new Date(expires).toISOString() } });
    assert.deepStrictEqual(db.calls, [['touch', expires]]);
  });

  test('after destroy() a touch is written again', async () => {
    const db = countingDb();
    const store = new SqliteSessionStore({ db });
    const expires = Date.now() + 7 * 24 * HOUR;
    await store.set('s1', { cookie: { expires: new Date(expires).toISOString() } });
    await store.destroy('s1');
    await store.touch('s1', { cookie: { expires: new Date(expires).toISOString() } });
    assert.strictEqual(db.calls.filter(([k]) => k === 'touch').length, 1);
  });
});
