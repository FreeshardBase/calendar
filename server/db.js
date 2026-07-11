'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../webcalendar.db');
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
      display_name TEXT NOT NULL
    )
  `);
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
              password: decrypt(row.password_encrypted, row.iv),
              displayName: row.display_name
            }));
            resolve(mapped);
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
        'INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, userId, url, username, encrypted, iv, displayName || username],
        (err) => {
          if (err) return reject(err);
          resolve({ id, displayName: displayName || username });
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
  }
};

module.exports = Db;
