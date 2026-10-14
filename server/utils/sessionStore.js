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

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.db = options.db || Db;
  }

  get(sid, callback) {
    const promise = this.db.getRawSession(sid).then(async (row) => {
      if (!row) return null;
      if (row.expired && row.expired < Date.now()) {
        await this.db.deleteSession(sid);
        return null;
      }
      return JSON.parse(row.sess);
    });
    return settle(promise, callback);
  }

  set(sid, sessionData, callback) {
    const userId = sessionData.userId || sessionData.user?.id || (sessionData.passport && sessionData.passport.user) || null;
    const promise = this.db.saveSession(sid, userId, JSON.stringify(sessionData), expiryOf(sessionData))
      .then(() => true);
    return settle(promise, callback);
  }

  destroy(sid, callback) {
    return settle(this.db.deleteSession(sid).then(() => true), callback);
  }

  touch(sid, sessionData, callback) {
    return settle(this.db.touchSession(sid, expiryOf(sessionData)).then(() => true), callback);
  }

  destroyUserSessions(userId, callback) {
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
