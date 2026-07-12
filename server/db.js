'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../webcalendar.db');
const db = new sqlite3.Database(dbPath);

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.ENCRYPTION_KEY || 'freeshard-default-encryption-key-do-not-use-in-prod',
  'salt',
  32
);

// Initialize table and index
db.serialize(() => {
  db.run('PRAGMA journal_mode = MEMORY');
  db.run(`
    CREATE TABLE IF NOT EXISTS linked_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      iv TEXT NOT NULL,
      display_name TEXT NOT NULL,
      auth_type TEXT DEFAULT 'basic',
      access_token TEXT,
      expires_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_passwords (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS calendar_shares (
      token TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL
    )
  `);
  // Silent migrations for existing local databases
  db.run("ALTER TABLE linked_accounts ADD COLUMN auth_type TEXT DEFAULT 'basic'", () => {});
  db.run("ALTER TABLE linked_accounts ADD COLUMN access_token TEXT", () => {});
  db.run("ALTER TABLE linked_accounts ADD COLUMN expires_at INTEGER", () => {});
  db.run(`
    UPDATE linked_accounts 
    SET url = 'https://apidata.googleusercontent.com/caldav/v2/' || replace(username, '@', '%40') || '/' 
    WHERE auth_type = 'oauth2' AND url LIKE '%/user/'
  `, () => {});
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_linked_accounts_user_id ON linked_accounts(user_id)
  `);
});

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    encrypted,
    iv: iv.toString('hex')
  };
}

function decrypt(encryptedText, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

const Db = {
  getAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM linked_accounts WHERE user_id = ?',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          try {
            const mapped = rows.map(row => ({
              id: row.id,
              url: row.url,
              username: row.username,
              password: decrypt(row.password_encrypted, row.iv), // decrypts either password or refresh_token
              displayName: row.display_name,
              authType: row.auth_type || 'basic',
              accessToken: row.access_token,
              expiresAt: row.expires_at
            }));
            resolve(mapped);
          } catch (decryptionError) {
            reject(decryptionError);
          }
        }
      );
    });
  },

  getAccountById(id) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM linked_accounts WHERE id = ?',
        [id],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          try {
            resolve({
              id: row.id,
              userId: row.user_id,
              url: row.url,
              username: row.username,
              password: decrypt(row.password_encrypted, row.iv),
              displayName: row.display_name,
              authType: row.auth_type || 'basic',
              accessToken: row.access_token,
              expiresAt: row.expires_at
            });
          } catch (decryptionError) {
            reject(decryptionError);
          }
        }
      );
    });
  },

  addAccount(userId, { url, username, password, displayName }) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const { encrypted, iv } = encrypt(password);
      db.run(
        'INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, url, username, encrypted, iv, displayName || username, 'basic'],
        (err) => {
          if (err) return reject(err);
          resolve({ id, displayName: displayName || username });
        }
      );
    });
  },

  addOAuthAccount(userId, { url, username, refreshToken, accessToken, expiresAt, displayName }) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const { encrypted, iv } = encrypt(refreshToken);
      db.run(
        'INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, url, username, encrypted, iv, displayName || username, 'oauth2', accessToken, expiresAt],
        (err) => {
          if (err) return reject(err);
          resolve({ id, displayName: displayName || username });
        }
      );
    });
  },

  updateOAuthTokens(id, { accessToken, expiresAt }) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE linked_accounts SET access_token = ?, expires_at = ? WHERE id = ?',
        [accessToken, expiresAt, id],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  updateAccountDisplayName(id, displayName) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE linked_accounts SET display_name = ? WHERE id = ?',
        [displayName, id],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  deleteAccount(id) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM linked_accounts WHERE id = ?',
        [id],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  deleteUserAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM linked_accounts WHERE user_id = ?',
        [userId],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  clearAll() {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('DELETE FROM linked_accounts');
        db.run('DELETE FROM app_passwords');
        db.run('DELETE FROM calendar_shares');
        db.run('DELETE FROM sync_queue', (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  },

  // ── App-Specific Passwords (ASPs) ──────────────────────────────────────────
  getAppPasswords(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, label, created_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({
            id: r.id,
            label: r.label,
            createdAt: r.created_at
          })));
        }
      );
    });
  },

  addAppPassword(userId, label) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const rawPassword = crypto.randomBytes(16).toString('hex'); // 32 hex chars, high entropy
      const passwordHash = crypto.createHash('sha256').update(rawPassword).digest('hex');
      const now = Date.now();

      db.run(
        'INSERT INTO app_passwords (id, user_id, label, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, userId, label, passwordHash, now],
        (err) => {
          if (err) return reject(err);
          resolve({ id, label, rawPassword, createdAt: now });
        }
      );
    });
  },

  deleteAppPassword(id) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM app_passwords WHERE id = ?', [id], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  },

  // ── Multiple Public Shares (Token-based) ───────────────────────────────────
  getCalendarShares(calendarId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT token, label, created_at FROM calendar_shares WHERE calendar_id = ? ORDER BY created_at DESC',
        [calendarId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({
            token: r.token,
            label: r.label,
            createdAt: r.created_at
          })));
        }
      );
    });
  },

  addCalendarShare(calendarId, label) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(24).toString('hex'); // unique random path token
      const now = Date.now();

      db.run(
        'INSERT INTO calendar_shares (token, calendar_id, label, created_at) VALUES (?, ?, ?, ?)',
        [token, calendarId, label, now],
        (err) => {
          if (err) return reject(err);
          resolve({ token, calendarId, label, createdAt: now });
        }
      );
    });
  },

  deleteCalendarShare(token) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM calendar_shares WHERE token = ?', [token], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  },

  // ── Sync Queue (vdirsyncer jobs) ───────────────────────────────────────────
  addSyncJob(userId) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const id = uuidv4();
      
      // Use SQLite UPSERT or simple REPLACE since sync_queue table is small.
      // We enforce unique user_id by running a DELETE first or doing a manual check.
      db.serialize(() => {
        db.run('DELETE FROM sync_queue WHERE user_id = ? AND status = "PENDING"', [userId]);
        db.run(
          'INSERT INTO sync_queue (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [id, userId, 'PENDING', now, now],
          (err) => {
            if (err) return reject(err);
            resolve({ id, userId, status: 'PENDING' });
          }
        );
      });
    });
  },

  upsertUser(userId, username) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT OR REPLACE INTO users (user_id, username) VALUES (?, ?)',
        [userId, username],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  searchUsers(query) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT user_id, username FROM users WHERE username LIKE ? LIMIT 10',
        [`%${query}%`],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            displayname: row.username,
            email: row.username,
            href: `/${row.user_id}/`
          })));
        }
      );
    });
  }
};

module.exports = Db;
