'use strict';

/**
 * Issue #35 — Refactor Express session storage to support user-indexed session invalidation
 *
 * Verification suite for SQLite-backed Express Session Store with user-indexed session invalidation:
 *   1. Database schema and CRUD methods for `sessions` table (`saveSession`, `getRawSession`, `deleteSession`, `deleteSessionsForUser`, `getSessionsForUser`).
 *   2. `SqliteSessionStore` extending `express-session.Store` implementing standard callback & promise methods.
 *   3. `store.destroyUserSessions(userId)` invalidates ALL active sessions for a specific user ID while leaving other user sessions intact.
 *   4. Expired session eviction handling in `get` and `clearExpiredSessions`.
 *   5. `getSessionConfig()` integration in `server/utils/sessionConfig.js` utilizing `SqliteSessionStore`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { SqliteSessionStore } = require('../utils/sessionStore');
const { getSessionConfig } = require('../utils/sessionConfig');

test.describe('Issue #35 — Refactor Express session storage for user-indexed session invalidation', () => {

  test('Database helper methods for sessions table', async () => {
    const sid1 = 'test-sid-db-1';
    const sid2 = 'test-sid-db-2';
    const userId1 = 'user-db-alpha';
    const userId2 = 'user-db-beta';
    const sessData1 = { userId: userId1, role: 'admin' };
    const sessData2 = { userId: userId2, role: 'user' };
    const expiresMs = Date.now() + 3600000; // +1h

    // Clean up test sids if existing
    await Db.deleteSession(sid1);
    await Db.deleteSession(sid2);

    // Save sessions
    await Db.saveSession(sid1, userId1, JSON.stringify(sessData1), expiresMs);
    await Db.saveSession(sid2, userId2, JSON.stringify(sessData2), expiresMs);

    // Get raw session
    const fetched1 = await Db.getRawSession(sid1);
    assert.ok(fetched1, 'Raw session 1 should exist');
    assert.equal(fetched1.sid, sid1);
    assert.equal(fetched1.user_id, userId1);
    assert.deepEqual(JSON.parse(fetched1.sess), sessData1);

    // Get sessions for user
    const user1Sessions = await Db.getSessionsForUser(userId1);
    assert.equal(user1Sessions.length, 1);
    assert.equal(user1Sessions[0].sid, sid1);

    // Delete sessions for user 1
    await Db.deleteSessionsForUser(userId1);

    const fetched1After = await Db.getRawSession(sid1);
    assert.equal(fetched1After, null, 'Session 1 should be deleted');

    const fetched2After = await Db.getRawSession(sid2);
    assert.ok(fetched2After, 'Session 2 for user 2 should remain intact');

    // Clean up
    await Db.deleteSession(sid2);
  });

  test('SqliteSessionStore set, get, touch, and destroy', (t, done) => {
    const store = new SqliteSessionStore();
    const sid = 'test-sid-store-1';
    const userId = 'user-store-1';
    const sessData = { cookie: { maxAge: 3600000 }, userId: userId, theme: 'dark' };

    store.set(sid, sessData, (err) => {
      assert.ifError(err);

      store.get(sid, (err, fetchedSess) => {
        assert.ifError(err);
        assert.ok(fetchedSess);
        assert.equal(fetchedSess.userId, userId);
        assert.equal(fetchedSess.theme, 'dark');

        store.touch(sid, sessData, (err) => {
          assert.ifError(err);

          store.destroy(sid, (err) => {
            assert.ifError(err);
            store.get(sid, (err, res) => {
              assert.ifError(err);
              assert.equal(res, null);
              done();
            });
          });
        });
      });
    });
  });

  test('SqliteSessionStore.destroyUserSessions invalidates all sessions for target user only', async () => {
    const store = new SqliteSessionStore();
    const userA = 'user-multi-session-A';
    const userB = 'user-multi-session-B';

    const sidA1 = 'sid-A1';
    const sidA2 = 'sid-A2';
    const sidB1 = 'sid-B1';

    await store.set(sidA1, { cookie: { maxAge: 3600000 }, userId: userA, client: 'desktop' });
    await store.set(sidA2, { cookie: { maxAge: 3600000 }, userId: userA, client: 'mobile' });
    await store.set(sidB1, { cookie: { maxAge: 3600000 }, userId: userB, client: 'desktop' });

    // Verify userA has 2 active sessions
    const userASessionsBefore = await store.getUserSessions(userA);
    assert.equal(userASessionsBefore.length, 2);

    // Perform user-indexed session invalidation for userA
    await store.destroyUserSessions(userA);

    // Verify userA has 0 sessions now
    const userASessionsAfter = await store.getUserSessions(userA);
    assert.equal(userASessionsAfter.length, 0);

    const getA1 = await new Promise(res => store.get(sidA1, (err, data) => res(data)));
    assert.equal(getA1, null, 'Session A1 should be invalidated');

    const getA2 = await new Promise(res => store.get(sidA2, (err, data) => res(data)));
    assert.equal(getA2, null, 'Session A2 should be invalidated');

    // Verify userB session is completely unaffected
    const getB1 = await new Promise(res => store.get(sidB1, (err, data) => res(data)));
    assert.ok(getB1, 'Session B1 should remain valid');
    assert.equal(getB1.userId, userB);

    // Clean up
    await store.destroy(sidB1);
  });

  test('Expired session handling in SqliteSessionStore', async () => {
    const store = new SqliteSessionStore();
    const sid = 'expired-sid-1';

    // Set session with expired timestamp (-10 seconds)
    const expiredData = { cookie: { maxAge: -10000 }, userId: 'user-expired' };
    await store.set(sid, expiredData);

    // get() should evict expired session and return null
    const getRes = await new Promise(res => store.get(sid, (err, data) => res(data)));
    assert.equal(getRes, null, 'Expired session should return null');

    const raw = await Db.getRawSession(sid);
    assert.equal(raw, null, 'Expired session should be evicted from database');
  });

  test('getSessionConfig provides configured SqliteSessionStore', () => {
    const config = getSessionConfig();
    assert.ok(config.store, 'session config should contain a custom store');
    assert.ok(config.store instanceof SqliteSessionStore, 'session config store must be an instance of SqliteSessionStore');
  });

});
