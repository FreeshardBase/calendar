'use strict';

/**
 * Issue #35 — Refactor Express session storage to support user-indexed session invalidation
 *
 * Custom Express Session Store backed by SQLite with user-indexed session tracking.
 * Enables invalidation of all sessions associated with a specific user ID (`destroyUserSessions`).
 */

const session = require('express-session');
const Db = require('../db');

// express-session's callback contract on top of a promise. Errors are never swallowed: with a
// callback they are passed to it, without one the returned promise rejects (#343).
function settle(promise, callback) {
  if (typeof callback === 'function') {
    promise.then((value) => callback(null, value), (err) => callback(err));
  }
  return promise;
}

function expiryOf(sessionData) {
  if (sessionData.cookie && sessionData.cookie.expires) {
    return new Date(sessionData.cookie.expires).getTime();
  }
  if (sessionData.cookie && sessionData.cookie.maxAge) {
    return Date.now() + sessionData.cookie.maxAge;
  }
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}

// #172: express-session calls touch() on every request it does not save, and each touch would be
// a committed, fsynced UPDATE. The stored expiry is only rewritten once it lags by this much.
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.db = options.db || Db;
    // sid -> expiry as last read from or written to the database.
    this.storedExpiry = new Map();
  }

  get(sid, callback) {
    const promise = this.db.getRawSession(sid).then(async (row) => {
      if (!row) {
        this.storedExpiry.delete(sid);
        return null;
      }
      if (row.expired && row.expired < Date.now()) {
        this.storedExpiry.delete(sid);
        await this.db.deleteSession(sid);
        return null;
      }
      const data = JSON.parse(row.sess);
      this.storedExpiry.set(sid, row.expired);
      return data;
    });
    return settle(promise, callback);
  }

  set(sid, sessionData, callback) {
    const userId = sessionData.userId || sessionData.user?.id || (sessionData.passport && sessionData.passport.user) || null;
    const expiry = expiryOf(sessionData);
    const promise = this.db.saveSession(sid, userId, JSON.stringify(sessionData), expiry)
      .then(() => {
        // Sessions that simply expire are never destroyed; drop their entries here.
        const now = Date.now();
        for (const [knownSid, knownExpiry] of this.storedExpiry) {
          if (knownExpiry < now) this.storedExpiry.delete(knownSid);
        }
        this.storedExpiry.set(sid, expiry);
        return true;
      });
    return settle(promise, callback);
  }

  destroy(sid, callback) {
    this.storedExpiry.delete(sid);
    return settle(this.db.deleteSession(sid).then(() => true), callback);
  }

  touch(sid, sessionData, callback) {
    const expiry = expiryOf(sessionData);
    const stored = this.storedExpiry.get(sid);
    if (stored !== undefined && Math.abs(expiry - stored) < TOUCH_THROTTLE_MS) {
      return settle(Promise.resolve(true), callback);
    }
    const promise = this.db.touchSession(sid, expiry).then(() => {
      this.storedExpiry.set(sid, expiry);
      return true;
    });
    return settle(promise, callback);
  }

  destroyUserSessions(userId, callback) {
    // The deleted sids are unknown here; a stale entry only lets a later touch() of a session
    // that no longer exists skip a no-op UPDATE, and get() of such a sid clears it.
    return settle(this.db.deleteSessionsForUser(userId), callback);
  }

  getUserSessions(userId, callback) {
    const promise = this.db.getSessionsForUser(userId).then((rows) => (rows || []).map((r) => {
      let data;
      try {
        data = JSON.parse(r.sess);
      } catch (err) {
        // A corrupt row is still listed (without data) so that it can be destroyed.
        if (!(err instanceof SyntaxError)) throw err;
        data = null;
      }
      return { sid: r.sid, expired: r.expired, data };
    }));
    return settle(promise, callback);
  }
}

module.exports = {
  SqliteSessionStore
};
