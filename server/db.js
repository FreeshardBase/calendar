'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../webcalendar.db');
const db = new sqlite3.Database(dbPath);

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_SECRET || 'freeshard-default-encryption-key-do-not-use-in-prod',
  'salt',
  32
);

// Initialize table and index
db.serialize(() => {
  // WAL: the DB file is shared with the Radicale plugins and the sync-worker;
  // a MEMORY journal would risk corruption on concurrent multi-process writes.
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
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
  db.run(`
    CREATE TABLE IF NOT EXISTS user_calendar_shares (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      sharee_user_id TEXT NOT NULL,
      read_write INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(calendar_id, sharee_user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS calendar_sync_cache (
      calendar_id TEXT PRIMARY KEY,
      ctag TEXT,
      sync_token TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS msgraph_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT DEFAULT 'common',
      client_id TEXT,
      account_email TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      delta_link TEXT,
      target_calendar_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS msgraph_event_mappings (
      local_uid TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      last_synced_at INTEGER NOT NULL,
      e_tag TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ROOM',
      capacity INTEGER NOT NULL DEFAULT 1,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS resource_bookings (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      event_uid TEXT,
      user_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS availability_pages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      start_hour INTEGER NOT NULL DEFAULT 9,
      end_hour INTEGER NOT NULL DEFAULT 17,
      days_of_week TEXT NOT NULL DEFAULT '1,2,3,4,5',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS slot_bookings (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      guest_name TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      notes TEXT,
      event_uid TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS delegate_permissions (
      id TEXT PRIMARY KEY,
      principal_user_id TEXT NOT NULL,
      delegate_user_id TEXT NOT NULL,
      calendar_id TEXT,
      role TEXT NOT NULL DEFAULT 'DELEGATE_WRITE',
      can_manage_invitations INTEGER NOT NULL DEFAULT 1,
      can_view_private INTEGER NOT NULL DEFAULT 0,
      can_manage_delegates INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(principal_user_id, delegate_user_id, calendar_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS working_hours_policy (
      user_id TEXT PRIMARY KEY,
      start_hour INTEGER NOT NULL DEFAULT 9,
      end_hour INTEGER NOT NULL DEFAULT 17,
      work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
      auto_decline INTEGER NOT NULL DEFAULT 0,
      ooo_enabled INTEGER NOT NULL DEFAULT 0,
      ooo_start TEXT,
      ooo_end TEXT,
      ooo_message TEXT DEFAULT 'Out of Office / Abwesend',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cross_user_deletions (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      deleted_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
        db.run('DELETE FROM availability_pages');
        db.run('DELETE FROM slot_bookings');
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

  getCalendarShareByToken(token) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM calendar_shares WHERE token = ?', [token], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  },

  deleteCalendarShare(token, calendarId) {
    return new Promise((resolve, reject) => {
      let sql = 'DELETE FROM calendar_shares WHERE token = ?';
      let params = [token];
      if (calendarId) {
        sql += ' AND calendar_id = ?';
        params.push(calendarId);
      }
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this.changes);
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
        db.run('DELETE FROM sync_queue WHERE user_id = ? AND status = "PENDING"', [userId], (err) => {
          if (err) return reject(err);
          db.run(
            'INSERT INTO sync_queue (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [id, userId, 'PENDING', now, now],
            (err) => {
              if (err) return reject(err);
              resolve({ id, userId, status: 'PENDING', createdAt: now, updatedAt: now });
            }
          );
        });
      });
    });
  },

  getSyncJobs(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, user_id, status, error_message, created_at, updated_at FROM sync_queue WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            status: row.status,
            errorMessage: row.error_message,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          })));
        }
      );
    });
  },

  getPendingSyncJobs() {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, user_id, status, error_message, created_at, updated_at FROM sync_queue WHERE status = "PENDING" ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            status: row.status,
            errorMessage: row.error_message,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          })));
        }
      );
    });
  },

  updateSyncJobStatus(id, status, errorMessage = null) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        'UPDATE sync_queue SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [status, errorMessage, now, id],
        function (err) {
          if (err) return reject(err);
          resolve({ id, status, errorMessage, updatedAt: now, changes: this.changes });
        }
      );
    });
  },

  clearSyncJobsForUser(userId) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM sync_queue WHERE user_id = ? OR user_id LIKE ?', [userId, `${userId}%`], (err) => {
        if (err) return reject(err);
        resolve();
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
            href: row.username
          })));
        }
      );
    });
  },

  getUserShares(calendarId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT s.sharee_user_id, s.read_write, u.username
         FROM user_calendar_shares s
         LEFT JOIN users u ON s.sharee_user_id = u.user_id
         WHERE s.calendar_id = ?`,
        [calendarId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            href: `/${row.sharee_user_id}/`,
            commonName: row.username || row.sharee_user_id,
            readWrite: !!row.read_write,
            status: 'ACCEPTED'
          })));
        }
      );
    });
  },

  addUserShare(calendarId, shareeUserId, readWrite) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO user_calendar_shares (id, calendar_id, sharee_user_id, read_write, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, calendarId, shareeUserId, readWrite ? 1 : 0, now],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  removeUserShare(calendarId, shareeUserId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM user_calendar_shares WHERE calendar_id = ? AND sharee_user_id = ?`,
        [calendarId, shareeUserId],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  getSharedCalendarsForUser(shareeUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT calendar_id, read_write FROM user_calendar_shares WHERE sharee_user_id = ?`,
        [shareeUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });
  },

  getUsernameByUserId(userId) {
    return new Promise((resolve) => {
      db.get('SELECT username FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err || !row) return resolve(userId);
        resolve(row.username);
      });
    });
  },

  getUserIdByUsername(username) {
    return new Promise((resolve) => {
      db.get(
        'SELECT user_id FROM users WHERE username = ? OR user_id = ? OR username LIKE ?',
        [username, username, `${username}@%`],
        (err, row) => {
          if (err || !row) return resolve(null);
          resolve(row.user_id);
        }
      );
    });
  },

  getCalendarSyncCache(calendarId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT calendar_id, ctag, sync_token, updated_at FROM calendar_sync_cache WHERE calendar_id = ?', [calendarId], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({
          calendarId: row.calendar_id,
          ctag: row.ctag,
          syncToken: row.sync_token,
          updatedAt: row.updated_at
        });
      });
    });
  },

  upsertCalendarSyncCache(calendarId, ctag, syncToken) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO calendar_sync_cache (calendar_id, ctag, sync_token, updated_at) VALUES (?, ?, ?, ?)`,
        [calendarId, ctag, syncToken, now],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  addMSGraphAccount(accountData) {
    return new Promise((resolve, reject) => {
      const id = accountData.id || uuidv4();
      const now = Date.now();
      db.run(
        `INSERT INTO msgraph_accounts 
         (id, user_id, tenant_id, client_id, account_email, access_token, refresh_token, expires_at, delta_link, target_calendar_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          accountData.userId,
          accountData.tenantId || 'common',
          accountData.clientId || '',
          accountData.accountEmail,
          accountData.accessToken || '',
          accountData.refreshToken || '',
          accountData.expiresAt || 0,
          accountData.deltaLink || '',
          accountData.targetCalendarId || '',
          now,
          now
        ],
        (err) => {
          if (err) return reject(err);
          resolve({ id, ...accountData, createdAt: now, updatedAt: now });
        }
      );
    });
  },

  getMSGraphAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, tenant_id, client_id, account_email, access_token, refresh_token, expires_at, delta_link, target_calendar_id, created_at, updated_at
         FROM msgraph_accounts WHERE user_id = ? ORDER BY created_at ASC`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            tenantId: r.tenant_id,
            clientId: r.client_id,
            accountEmail: r.account_email,
            accessToken: r.access_token,
            refreshToken: r.refresh_token,
            expiresAt: r.expires_at,
            deltaLink: r.delta_link,
            targetCalendarId: r.target_calendar_id,
            createdAt: r.created_at,
            updatedAt: r.updated_at
          })));
        }
      );
    });
  },

  getMSGraphAccountById(accountId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, user_id, tenant_id, client_id, account_email, access_token, refresh_token, expires_at, delta_link, target_calendar_id, created_at, updated_at
         FROM msgraph_accounts WHERE id = ?`,
        [accountId],
        (err, r) => {
          if (err) return reject(err);
          if (!r) return resolve(null);
          resolve({
            id: r.id,
            userId: r.user_id,
            tenantId: r.tenant_id,
            clientId: r.client_id,
            accountEmail: r.account_email,
            accessToken: r.access_token,
            refreshToken: r.refresh_token,
            expiresAt: r.expires_at,
            deltaLink: r.delta_link,
            targetCalendarId: r.target_calendar_id,
            createdAt: r.created_at,
            updatedAt: r.updated_at
          });
        }
      );
    });
  },

  updateMSGraphAccount(accountId, updates) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const fields = [];
      const values = [];

      if (updates.accessToken !== undefined) { fields.push('access_token = ?'); values.push(updates.accessToken); }
      if (updates.refreshToken !== undefined) { fields.push('refresh_token = ?'); values.push(updates.refreshToken); }
      if (updates.expiresAt !== undefined) { fields.push('expires_at = ?'); values.push(updates.expiresAt); }
      if (updates.deltaLink !== undefined) { fields.push('delta_link = ?'); values.push(updates.deltaLink); }
      if (updates.targetCalendarId !== undefined) { fields.push('target_calendar_id = ?'); values.push(updates.targetCalendarId); }
      
      fields.push('updated_at = ?');
      values.push(now);
      values.push(accountId);

      db.run(
        `UPDATE msgraph_accounts SET ${fields.join(', ')} WHERE id = ?`,
        values,
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  deleteMSGraphAccount(accountId) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM msgraph_accounts WHERE id = ?`, [accountId], (err) => {
        if (err) return reject(err);
        db.run(`DELETE FROM msgraph_event_mappings WHERE account_id = ?`, [accountId], () => {
          resolve();
        });
      });
    });
  },

  upsertMSGraphEventMapping(localUid, graphId, accountId, eTag) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at, e_tag)
         VALUES (?, ?, ?, ?, ?)`,
        [localUid, graphId, accountId, now, eTag || ''],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  getMSGraphEventMapping(localUid) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT local_uid, graph_id, account_id, last_synced_at, e_tag FROM msgraph_event_mappings WHERE local_uid = ?`,
        [localUid],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          resolve({
            localUid: row.local_uid,
            graphId: row.graph_id,
            accountId: row.account_id,
            lastSyncedAt: row.last_synced_at,
            eTag: row.e_tag
          });
        }
      );
    });
  },

  getMSGraphEventMappingByGraphId(graphId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT local_uid, graph_id, account_id, last_synced_at, e_tag FROM msgraph_event_mappings WHERE graph_id = ?`,
        [graphId],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          resolve({
            localUid: row.local_uid,
            graphId: row.graph_id,
            accountId: row.account_id,
            lastSyncedAt: row.last_synced_at,
            eTag: row.e_tag
          });
        }
      );
    });
  },

  deleteMSGraphEventMapping(localUid) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM msgraph_event_mappings WHERE local_uid = ?`, [localUid], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  },

  addResource({ id, name, type = 'ROOM', capacity = 1, location = '', status = 'AVAILABLE' }) {
    return new Promise((resolve, reject) => {
      const resId = id || `res-${uuidv4()}`;
      const now = Date.now();
      db.run(
        `INSERT INTO resources (id, name, type, capacity, location, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [resId, name, type, capacity, location, status, now],
        (err) => {
          if (err) return reject(err);
          resolve({ id: resId, name, type, capacity, location, status, createdAt: now });
        }
      );
    });
  },

  getResources({ type, minCapacity, status } = {}) {
    return new Promise((resolve, reject) => {
      const conditions = [];
      const params = [];

      if (type) { conditions.push('type = ?'); params.push(type); }
      if (minCapacity) { conditions.push('capacity >= ?'); params.push(minCapacity); }
      if (status) { conditions.push('status = ?'); params.push(status); }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      db.all(`SELECT id, name, type, capacity, location, status, created_at FROM resources ${whereClause} ORDER BY name ASC`, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          capacity: r.capacity,
          location: r.location,
          status: r.status,
          createdAt: r.created_at
        })));
      });
    });
  },

  getResourceById(id) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT id, name, type, capacity, location, status, created_at FROM resources WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({
          id: row.id,
          name: row.name,
          type: row.type,
          capacity: row.capacity,
          location: row.location,
          status: row.status,
          createdAt: row.created_at
        });
      });
    });
  },

  updateResource(id, fields = {}) {
    return new Promise((resolve, reject) => {
      const updates = [];
      const params = [];
      if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
      if (fields.type !== undefined) { updates.push('type = ?'); params.push(fields.type); }
      if (fields.capacity !== undefined) { updates.push('capacity = ?'); params.push(fields.capacity); }
      if (fields.location !== undefined) { updates.push('location = ?'); params.push(fields.location); }
      if (fields.status !== undefined) { updates.push('status = ?'); params.push(fields.status); }

      if (updates.length === 0) return resolve(this.getResourceById(id));
      params.push(id);

      db.run(`UPDATE resources SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) return reject(err);
        Db.getResourceById(id).then(resolve).catch(reject);
      });
    });
  },

  deleteResource(id) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM resources WHERE id = ?`, [id], (err) => {
        if (err) return reject(err);
        db.run(`DELETE FROM resource_bookings WHERE resource_id = ?`, [id], () => {
          resolve();
        });
      });
    });
  },

  checkResourceAvailability(resourceId, startTime, endTime, excludeBookingId = null) {
    return new Promise((resolve, reject) => {
      const params = [resourceId, endTime, startTime];
      let sql = `SELECT id, resource_id, event_uid, user_id, start_time, end_time, status, created_at 
                 FROM resource_bookings 
                 WHERE resource_id = ? AND status = 'CONFIRMED' AND start_time < ? AND end_time > ?`;
      if (excludeBookingId) {
        sql += ` AND id != ?`;
        params.push(excludeBookingId);
      }
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        if (row) {
          resolve({
            available: false,
            conflictingBooking: {
              id: row.id,
              resourceId: row.resource_id,
              eventUid: row.event_uid,
              userId: row.user_id,
              startTime: row.start_time,
              endTime: row.end_time,
              status: row.status,
              createdAt: row.created_at
            }
          });
        } else {
          resolve({ available: true, conflictingBooking: null });
        }
      });
    });
  },

  createResourceBooking({ id, resourceId, eventUid = null, userId, startTime, endTime }) {
    return new Promise(async (resolve, reject) => {
      try {
        const check = await Db.checkResourceAvailability(resourceId, startTime, endTime);
        if (!check.available) {
          return reject(new Error('RESOURCE_BUSY: Der Raum/die Ressource ist im gewählten Zeitraum bereits belegt.'));
        }
        const bookingId = id || `bk-${uuidv4()}`;
        const now = Date.now();
        db.run(
          `INSERT INTO resource_bookings (id, resource_id, event_uid, user_id, start_time, end_time, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?)`,
          [bookingId, resourceId, eventUid, userId, startTime, endTime, now],
          (err) => {
            if (err) return reject(err);
            resolve({
              id: bookingId,
              resourceId,
              eventUid,
              userId,
              startTime,
              endTime,
              status: 'CONFIRMED',
              createdAt: now
            });
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  },

  getResourceBookings({ resourceId, userId, startTime, endTime } = {}) {
    return new Promise((resolve, reject) => {
      const conditions = [];
      const params = [];
      if (resourceId) { conditions.push('resource_id = ?'); params.push(resourceId); }
      if (userId) { conditions.push('user_id = ?'); params.push(userId); }
      if (startTime) { conditions.push('end_time > ?'); params.push(startTime); }
      if (endTime) { conditions.push('start_time < ?'); params.push(endTime); }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      db.all(`SELECT id, resource_id, event_uid, user_id, start_time, end_time, status, created_at FROM resource_bookings ${whereClause} ORDER BY start_time ASC`, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => ({
          id: r.id,
          resourceId: r.resource_id,
          eventUid: r.event_uid,
          userId: r.user_id,
          startTime: r.start_time,
          endTime: r.end_time,
          status: r.status,
          createdAt: r.created_at
        })));
      });
    });
  },

  cancelResourceBooking(id, userId = null) {
    return new Promise((resolve, reject) => {
      const params = [id];
      let sql = `UPDATE resource_bookings SET status = 'CANCELLED' WHERE (id = ? OR event_uid = ?)`;
      params.push(id);
      if (userId) {
        sql += ` AND user_id = ?`;
        params.push(userId);
      }
      db.run(sql, params, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  },

  // ── Availability Slots Booking Engine ──────────────────────────────────
  createAvailabilityPage({ id, userId, slug, title, calendarId, durationMinutes = 30, startHour = 9, endHour = 17, daysOfWeek = '1,2,3,4,5' }) {
    return new Promise((resolve, reject) => {
      const pageId = id || `ap-${uuidv4()}`;
      const now = Date.now();
      db.run(
        `INSERT INTO availability_pages (id, user_id, slug, title, calendar_id, duration_minutes, start_hour, end_hour, days_of_week, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pageId, userId, slug, title, calendarId, durationMinutes, startHour, endHour, daysOfWeek, now],
        (err) => {
          if (err) return reject(err);
          resolve({
            id: pageId,
            userId,
            slug,
            title,
            calendarId,
            durationMinutes,
            startHour,
            endHour,
            daysOfWeek,
            createdAt: now
          });
        }
      );
    });
  },

  getAvailabilityPages(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, slug, title, calendar_id, duration_minutes, start_hour, end_hour, days_of_week, created_at
         FROM availability_pages WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            slug: r.slug,
            title: r.title,
            calendarId: r.calendar_id,
            durationMinutes: r.duration_minutes,
            startHour: r.start_hour,
            endHour: r.end_hour,
            daysOfWeek: r.days_of_week,
            createdAt: r.created_at
          })));
        }
      );
    });
  },

  getAvailabilityPageBySlug(slug) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, user_id, slug, title, calendar_id, duration_minutes, start_hour, end_hour, days_of_week, created_at
         FROM availability_pages WHERE slug = ?`,
        [slug],
        (err, r) => {
          if (err) return reject(err);
          if (!r) return resolve(null);
          resolve({
            id: r.id,
            userId: r.user_id,
            slug: r.slug,
            title: r.title,
            calendarId: r.calendar_id,
            durationMinutes: r.duration_minutes,
            startHour: r.start_hour,
            endHour: r.end_hour,
            daysOfWeek: r.days_of_week,
            createdAt: r.created_at
          });
        }
      );
    });
  },

  deleteAvailabilityPage(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM availability_pages WHERE id = ? AND user_id = ?`,
        [id, userId],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  createSlotBooking({ id, pageId, guestName, guestEmail, startTime, endTime, notes = '', eventUid = null }) {
    return new Promise((resolve, reject) => {
      const bookingId = id || `sb-${uuidv4()}`;
      const now = Date.now();
      db.run(
        `INSERT INTO slot_bookings (id, page_id, guest_name, guest_email, start_time, end_time, notes, event_uid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bookingId, pageId, guestName, guestEmail, startTime, endTime, notes, eventUid, now],
        (err) => {
          if (err) return reject(err);
          resolve({
            id: bookingId,
            pageId,
            guestName,
            guestEmail,
            startTime,
            endTime,
            notes,
            eventUid,
            createdAt: now
          });
        }
      );
    });
  },

  getSlotBookingsForPage(pageId, dateStr = null) {
    return new Promise((resolve, reject) => {
      let sql = `SELECT id, page_id, guest_name, guest_email, start_time, end_time, notes, event_uid, created_at FROM slot_bookings WHERE page_id = ?`;
      const params = [pageId];
      if (dateStr) {
        sql += ` AND start_time LIKE ?`;
        params.push(`${dateStr}%`);
      }
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => ({
          id: r.id,
          pageId: r.page_id,
          guestName: r.guest_name,
          guestEmail: r.guest_email,
          startTime: r.start_time,
          endTime: r.end_time,
          notes: r.notes,
          eventUid: r.event_uid,
          createdAt: r.created_at
        })));
      });
    });
  },

  upsertDelegatePermission({ id, principalUserId, delegateUserId, calendarId = null, role = 'DELEGATE_WRITE', canManageInvitations = 1, canViewPrivate = 0, canManageDelegates = 0 }) {
    return new Promise((resolve, reject) => {
      const calId = calendarId || null;
      db.get(
        `SELECT id FROM delegate_permissions WHERE principal_user_id = ? AND delegate_user_id = ? AND (calendar_id IS ? OR calendar_id = ?)`,
        [principalUserId, delegateUserId, calId, calId],
        (err, existing) => {
          if (err) return reject(err);
          const permId = id || (existing ? existing.id : `del-${uuidv4()}`);
          const now = Date.now();
          db.run(
            `INSERT INTO delegate_permissions (id, principal_user_id, delegate_user_id, calendar_id, role, can_manage_invitations, can_view_private, can_manage_delegates, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(principal_user_id, delegate_user_id, calendar_id) DO UPDATE SET
               role = excluded.role,
               can_manage_invitations = excluded.can_manage_invitations,
               can_view_private = excluded.can_view_private,
               can_manage_delegates = excluded.can_manage_delegates`,
            [permId, principalUserId, delegateUserId, calId, role, canManageInvitations ? 1 : 0, canViewPrivate ? 1 : 0, canManageDelegates ? 1 : 0, now],
            function(err) {
              if (err) return reject(err);
              resolve({
                id: permId,
                principal_user_id: principalUserId,
                delegate_user_id: delegateUserId,
                calendar_id: calId,
                role,
                can_manage_invitations: canManageInvitations ? 1 : 0,
                can_view_private: canViewPrivate ? 1 : 0,
                can_manage_delegates: canManageDelegates ? 1 : 0,
                created_at: now
              });
            }
          );
        }
      );
    });
  },

  getDelegatesForPrincipal(principalUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, principal_user_id, delegate_user_id, calendar_id, role, can_manage_invitations, can_view_private, can_manage_delegates, created_at
         FROM delegate_permissions WHERE principal_user_id = ? ORDER BY created_at DESC`,
        [principalUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  getPrincipalsForDelegate(delegateUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, principal_user_id, delegate_user_id, calendar_id, role, can_manage_invitations, can_view_private, can_manage_delegates, created_at
         FROM delegate_permissions WHERE delegate_user_id = ? ORDER BY created_at DESC`,
        [delegateUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  getDelegatePermission(principalUserId, delegateUserId, calendarId = null) {
    return new Promise((resolve, reject) => {
      let sql = `SELECT id, principal_user_id, delegate_user_id, calendar_id, role, can_manage_invitations, can_view_private, can_manage_delegates, created_at
                 FROM delegate_permissions WHERE principal_user_id = ? AND delegate_user_id = ?`;
      const params = [principalUserId, delegateUserId];
      if (calendarId) {
        sql += ` AND (calendar_id IS NULL OR calendar_id = ?)`;
        params.push(calendarId);
      }
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  },

  deleteDelegatePermission(id) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM delegate_permissions WHERE id = ?`, [id], function(err) {
        if (err) return reject(err);
        resolve({ deleted: this.changes });
      });
    });
  },

  getWorkingHoursPolicy(userId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT user_id, start_hour, end_hour, work_days, auto_decline, ooo_enabled, ooo_start, ooo_end, ooo_message, created_at, updated_at
         FROM working_hours_policy WHERE user_id = ?`,
        [userId],
        (err, row) => {
          if (err) return reject(err);
          if (!row) {
            return resolve({
              userId,
              startHour: 9,
              endHour: 17,
              workDays: '1,2,3,4,5',
              autoDecline: 0,
              oooEnabled: 0,
              oooStart: '',
              oooEnd: '',
              oooMessage: 'Out of Office / Abwesend'
            });
          }
          resolve({
            userId: row.user_id,
            startHour: row.start_hour,
            endHour: row.end_hour,
            workDays: row.work_days,
            autoDecline: row.auto_decline,
            oooEnabled: row.ooo_enabled,
            oooStart: row.ooo_start || '',
            oooEnd: row.ooo_end || '',
            oooMessage: row.ooo_message || 'Out of Office / Abwesend',
            createdAt: row.created_at,
            updatedAt: row.updated_at
          });
        }
      );
    });
  },

  upsertWorkingHoursPolicy(userId, policy) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const startHour = policy.startHour !== undefined ? Number(policy.startHour) : 9;
      const endHour = policy.endHour !== undefined ? Number(policy.endHour) : 17;
      const workDays = policy.workDays || '1,2,3,4,5';
      const autoDecline = policy.autoDecline ? 1 : 0;
      const oooEnabled = policy.oooEnabled ? 1 : 0;
      const oooStart = policy.oooStart || '';
      const oooEnd = policy.oooEnd || '';
      const oooMessage = policy.oooMessage || 'Out of Office / Abwesend';

      db.run(
        `INSERT OR REPLACE INTO working_hours_policy
         (user_id, start_hour, end_hour, work_days, auto_decline, ooo_enabled, ooo_start, ooo_end, ooo_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM working_hours_policy WHERE user_id = ?), ?), ?)`,
        [userId, startHour, endHour, workDays, autoDecline, oooEnabled, oooStart, oooEnd, oooMessage, userId, now, now],
        (err) => {
          if (err) return reject(err);
          resolve({
            userId,
            startHour,
            endHour,
            workDays,
            autoDecline,
            oooEnabled,
            oooStart,
            oooEnd,
            oooMessage,
            updatedAt: now
          });
        }
      );
    });
  },

  recordCrossUserDeletion(uid, calendarId, ownerUserId, deletedBy) {
    return new Promise((resolve, reject) => {
      const id = require('node:crypto').randomUUID();
      const createdAt = Date.now();
      db.run(
        `INSERT INTO cross_user_deletions (id, uid, calendar_id, owner_user_id, deleted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, uid, calendarId, ownerUserId, deletedBy, createdAt],
        function(err) {
          if (err) return reject(err);
          resolve({ id, uid, calendarId, ownerUserId, deletedBy, createdAt });
        }
      );
    });
  },

  getCrossUserDeletions(ownerUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, uid, calendar_id, owner_user_id, deleted_by, created_at
         FROM cross_user_deletions WHERE owner_user_id = ?`,
        [ownerUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  clearCrossUserDeletion(id) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM cross_user_deletions WHERE id = ?`, [id], function(err) {
        if (err) return reject(err);
        resolve(this.changes);
      });
    });
  }
};

module.exports = Db;
