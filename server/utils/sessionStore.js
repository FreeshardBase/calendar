'use strict';

/**
 * Issue #35 — Refactor Express session storage to support user-indexed session invalidation
 *
 * Custom Express Session Store backed by SQLite with user-indexed session tracking.
 * Enables invalidation of all sessions associated with a specific user ID (`destroyUserSessions`).
 */

const session = require('express-session');
const Db = require('../db');

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.db = options.db || Db;
  }

  get(sid, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const promise = this.db.getRawSession(sid).then((row) => {
      if (!row) {
        cb(null, null);
        return null;
      }
      if (row.expired && row.expired < Date.now()) {
        return this.db.deleteSession(sid).then(() => {
          cb(null, null);
          return null;
        }).catch(() => {
          cb(null, null);
          return null;
        });
      }
      try {
        const sess = JSON.parse(row.sess);
        cb(null, sess);
        return sess;
      } catch (err) {
        cb(err);
        return null;
      }
    }).catch((err) => {
      cb(err);
      return null;
    });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }

  set(sid, sessionData, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const userId = sessionData.userId || sessionData.user?.id || (sessionData.passport && sessionData.passport.user) || null;
    let expired;
    if (sessionData.cookie && sessionData.cookie.expires) {
      expired = new Date(sessionData.cookie.expires).getTime();
    } else if (sessionData.cookie && sessionData.cookie.maxAge) {
      expired = Date.now() + sessionData.cookie.maxAge;
    } else {
      expired = Date.now() + 7 * 24 * 60 * 60 * 1000;
    }

    const promise = this.db.saveSession(sid, userId, JSON.stringify(sessionData), expired)
      .then(() => {
        cb(null);
        return true;
      })
      .catch((err) => {
        cb(err);
        return false;
      });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }

  destroy(sid, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const promise = this.db.deleteSession(sid)
      .then(() => {
        cb(null);
        return true;
      })
      .catch((err) => {
        cb(err);
        return false;
      });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }

  touch(sid, sessionData, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    let expired;
    if (sessionData.cookie && sessionData.cookie.expires) {
      expired = new Date(sessionData.cookie.expires).getTime();
    } else if (sessionData.cookie && sessionData.cookie.maxAge) {
      expired = Date.now() + sessionData.cookie.maxAge;
    } else {
      expired = Date.now() + 7 * 24 * 60 * 60 * 1000;
    }

    const promise = this.db.touchSession(sid, expired)
      .then(() => {
        cb(null);
        return true;
      })
      .catch((err) => {
        cb(err);
        return false;
      });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }

  destroyUserSessions(userId, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const promise = this.db.deleteSessionsForUser(userId)
      .then((count) => {
        cb(null, count);
        return count;
      })
      .catch((err) => {
        cb(err);
        return 0;
      });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }

  getUserSessions(userId, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const promise = this.db.getSessionsForUser(userId)
      .then((rows) => {
        const sessions = (rows || []).map((r) => {
          try {
            return { sid: r.sid, expired: r.expired, data: JSON.parse(r.sess) };
          } catch {
            return { sid: r.sid, expired: r.expired, data: null };
          }
        });
        cb(null, sessions);
        return sessions;
      })
      .catch((err) => {
        cb(err);
        return [];
      });

    if (typeof callback === 'function') {
      promise.catch(() => {});
    }
    return promise;
  }
}

module.exports = {
  SqliteSessionStore
};
