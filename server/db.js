'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getSchemaVersion, setSchemaVersion, runMigrations, migrations } = require('./utils/migrations');

const defaultDbFilename = process.env.NODE_ENV === 'test' ? '../webcalendar.test.db' : '../webcalendar.db';
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, defaultDbFilename);
const dbExistedAtBoot = fs.existsSync(dbPath);
const db = new sqlite3.Database(dbPath);

const WEAK_ENCRYPTION_KEYS = new Set([
  'freeshard-default-encryption-key-do-not-use-in-prod',
  'freeshard-default-key',
  'change-me',
  'change-me-32-chars-or-more',
  'portal.id',
  '{{ portal.id }}',
  '{{portal.id}}',
]);

function isWeakEncryptionKey(rawKey, env = process.env) {
  if (!rawKey) return true;
  const key = String(rawKey).trim();
  if (!key) return true;
  if (WEAK_ENCRYPTION_KEYS.has(key)) return true;
  if (/portal\.id/i.test(key)) return true;
  if (key.length === 103) return true; // Freeshard rendered portal.id length
  const portalId = (env && env.PORTAL_ID) || process.env.PORTAL_ID;
  if (portalId && key === portalId.trim()) return true;
  return false;
}

function validateEncryptionKey(env = process.env, keyToValidate) {
  const isProd = env.NODE_ENV === 'production';
  const isStaging = env.NODE_ENV === 'staging';
  const rawKey = (keyToValidate !== undefined
    ? String(keyToValidate)
    : (env.ENCRYPTION_KEY || env.ENCRYPTION_SECRET || process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_SECRET || '')
  ).trim();
  const isWeak = isWeakEncryptionKey(rawKey, env);

  if ((isProd || isStaging) && isWeak && env.ALLOW_INSECURE_ENCRYPTION_KEY !== 'true' && env.E2E_TEST !== 'true') {
    throw new Error('ENCRYPTION_KEY must be explicitly configured with a secure, unique key per install in production environment.');
  }

  return rawKey || 'freeshard-default-encryption-key-do-not-use-in-prod';
}

// Issue #333: writes fail loudly (losing a freshly minted key means losing every credential
// encrypted with it) and never replace a key file another process created in the meantime.
function persistKeyFile(keyFilePath, key, replace = false) {
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  try {
    fs.writeFileSync(keyFilePath, key, { encoding: 'utf8', mode: 0o600, flag: replace ? 'w' : 'wx' });
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = fs.readFileSync(keyFilePath, 'utf8').trim();
  if (!existing) throw new Error(`Encryption key file ${keyFilePath} exists but is empty.`);
  return existing;
}

/**
 * Resolves the encryption secret. A key is only generated when no key file and no ENCRYPTION_KEY
 * exist. If the database file already exists, no key is written here: the returned
 * `pendingKeyFile` is written by verifyEncryptionKey() only after it proved that the key matches
 * the database (or, for a generated key, that the database holds no ciphertexts) (#333).
 */
function resolveEncryptionKeyState(env = process.env, targetDbPath = dbPath, dbExists = fs.existsSync(targetDbPath)) {
  const keyFilePath = env.ENCRYPTION_KEY_FILE || path.join(path.dirname(targetDbPath), '.encryption_key');
  const rawEnvKey = (env.ENCRYPTION_KEY || env.ENCRYPTION_SECRET || '').trim();
  const repoKeyFile = path.resolve(path.join(__dirname, '../.encryption_key'));
  const isRepoKeyFile = path.resolve(keyFilePath) === repoKeyFile;
  const mayWriteKeyFile = !isRepoKeyFile && (env.NODE_ENV !== 'test' || targetDbPath !== dbPath);
  const keyState = (secret, generated, replaceKeyFile = false) => {
    if (!mayWriteKeyFile || (!generated && !replaceKeyFile && fs.existsSync(keyFilePath))) {
      return { secret, generated, pendingKeyFile: null, replaceKeyFile: false };
    }
    if (dbExists) return { secret, generated, pendingKeyFile: keyFilePath, replaceKeyFile };
    return { secret: persistKeyFile(keyFilePath, secret, replaceKeyFile), generated, pendingKeyFile: null, replaceKeyFile: false };
  };

  // 1. Check if .encryption_key exists on disk (prioritized for restore preservation)
  if (fs.existsSync(keyFilePath)) {
    const keyFromFile = fs.readFileSync(keyFilePath, 'utf8').trim();
    if (keyFromFile) {
      if (!isWeakEncryptionKey(keyFromFile, env)) {
        return { secret: keyFromFile, generated: false, pendingKeyFile: null, replaceKeyFile: false };
      }
      // File holds a weak key:
      if (rawEnvKey && !isWeakEncryptionKey(rawEnvKey, env)) {
        return keyState(rawEnvKey, false, true);
      }
      // Enforce validation: a file containing default or weak key must NOT bypass production guard!
      validateEncryptionKey(env, keyFromFile);
    }
  }

  // 2. Explicit env key takes precedence if specified, but must be validated
  if (rawEnvKey) {
    validateEncryptionKey(env, rawEnvKey);
    return keyState(rawEnvKey, false);
  }

  // 3. In repo-level test runs against the default fixture database, allow test fixture default key
  if (env.NODE_ENV === 'test' && targetDbPath === dbPath && !rawEnvKey) {
    return { secret: 'freeshard-default-encryption-key-do-not-use-in-prod', generated: false, pendingKeyFile: null, replaceKeyFile: false };
  }

  // 4. No explicit env key and no key file: generate 32 random bytes per install
  return keyState(crypto.randomBytes(32).toString('hex'), true);
}

function resolveEncryptionKey(env = process.env, targetDbPath = dbPath) {
  return resolveEncryptionKeyState(env, targetDbPath).secret;
}

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'salt';
const ENCRYPTION_KEY_STATE = resolveEncryptionKeyState(process.env, dbPath, dbExistedAtBoot);
const ENCRYPTION_SECRET = ENCRYPTION_KEY_STATE.secret;
const ENCRYPTION_KEY = crypto.scryptSync(
  ENCRYPTION_SECRET,
  ENCRYPTION_SALT,
  32
);

// Initialize table and index
db.serialize(() => {
  // WAL: the DB file is shared with the Radicale plugins and the sync-worker;
  // a MEMORY journal would risk corruption on concurrent multi-process writes.
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 30000');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT
    )
  `);
  db.run('ALTER TABLE users ADD COLUMN email TEXT', () => {});
  db.run(`
    INSERT OR IGNORE INTO users (user_id, username, email) VALUES ('test', 'test', 'test@example.com'), ('testuser', 'testuser', 'testuser@example.com')
  `);
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
      expires_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_passwords (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
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
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at INTEGER,
      retry_state TEXT NOT NULL DEFAULT 'IDLE',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);
  db.run(`ALTER TABLE sync_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE sync_queue ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3`, () => {});
  db.run(`ALTER TABLE sync_queue ADD COLUMN next_retry_at INTEGER`, () => {});
  db.run(`ALTER TABLE sync_queue ADD COLUMN retry_state TEXT NOT NULL DEFAULT 'IDLE'`, () => {});
  db.run(`
    CREATE TABLE IF NOT EXISTS user_calendar_shares (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      sharee_user_id TEXT NOT NULL,
      read_write INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      role TEXT DEFAULT 'WRITE',
      can_view_private INTEGER DEFAULT 0,
      can_manage_shares INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(calendar_id, sharee_user_id)
    )
  `);
  db.run(`ALTER TABLE user_calendar_shares ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'`, () => {});
  db.run(`ALTER TABLE user_calendar_shares ADD COLUMN role TEXT DEFAULT 'WRITE'`, () => {});
  db.run(`ALTER TABLE user_calendar_shares ADD COLUMN can_view_private INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE user_calendar_shares ADD COLUMN can_manage_shares INTEGER DEFAULT 0`, () => {});
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
      created_at INTEGER NOT NULL,
      owner_id TEXT
    )
  `);
  // Pre-#339 rows keep owner_id NULL and can no longer be modified through the API.
  db.run('ALTER TABLE resources ADD COLUMN owner_id TEXT', (err) => {
    if (err && !/duplicate column name/i.test(err.message)) throw err;
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT,
      keys_auth TEXT,
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
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      local_ics TEXT,
      remote_ics TEXT,
      status TEXT DEFAULT 'PENDING',
      resolution_strategy TEXT,
      resolved_ics TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
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
  db.run(`
    CREATE TABLE IF NOT EXISTS user_calendar_color_overrides (
      user_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      color TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, calendar_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS public_ics_cache (
      token TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ics_fetch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ics_fetch_log_token_time ON ics_fetch_log(token, fetched_at)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS webcal_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      refresh_interval INTEGER NOT NULL DEFAULT 3600,
      last_synced_at INTEGER,
      cached_events TEXT,
      cached_ics TEXT,
      last_error TEXT,
      last_error_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_webcal_subscriptions_user ON webcal_subscriptions(user_id)`);
  db.run(`ALTER TABLE webcal_subscriptions ADD COLUMN cached_events TEXT`, () => {});
  // #342: the raw feed is cached and expanded per requested window; sync errors are kept.
  for (const column of ['cached_ics TEXT', 'last_error TEXT', 'last_error_at INTEGER']) {
    db.run(`ALTER TABLE webcal_subscriptions ADD COLUMN ${column}`, (err) => {
      if (err && !/duplicate column name/i.test(err.message)) throw err;
    });
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS event_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      changes TEXT,
      snapshot_ics TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_event_history_uid ON event_history(event_uid, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_event_history_cal ON event_history(calendar_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_linked_accounts_user_id ON linked_accounts(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_app_passwords_user_id ON app_passwords(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_calendar_shares_calendar_id ON calendar_shares(calendar_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_queue_user_id ON sync_queue(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_queue_status_retry ON sync_queue(status, next_retry_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_calendar_shares_sharee ON user_calendar_shares(sharee_user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_msgraph_accounts_user_id ON msgraph_accounts(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_msgraph_event_mappings_graph_id ON msgraph_event_mappings(graph_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_msgraph_event_mappings_account_id ON msgraph_event_mappings(account_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user_id ON web_push_subscriptions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_resource_bookings_resource_id ON resource_bookings(resource_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_resource_bookings_user_id ON resource_bookings(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_availability_pages_user_id ON availability_pages(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_availability_pages_calendar_id ON availability_pages(calendar_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_slot_bookings_page_id ON slot_bookings(page_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_id ON sync_conflicts(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_delegate_permissions_delegate ON delegate_permissions(delegate_user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cross_user_deletions_owner ON cross_user_deletions(owner_user_id)`);
  // #333: one value encrypted with the install's key, checked on every boot.
  db.run(`
    CREATE TABLE IF NOT EXISTS encryption_key_check (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  runMigrations(db).catch((err) => {
    console.error('[db] Error running schema migrations:', err);
  });
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

const KEY_CHECK_PLAINTEXT = 'freeshard-webcalendar-key-check-v1';
const ENCRYPTED_TOKEN_PATTERN = /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;

function decryptsWithKey(keyBytes, cipherHex, ivHex) {
  try {
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, keyBytes, Buffer.from(ivHex, 'hex'));
    const plain = Buffer.concat([decipher.update(cipherHex, 'hex'), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch (err) {
    // Wrong key, corrupted ciphertext or IV: this value does not decrypt.
    if (/^(ERR_OSSL_|ERR_CRYPTO_INVALID_IV$|ERR_ENCODING_INVALID_ENCODED_DATA$)/.test(err.code)) return null;
    throw err;
  }
}

function dbGet(database, sql, params = []) {
  return new Promise((resolve, reject) => database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function dbAll(database, sql, params = []) {
  return new Promise((resolve, reject) => database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function dbRun(database, sql, params = []) {
  return new Promise((resolve, reject) => database.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function findCiphertexts(database) {
  const ciphertexts = [];
  const accounts = await dbAll(database, 'SELECT id, password_encrypted, iv FROM linked_accounts');
  for (const row of accounts) {
    ciphertexts.push({ ref: `linked_accounts/${row.id}`, cipherHex: row.password_encrypted, ivHex: row.iv });
  }
  const graphAccounts = await dbAll(database, 'SELECT id, access_token, refresh_token FROM msgraph_accounts');
  for (const row of graphAccounts) {
    for (const token of [row.refresh_token, row.access_token]) {
      if (typeof token === 'string' && ENCRYPTED_TOKEN_PATTERN.test(token)) {
        const [ivHex, cipherHex] = token.split(':');
        ciphertexts.push({ ref: `msgraph_accounts/${row.id}`, cipherHex, ivHex });
      }
    }
  }
  return ciphertexts;
}

/**
 * Issue #333: refuses to run with a key that does not belong to this database.
 * - A stored key-check value must decrypt with the configured key.
 * - A database from before #333 (no key-check) is adopted only if its ciphertexts decrypt.
 * - A generated key is only accepted (and only then persisted) if the database holds no ciphertexts.
 */
async function verifyEncryptionKey(database, keyBytes, keyState) {
  const missingKeyHint = keyState.generated
    ? 'No ENCRYPTION_KEY is set and no .encryption_key file was found, so a new key was generated - '
    : '';
  const check = await dbGet(database, 'SELECT ciphertext, iv FROM encryption_key_check WHERE id = 1');
  if (check && decryptsWithKey(keyBytes, check.ciphertext, check.iv) !== KEY_CHECK_PLAINTEXT) {
    throw new Error(`${missingKeyHint}the configured encryption key cannot decrypt the key-check value of this database. ` +
      'Restore the original .encryption_key / ENCRYPTION_KEY; refusing to start.');
  }

  if (!check) {
    const ciphertexts = await findCiphertexts(database);
    if (ciphertexts.length > 0 && keyState.generated) {
      throw new Error(`${missingKeyHint}but the database already holds ${ciphertexts.length} encrypted credential(s). ` +
        'Restore the original .encryption_key / ENCRYPTION_KEY; refusing to start and not persisting a new encryption key.');
    }
    if (ciphertexts.length > 0 && !ciphertexts.some((c) => decryptsWithKey(keyBytes, c.cipherHex, c.ivHex) !== null)) {
      throw new Error(`The configured encryption key cannot decrypt any of the ${ciphertexts.length} encrypted credential(s) ` +
        `in this database (e.g. ${ciphertexts[0].ref}). Restore the original .encryption_key / ENCRYPTION_KEY; refusing to start.`);
    }
  }

  // The key is proven to belong to this database: only now may it be written to the key file.
  if (keyState.pendingKeyFile &&
      persistKeyFile(keyState.pendingKeyFile, keyState.secret, keyState.replaceKeyFile) !== keyState.secret) {
    throw new Error(`${keyState.pendingKeyFile} was created by another process with a different key; restart to use it.`);
  }

  if (!check) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyBytes, iv);
    const ciphertext = cipher.update(KEY_CHECK_PLAINTEXT, 'utf8', 'hex') + cipher.final('hex');
    await dbRun(database, 'INSERT INTO encryption_key_check (id, ciphertext, iv, created_at) VALUES (1, ?, ?, ?)',
      [ciphertext, iv.toString('hex'), Date.now()]);
  }
}

// Resolves once the configured key is proven to match this database; server/index.js holds
// every request until then and exits on rejection.
const ready = verifyEncryptionKey(db, ENCRYPTION_KEY, ENCRYPTION_KEY_STATE);

function encryptToken(token) {
  if (!token || typeof token !== 'string') return token;
  if (/^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(token)) return token;
  const { encrypted, iv } = encrypt(token);
  return `${iv}:${encrypted}`;
}

function decryptToken(token) {
  if (!token || typeof token !== 'string') return token;
  if (!token.includes(':')) return token;
  const [ivHex, cipherHex] = token.split(':');
  if (!ivHex || ivHex.length !== 32 || !cipherHex) return token;
  try {
    return decrypt(cipherHex, ivHex);
  } catch (err) {
    return token;
  }
}

const Db = {
  getAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM linked_accounts WHERE user_id = ?',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          const mapped = [];
          for (const row of rows) {
            try {
              mapped.push({
                id: row.id,
                url: row.url,
                username: row.username,
                password: decrypt(row.password_encrypted, row.iv), // decrypts either password or refresh_token
                displayName: row.display_name,
                authType: row.auth_type || 'basic',
                accessToken: row.access_token,
                expiresAt: row.expires_at
              });
            } catch (decryptionError) {
              // Issue #136: skip undecryptable rows (wrong key, corrupted ciphertext, etc.)
              // rather than rejecting the whole promise and 401-ing every API route.
              console.error(`[db] Skipping undecryptable linked_accounts row id=${row.id}:`, decryptionError.message);
            }
          }
          resolve(mapped);
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

  /**
   * Issue #136: fetch only user_id for an account row without decrypting the
   * password ciphertext.  Used by DELETE /api/accounts/:id to confirm ownership
   * of rows that cannot be decrypted (wrong key, corrupted ciphertext, etc.)
   * so those accounts can still be removed from the UI.
   */
  getAccountOwner(id) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT id, user_id FROM linked_accounts WHERE id = ?',
        [id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? { id: row.id, userId: row.user_id } : null);
        }
      );
    });
  },

  /**
   * Issue #248: DB-authoritative duplicate check for POST /api/accounts.
   * Returns the existing row's id + display_name if (user_id, url, username)
   * already exists, null otherwise. Never decrypts credentials.
   */
  findAccountByUrlAndUsername(userId, url, username) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT id, url, username, display_name FROM linked_accounts WHERE user_id = ? AND url = ? AND username = ?',
        [userId, url, username],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? { id: row.id, url: row.url, username: row.username, displayName: row.display_name } : null);
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

  withTransaction(fn) {
    if (this._inTx && this._activeTx) {
      return Promise.resolve().then(() => fn(this._activeTx));
    }
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (startErr) => {
          if (startErr) return reject(startErr);
          this._inTx = true;
          let rolledBack = false;
          const tx = {
            run: (sql, params = []) => {
              return new Promise((res, rej) => {
                if (rolledBack) return rej(new Error('Transaction already aborted'));
                db.run(sql, params, function (runErr) {
                  if (runErr) return rej(runErr);
                  res(this);
                });
              });
            },
            get: (sql, params = []) => {
              return new Promise((res, rej) => {
                if (rolledBack) return rej(new Error('Transaction already aborted'));
                db.get(sql, params, (getErr, row) => {
                  if (getErr) return rej(getErr);
                  res(row);
                });
              });
            },
            all: (sql, params = []) => {
              return new Promise((res, rej) => {
                if (rolledBack) return rej(new Error('Transaction already aborted'));
                db.all(sql, params, (allErr, rows) => {
                  if (allErr) return rej(allErr);
                  res(rows);
                });
              });
            }
          };
          this._activeTx = tx;

          Promise.resolve()
            .then(() => fn(tx))
            .then((result) => {
              if (rolledBack) return;
              db.run('COMMIT', (commitErr) => {
                this._inTx = false;
                this._activeTx = null;
                if (commitErr) {
                  db.run('ROLLBACK', () => reject(commitErr));
                } else {
                  resolve(result);
                }
              });
            })
            .catch((fnErr) => {
              rolledBack = true;
              db.run('ROLLBACK', () => {
                this._inTx = false;
                this._activeTx = null;
                reject(fnErr);
              });
            });
        });
      });
    });
  },

  cleanUserTmpCredentials(userId) {
    if (!userId) return;
    try {
      const tmpDir = '/tmp';
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
          if (file.startsWith(`vdir_${userId}.ini`) ||
              file.startsWith(`vdir_basic_${userId}.ini`) ||
              file.startsWith(`google_token_${userId}_`)) {
            try {
              fs.unlinkSync(path.join(tmpDir, file));
            } catch (e) {
              // ignore single file error
            }
          }
        }
      }
    } catch (e) {
      // ignore directory error
    }
  },

  deleteUser(userId) {
    if (!userId) return Promise.resolve();
    this.cleanUserTmpCredentials(userId);
    const calPattern = `%${userId}%`;
    return this.withTransaction(async (tx) => {
      await tx.run('DELETE FROM users WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM linked_accounts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM app_passwords WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM sync_queue WHERE user_id = ? OR user_id LIKE ?', [userId, `${userId}%`]);
      await tx.run('DELETE FROM user_calendar_shares WHERE sharee_user_id = ? OR calendar_id LIKE ?', [userId, calPattern]);
      await tx.run('DELETE FROM msgraph_event_mappings WHERE account_id IN (SELECT id FROM msgraph_accounts WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM msgraph_accounts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM web_push_subscriptions WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM resource_bookings WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM slot_bookings WHERE page_id IN (SELECT id FROM availability_pages WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM availability_pages WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM sync_conflicts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM delegate_permissions WHERE principal_user_id = ? OR delegate_user_id = ?', [userId, userId]);
      await tx.run('DELETE FROM working_hours_policy WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM cross_user_deletions WHERE owner_user_id = ? OR deleted_by = ?', [userId, userId]);
      await tx.run('DELETE FROM user_calendar_color_overrides WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM webcal_subscriptions WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM event_history WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM calendar_shares WHERE calendar_id LIKE ?', [calPattern]);
    });
  },

  deleteUserAccounts(userId) {
    return this.deleteUser(userId);
  },

  deleteCalendarData(calendarId) {
    if (!calendarId) return Promise.resolve();
    const altId = calendarId.endsWith('/') ? calendarId.slice(0, -1) : `${calendarId}/`;
    return this.withTransaction(async (tx) => {
      await tx.run('DELETE FROM user_calendar_shares WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run(
        'DELETE FROM public_ics_cache WHERE token IN (SELECT token FROM calendar_shares WHERE calendar_id = ? OR calendar_id = ?)',
        [calendarId, altId]
      );
      await tx.run(
        'DELETE FROM ics_fetch_log WHERE token IN (SELECT token FROM calendar_shares WHERE calendar_id = ? OR calendar_id = ?)',
        [calendarId, altId]
      );
      await tx.run('DELETE FROM calendar_shares WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM user_calendar_color_overrides WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM calendar_sync_cache WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM sync_conflicts WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM cross_user_deletions WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM delegate_permissions WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run(
        'DELETE FROM slot_bookings WHERE page_id IN (SELECT id FROM availability_pages WHERE calendar_id = ? OR calendar_id = ?)',
        [calendarId, altId]
      );
      await tx.run('DELETE FROM availability_pages WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM event_history WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('UPDATE msgraph_accounts SET target_calendar_id = NULL WHERE target_calendar_id = ? OR target_calendar_id = ?', [calendarId, altId]);
    });
  },

  /**
   * Returns OAuth token expiry status for all oauth2 accounts belonging to userId.
   * Matches the 60-second grace window used by caldav/helper.js:
   *   expired = true  when expiresAt is null/missing OR (expiresAt - 60_000) <= Date.now()
   *   expired = false when expiresAt exists AND (expiresAt - 60_000) > Date.now()
   * Never exposes password_encrypted, iv, or access_token values.
   */
  getOAuthTokenStatus(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, display_name, auth_type, expires_at
         FROM linked_accounts
         WHERE user_id = ? AND auth_type = 'oauth2'`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          const now = Date.now();
          resolve(rows.map(row => ({
            id: row.id,
            displayName: row.display_name,
            authType: row.auth_type,
            expiresAt: row.expires_at ?? null,
            expired: !row.expires_at || (row.expires_at - 60 * 1000) <= now
          })));
        }
      );
    });
  },

  clearAll() {
    return this.withTransaction(async (tx) => {
      await tx.run('DELETE FROM linked_accounts');
      await tx.run('DELETE FROM app_passwords');
      await tx.run('DELETE FROM calendar_shares');
      await tx.run('DELETE FROM availability_pages');
      await tx.run('DELETE FROM slot_bookings');
      await tx.run('DELETE FROM event_history');
      await tx.run('DELETE FROM user_calendar_color_overrides');
      await tx.run('DELETE FROM webcal_subscriptions');
      await tx.run('DELETE FROM sync_queue');
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
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(rawPassword, salt, 100000, 32, 'sha256').toString('hex');
      const passwordHash = `${salt}:${hash}`;
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

  verifyAppPassword(userId, rawPassword) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT password_hash FROM app_passwords WHERE user_id = ?',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          for (const row of rows) {
            const stored = row.password_hash;
            if (stored.includes(':')) {
              const [salt, expectedHash] = stored.split(':');
              const calcHash = crypto.pbkdf2Sync(rawPassword, salt, 100000, 32, 'sha256').toString('hex');
              if (crypto.timingSafeEqual(Buffer.from(calcHash), Buffer.from(expectedHash))) {
                return resolve(true);
              }
            } else {
              const calcHash = crypto.createHash('sha256').update(rawPassword).digest('hex');
              if (crypto.timingSafeEqual(Buffer.from(calcHash), Buffer.from(stored))) {
                return resolve(true);
              }
            }
          }
          resolve(false);
        }
      );
    });
  },

  // Resolves true if a password owned by userId was deleted, false otherwise.
  deleteAppPassword(id, userId) {
    if (!userId) throw new Error('deleteAppPassword requires userId');
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM app_passwords WHERE id = ? AND user_id = ?', [id, userId], function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
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

  ensureUser(userId, username) {
    return this.upsertUser(userId, username);
  },

  // ── Sync Queue (vdirsyncer jobs) ───────────────────────────────────────────
  async addSyncJob(userId, opts = {}) {
    await this.ensureUser(userId, userId);
    const now = Date.now();
    const id = uuidv4();
    const maxAttempts = opts.maxAttempts || 3;
    const nextRetryAt = opts.nextRetryAt || now;
    const autoCutoff = now - (24 * 60 * 60 * 1000);

    return this.withTransaction(async (tx) => {
      await tx.run('DELETE FROM sync_queue WHERE status IN ("SUCCESS", "ERROR") AND updated_at <= ?', [autoCutoff]);
      await tx.run('DELETE FROM sync_queue WHERE user_id = ? AND status = "PENDING"', [userId]);
      await tx.run(
        'INSERT INTO sync_queue (id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, 'PENDING', null, 0, maxAttempts, nextRetryAt, 'IDLE', now, now]
      );
      return {
        id,
        userId,
        status: 'PENDING',
        errorMessage: null,
        attempts: 0,
        maxAttempts,
        nextRetryAt,
        retryState: 'IDLE',
        createdAt: now,
        updatedAt: now
      };
    });
  },

  getSyncJobById(id) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at FROM sync_queue WHERE id = ?',
        [id],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          resolve({
            id: row.id,
            userId: row.user_id,
            status: row.status,
            errorMessage: row.error_message,
            attempts: row.attempts ?? 0,
            maxAttempts: row.max_attempts ?? 3,
            nextRetryAt: row.next_retry_at ?? null,
            retryState: row.retry_state ?? 'IDLE',
            createdAt: row.created_at,
            updatedAt: row.updated_at
          });
        }
      );
    });
  },

  getSyncJobs(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at FROM sync_queue WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            status: row.status,
            errorMessage: row.error_message,
            attempts: row.attempts ?? 0,
            maxAttempts: row.max_attempts ?? 3,
            nextRetryAt: row.next_retry_at ?? null,
            retryState: row.retry_state ?? 'IDLE',
            createdAt: row.created_at,
            updatedAt: row.updated_at
          })));
        }
      );
    });
  },

  getPendingSyncJobs(now = Date.now()) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, user_id, status, error_message, attempts, max_attempts, next_retry_at, retry_state, created_at, updated_at FROM sync_queue WHERE status = "PENDING" AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC',
        [now],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            status: row.status,
            errorMessage: row.error_message,
            attempts: row.attempts ?? 0,
            maxAttempts: row.max_attempts ?? 3,
            nextRetryAt: row.next_retry_at ?? null,
            retryState: row.retry_state ?? 'IDLE',
            createdAt: row.created_at,
            updatedAt: row.updated_at
          })));
        }
      );
    });
  },

  updateSyncJobStatus(id, status, errorMessage = null, retryOpts = null) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      if (retryOpts) {
        const attempts = retryOpts.attempts ?? 0;
        const maxAttempts = retryOpts.maxAttempts ?? 3;
        const nextRetryAt = retryOpts.nextRetryAt ?? null;
        const retryState = retryOpts.retryState ?? 'IDLE';

        db.run(
          'UPDATE sync_queue SET status = ?, error_message = ?, attempts = ?, max_attempts = ?, next_retry_at = ?, retry_state = ?, updated_at = ? WHERE id = ?',
          [status, errorMessage, attempts, maxAttempts, nextRetryAt, retryState, now, id],
          function (err) {
            if (err) return reject(err);
            resolve({ id, status, errorMessage, attempts, maxAttempts, nextRetryAt, retryState, updatedAt: now, changes: this.changes });
          }
        );
      } else {
        db.run(
          'UPDATE sync_queue SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
          [status, errorMessage, now, id],
          function (err) {
            if (err) return reject(err);
            resolve({ id, status, errorMessage, updatedAt: now, changes: this.changes });
          }
        );
      }
    });
  },

  claimSyncJob(id) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        'UPDATE sync_queue SET status = "RUNNING", updated_at = ? WHERE id = ? AND status = "PENDING"',
        [now, id],
        function (err) {
          if (err) return reject(err);
          resolve({ claimed: this.changes > 0, id, updatedAt: now });
        }
      );
    });
  },

  claimNextSyncJob(now = Date.now()) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT id, user_id, COALESCE(attempts, 0) AS attempts, COALESCE(max_attempts, 3) AS max_attempts FROM sync_queue WHERE status = "PENDING" AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT 1',
        [now],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          const updateNow = Date.now();
          db.run(
            'UPDATE sync_queue SET status = "RUNNING", updated_at = ? WHERE id = ? AND status = "PENDING"',
            [updateNow, row.id],
            function (err2) {
              if (err2) return reject(err2);
              if (this.changes === 0) {
                return resolve(null);
              }
              resolve({
                id: row.id,
                userId: row.user_id,
                attempts: row.attempts,
                maxAttempts: row.max_attempts,
                updatedAt: updateNow
              });
            }
          );
        }
      );
    });
  },

  clearSyncJobsForUser(userId) {
    return new Promise((resolve, reject) => {
      if (!userId) return resolve({ deleted: 0 });
      db.run('DELETE FROM sync_queue WHERE user_id = ?', [userId], function (err) {
        if (err) return reject(err);
        resolve({ deleted: this.changes });
      });
    });
  },

  pruneSyncQueue(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
    return new Promise((resolve, reject) => {
      const cutoff = now - maxAgeMs;
      db.run(
        'DELETE FROM sync_queue WHERE status IN ("SUCCESS", "ERROR") AND updated_at <= ?',
        [cutoff],
        function (err) {
          if (err) return reject(err);
          resolve({ pruned: this.changes });
        }
      );
    });
  },

  upsertUser(userId, username, email) {
    return new Promise((resolve, reject) => {
      if (!userId) return resolve();
      const newUsername = username || userId;
      let targetEmail = (email && typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        ? email.trim().toLowerCase()
        : null;
      if (!targetEmail) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(newUsername).trim())) {
          targetEmail = String(newUsername).trim().toLowerCase();
        } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(userId).trim())) {
          targetEmail = String(userId).trim().toLowerCase();
        }
      }

      db.get('SELECT user_id, username, email FROM users WHERE user_id = ?', [userId], (err, existingUser) => {
        if (err) return reject(err);

        if (!existingUser) {
          db.get('SELECT user_id FROM users WHERE username = ?', [newUsername], (err2, conflictingUser) => {
            if (err2) return reject(err2);
            const targetName = (conflictingUser && newUsername !== userId) ? userId : newUsername;
            db.run(
              'INSERT OR IGNORE INTO users (user_id, username, email) VALUES (?, ?, ?)',
              [userId, targetName, targetEmail],
              (err3) => {
                if (err3) return reject(err3);
                resolve();
              }
            );
          });
        } else {
          const finalEmail = targetEmail || existingUser.email || null;
          if (newUsername === userId && existingUser.username && existingUser.username !== userId) {
            if (finalEmail !== existingUser.email) {
              db.run('UPDATE users SET email = ? WHERE user_id = ?', [finalEmail, userId], (err3) => {
                if (err3) return reject(err3);
                resolve();
              });
            } else {
              return resolve();
            }
            return;
          }
          if (newUsername === existingUser.username) {
            if (finalEmail !== existingUser.email) {
              db.run('UPDATE users SET email = ? WHERE user_id = ?', [finalEmail, userId], (err3) => {
                if (err3) return reject(err3);
                resolve();
              });
            } else {
              return resolve();
            }
            return;
          }
          db.get('SELECT user_id FROM users WHERE username = ? AND user_id != ?', [newUsername, userId], (err2, conflictingUser) => {
            if (err2) return reject(err2);
            if (conflictingUser) {
              if (finalEmail !== existingUser.email) {
                db.run('UPDATE users SET email = ? WHERE user_id = ?', [finalEmail, userId], (err3) => {
                  if (err3) return reject(err3);
                  resolve();
                });
              } else {
                return resolve();
              }
              return;
            }
            db.run(
              'UPDATE users SET username = ?, email = ? WHERE user_id = ?',
              [newUsername, finalEmail, userId],
              (err3) => {
                if (err3) return reject(err3);
                resolve();
              }
            );
          });
        }
      });
    });
  },

  searchUsers(query) {
    return new Promise((resolve, reject) => {
      if (!query || typeof query !== 'string') return resolve([]);
      const trimmed = query.trim();
      if (!trimmed) return resolve([]);
      const escapedQuery = trimmed.replace(/[%_\\]/g, '\\$&');
      db.all(
        "SELECT user_id, username FROM users WHERE username LIKE ? ESCAPE '\\' LIMIT 10",
        [`%${escapedQuery}%`],
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
        `SELECT s.id, s.calendar_id, s.sharee_user_id, s.read_write, s.status, s.role, s.can_view_private, s.can_manage_shares, u.username
         FROM user_calendar_shares s
         LEFT JOIN users u ON s.sharee_user_id = u.user_id
         WHERE s.calendar_id = ?`,
        [calendarId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            calendarId: row.calendar_id,
            shareeUserId: row.sharee_user_id,
            href: `/${row.sharee_user_id}/`,
            commonName: row.username || row.sharee_user_id,
            readWrite: !!row.read_write,
            role: row.role || (row.read_write ? 'WRITE' : 'READ'),
            canViewPrivate: !!row.can_view_private,
            canManageShares: !!row.can_manage_shares,
            status: row.status || 'ACCEPTED'
          })));
        }
      );
    });
  },

  addUserShare(calendarId, shareeUserId, readWrite, status = 'ACCEPTED', role = null, canViewPrivate = 0, canManageShares = 0) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = Date.now();
      const derivedRole = role || (readWrite ? 'WRITE' : 'READ');
      const rw = (derivedRole === 'WRITE' || derivedRole === 'ADMIN' || (readWrite && derivedRole !== 'READ' && derivedRole !== 'FREE_BUSY')) ? 1 : 0;
      db.run(
        `INSERT OR REPLACE INTO user_calendar_shares (id, calendar_id, sharee_user_id, read_write, status, created_at, role, can_view_private, can_manage_shares)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, calendarId, shareeUserId, rw, status, now, derivedRole, canViewPrivate ? 1 : 0, canManageShares ? 1 : 0],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  updateUserSharePermissions(calendarId, shareeUserId, { role, readWrite, canViewPrivate, canManageShares }) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, read_write, role, can_view_private, can_manage_shares FROM user_calendar_shares WHERE calendar_id = ? AND sharee_user_id = ?`,
        [calendarId, shareeUserId],
        (err, row) => {
          if (err || !row) return reject(err || new Error('Share not found'));
          const newRole = role || row.role || (readWrite !== undefined ? (readWrite ? 'WRITE' : 'READ') : 'WRITE');
          const rw = readWrite !== undefined ? (readWrite ? 1 : 0) : ((newRole === 'WRITE' || newRole === 'ADMIN') ? 1 : 0);
          const viewPrivate = canViewPrivate !== undefined ? (canViewPrivate ? 1 : 0) : row.can_view_private;
          const manageShares = canManageShares !== undefined ? (canManageShares ? 1 : 0) : row.can_manage_shares;
          db.run(
            `UPDATE user_calendar_shares SET role = ?, read_write = ?, can_view_private = ?, can_manage_shares = ? WHERE id = ?`,
            [newRole, rw, viewPrivate, manageShares, row.id],
            (updateErr) => {
              if (updateErr) return reject(updateErr);
              resolve();
            }
          );
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
        `SELECT calendar_id, read_write, role, can_view_private, can_manage_shares FROM user_calendar_shares WHERE sharee_user_id = ? AND (status IS NULL OR status = 'ACCEPTED')`,
        [shareeUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            calendar_id: row.calendar_id,
            read_write: !!row.read_write,
            role: row.role || (row.read_write ? 'WRITE' : 'READ'),
            can_view_private: !!row.can_view_private,
            can_manage_shares: !!row.can_manage_shares
          })));
        }
      );
    });
  },

  getPendingShareInvitationsForUser(shareeUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT s.id, s.calendar_id, s.sharee_user_id, s.read_write, s.status, s.created_at, u.username AS owner_username
         FROM user_calendar_shares s
         LEFT JOIN users u ON u.user_id = s.sharee_user_id
         WHERE s.sharee_user_id = ? AND s.status = 'PENDING'`,
        [shareeUserId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(row => ({
            id: row.id,
            calendarId: row.calendar_id,
            shareeUserId: row.sharee_user_id,
            readWrite: !!row.read_write,
            status: row.status,
            createdAt: row.created_at
          })));
        }
      );
    });
  },

  getShareInvitationById(id) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, calendar_id, sharee_user_id, read_write, status, created_at FROM user_calendar_shares WHERE id = ?`,
        [id],
        (err, row) => {
          if (err || !row) return resolve(null);
          resolve({
            id: row.id,
            calendarId: row.calendar_id,
            shareeUserId: row.sharee_user_id,
            readWrite: !!row.read_write,
            status: row.status,
            createdAt: row.created_at
          });
        }
      );
    });
  },

  updateShareStatus(id, status) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE user_calendar_shares SET status = ? WHERE id = ?`,
        [status, id],
        function(err) {
          if (err) return reject(err);
          resolve(this.changes > 0);
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

  getUserEmailByUserId(userId) {
    return new Promise((resolve) => {
      if (!userId) return resolve(null);
      db.get('SELECT email, username, user_id FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err || !row) return resolve(null);
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (row.email && emailRegex.test(row.email.trim())) return resolve(row.email.trim().toLowerCase());
        if (row.username && emailRegex.test(row.username.trim())) return resolve(row.username.trim().toLowerCase());
        if (row.user_id && emailRegex.test(row.user_id.trim())) return resolve(row.user_id.trim().toLowerCase());
        resolve(null);
      });
    });
  },

  getUserById(userId) {
    return new Promise((resolve) => {
      if (!userId) return resolve(null);
      db.get('SELECT user_id, username, email FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err || !row) return resolve(null);
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const resolvedEmail = (row.email && emailRegex.test(row.email.trim()))
          ? row.email.trim().toLowerCase()
          : (emailRegex.test(row.username.trim()) ? row.username.trim().toLowerCase() : null);
        resolve({
          userId: row.user_id,
          username: row.username,
          email: resolvedEmail
        });
      });
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
      const encAccess = encryptToken(accountData.accessToken || '');
      const encRefresh = encryptToken(accountData.refreshToken || '');
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
          encAccess,
          encRefresh,
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
            accessToken: decryptToken(r.access_token),
            refreshToken: decryptToken(r.refresh_token),
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
            accessToken: decryptToken(r.access_token),
            refreshToken: decryptToken(r.refresh_token),
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

      if (updates.accessToken !== undefined) { fields.push('access_token = ?'); values.push(encryptToken(updates.accessToken)); }
      if (updates.refreshToken !== undefined) { fields.push('refresh_token = ?'); values.push(encryptToken(updates.refreshToken)); }
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
    return this.withTransaction(async (tx) => {
      await tx.run(`DELETE FROM msgraph_accounts WHERE id = ?`, [accountId]);
      await tx.run(`DELETE FROM msgraph_event_mappings WHERE account_id = ?`, [accountId]);
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

  addResource({ id, name, type = 'ROOM', capacity = 1, location = '', status = 'AVAILABLE', ownerId = null }) {
    return new Promise((resolve, reject) => {
      const resId = id || `res-${uuidv4()}`;
      const now = Date.now();
      db.run(
        `INSERT INTO resources (id, name, type, capacity, location, status, created_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [resId, name, type, capacity, location, status, now, ownerId],
        (err) => {
          if (err) return reject(err);
          resolve({ id: resId, name, type, capacity, location, status, createdAt: now, ownerId });
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
      db.all(`SELECT id, name, type, capacity, location, status, created_at, owner_id FROM resources ${whereClause} ORDER BY name ASC`, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          capacity: r.capacity,
          location: r.location,
          status: r.status,
          createdAt: r.created_at,
          ownerId: r.owner_id
        })));
      });
    });
  },

  getResourceById(id) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT id, name, type, capacity, location, status, created_at, owner_id FROM resources WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({
          id: row.id,
          name: row.name,
          type: row.type,
          capacity: row.capacity,
          location: row.location,
          status: row.status,
          createdAt: row.created_at,
          ownerId: row.owner_id
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
    return this.withTransaction(async (tx) => {
      await tx.run(`DELETE FROM resources WHERE id = ?`, [id]);
      await tx.run(`DELETE FROM resource_bookings WHERE resource_id = ?`, [id]);
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
  },

  setUserCalendarColorOverride(userId, calendarId, color) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO user_calendar_color_overrides (user_id, calendar_id, color, updated_at)
         VALUES (?, ?, ?, ?)`,
        [userId, calendarId, color, now],
        (err) => {
          if (err) return reject(err);
          resolve({ userId, calendarId, color, updatedAt: now });
        }
      );
    });
  },

  getUserCalendarColorOverrides(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT calendar_id, color FROM user_calendar_color_overrides WHERE user_id = ?`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          const overrides = {};
          if (rows) {
            for (const row of rows) {
              overrides[row.calendar_id] = row.color;
            }
          }
          resolve(overrides);
        }
      );
    });
  },

  getUserCalendarColorOverride(userId, calendarId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT color FROM user_calendar_color_overrides WHERE user_id = ? AND calendar_id = ?`,
        [userId, calendarId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? row.color : null);
        }
      );
    });
  },

  deleteUserCalendarColorOverride(userId, calendarId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM user_calendar_color_overrides WHERE user_id = ? AND calendar_id = ?`,
        [userId, calendarId],
        function(err) {
          if (err) return reject(err);
          resolve(this.changes);
        }
      );
    });
  },

  addSyncConflict(userId, calendarId, uid, localIcs, remoteIcs) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      db.run(
        `INSERT INTO sync_conflicts (id, user_id, calendar_id, uid, local_ics, remote_ics, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [id, userId, calendarId, uid, localIcs, remoteIcs, now],
        function(err) {
          if (err) return reject(err);
          resolve(id);
        }
      );
    });
  },

  getPendingSyncConflicts(userId, calendarId = null) {
    return new Promise((resolve, reject) => {
      let query = `SELECT id, user_id, calendar_id, uid, local_ics, remote_ics, status, created_at FROM sync_conflicts WHERE user_id = ? AND status = 'PENDING'`;
      const params = [userId];
      if (calendarId) {
        query += ` AND calendar_id = ?`;
        params.push(calendarId);
      }
      query += ` ORDER BY created_at DESC`;
      db.all(query, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  resolveSyncConflict(conflictId, userId, strategy, resolvedIcs) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        `UPDATE sync_conflicts SET status = 'RESOLVED', resolution_strategy = ?, resolved_ics = ?, resolved_at = ? WHERE id = ? AND user_id = ?`,
        [strategy, resolvedIcs, now, conflictId, userId],
        function(err) {
          if (err) return reject(err);
          resolve(this.changes > 0);
        }
      );
    });
  },

  // ── Issue #8: Public ICS Subscription Cache ────────────────────────────────

  /**
   * Retrieve a cached ICS body for `token`. Returns null if not found or expired.
   */
  getIcsCache(token) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT token, body, expires_at FROM public_ics_cache WHERE token = ? AND expires_at > ?`,
        [token, Date.now()],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  },

  /**
   * Insert or replace a cached ICS body for `token` with a TTL of `ttlSeconds`.
   */
  upsertIcsCache(token, body, ttlSeconds) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1000;
      db.run(
        `INSERT OR REPLACE INTO public_ics_cache (token, body, expires_at, updated_at) VALUES (?, ?, ?, ?)`,
        [token, body, expiresAt, now],
        function(err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },
  deleteIcsCache(token) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM public_ics_cache WHERE token = ?`,
        [token],
        function(err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  /**
   * Record a fetch hit for rate-limit accounting.
   */
  recordIcsFetch(token) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO ics_fetch_log (token, fetched_at) VALUES (?, ?)`,
        [token, Date.now()],
        function(err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  },

  /**
   * Return the number of fetches for `token` within the last `windowSeconds`.
   */
  getIcsFetchCount(token, windowSeconds) {
    return new Promise((resolve, reject) => {
      const since = Date.now() - windowSeconds * 1000;
      db.get(
        `SELECT COUNT(*) AS cnt FROM ics_fetch_log WHERE token = ? AND fetched_at >= ?`,
        [token, since],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? row.cnt : 0);
        }
      );
    });
  },

  // ── Issue #17: Web Push Subscriptions ─────────────────────────────────────

  /**
   * Insert or replace a Web Push Subscription for a user.
   */
  savePushSubscription(sub) {
    return new Promise((resolve, reject) => {
      const id = sub.id || uuidv4();
      const createdAt = sub.created_at || Date.now();
      db.run(
        `INSERT OR REPLACE INTO web_push_subscriptions (id, user_id, endpoint, keys_p256dh, keys_auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, sub.user_id, sub.endpoint, sub.keys_p256dh || null, sub.keys_auth || null, createdAt],
        function(err) {
          if (err) return reject(err);
          resolve({ id, user_id: sub.user_id, endpoint: sub.endpoint, keys_p256dh: sub.keys_p256dh, keys_auth: sub.keys_auth, created_at: createdAt });
        }
      );
    });
  },

  /**
   * Get all active push subscriptions for a user.
   */
  getPushSubscriptions(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, endpoint, keys_p256dh, keys_auth, created_at FROM web_push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  /**
   * Delete a push subscription by ID and user ID.
   */
  deletePushSubscription(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM web_push_subscriptions WHERE id = ? AND user_id = ?`,
        [id, userId],
        function(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /**
   * Delete a push subscription by Endpoint and user ID.
   */
  deletePushSubscriptionByEndpoint(endpoint, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM web_push_subscriptions WHERE endpoint = ? AND user_id = ?`,
        [endpoint, userId],
        function(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /**
   * Webcal / ICS Read-Only Calendar Subscriptions (Issue #24)
   */
  createWebcalSubscription({ userId, name, url, color = '#3b82f6', refreshInterval = 3600 }) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO webcal_subscriptions (id, user_id, name, url, color, refresh_interval, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, name, url, color, refreshInterval, now],
        function(err) {
          if (err) return reject(err);
          resolve({
            id,
            user_id: userId,
            name,
            url,
            color,
            refresh_interval: refreshInterval,
            last_synced_at: null,
            created_at: now
          });
        }
      );
    });
  },

  getWebcalSubscriptions(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, name, url, color, refresh_interval, last_synced_at, last_error, last_error_at, created_at
         FROM webcal_subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  getWebcalSubscription(id, userId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, user_id, name, url, color, refresh_interval, last_synced_at, last_error, last_error_at, created_at
         FROM webcal_subscriptions WHERE id = ? AND user_id = ?`,
        [id, userId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  },

  updateWebcalSubscription(id, userId, updates = {}) {
    return new Promise((resolve, reject) => {
      this.getWebcalSubscription(id, userId).then(existing => {
        if (!existing) return resolve(null);
        const name = updates.name !== undefined ? updates.name : existing.name;
        const color = updates.color !== undefined ? updates.color : existing.color;
        const refreshInterval = updates.refreshInterval !== undefined ? updates.refreshInterval : existing.refresh_interval;
        db.run(
          `UPDATE webcal_subscriptions SET name = ?, color = ?, refresh_interval = ? WHERE id = ? AND user_id = ?`,
          [name, color, refreshInterval, id, userId],
          function(err) {
            if (err) return reject(err);
            resolve({
              ...existing,
              name,
              color,
              refresh_interval: refreshInterval
            });
          }
        );
      }).catch(reject);
    });
  },

  updateWebcalSubscriptionSyncTime(id, lastSyncedAt) {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE webcal_subscriptions SET last_synced_at = ? WHERE id = ?`, [lastSyncedAt, id], function(err) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      });
    });
  },

  /** #342: store a successfully parsed feed and clear any previous sync error. */
  storeWebcalFeed(id, lastSyncedAt, icsText) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE webcal_subscriptions
         SET last_synced_at = ?, cached_ics = ?, cached_events = NULL, last_error = NULL, last_error_at = NULL
         WHERE id = ?`,
        [lastSyncedAt, icsText, id],
        function(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /** #342: record a failed sync; the cached feed stays untouched. */
  recordWebcalSyncError(id, failedAt, message) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE webcal_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?`,
        [message, failedAt, id],
        function(err) {
          if (err) return reject(err);
          resolve({ changes: this.changes });
        }
      );
    });
  },

  getCachedWebcalIcs(subscriptionId, userId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT cached_ics FROM webcal_subscriptions WHERE id = ? AND user_id = ?`,
        [subscriptionId, userId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row && row.cached_ics ? row.cached_ics : null);
        }
      );
    });
  },

  getWebcalSubscriptionsDueForSync(now = Math.floor(Date.now() / 1000)) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, name, url, color, refresh_interval, last_synced_at, last_error, last_error_at, created_at
         FROM webcal_subscriptions
         WHERE (last_synced_at IS NULL OR (last_synced_at + refresh_interval) <= ?)
           AND (last_error_at IS NULL OR (last_error_at + refresh_interval) <= ?)`,
        [now, now],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  deleteWebcalSubscription(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM webcal_subscriptions WHERE id = ? AND user_id = ?`,
        [id, userId],
        function(err) {
          if (err) return reject(err);
          resolve(this.changes > 0);
        }
      );
    });
  },

  recordEventHistory({ eventUid, calendarId, userId, action, changes, snapshotIcs }) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const changesJson = changes ? JSON.stringify(changes) : null;
      db.run(
        `INSERT INTO event_history (event_uid, calendar_id, user_id, action, changes, snapshot_ics, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [eventUid, calendarId, userId, action, changesJson, snapshotIcs || null, now],
        function(err) {
          if (err) return reject(err);
          resolve({ id: this.lastID, eventUid, calendarId, userId, action, created_at: now });
        }
      );
    });
  },

  getEventHistory(eventUid, limit = 50) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM event_history WHERE event_uid = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [eventUid, limit],
        (err, rows) => {
          if (err) return reject(err);
          const parsed = (rows || []).map(r => ({
            ...r,
            changes: r.changes ? JSON.parse(r.changes) : null
          }));
          resolve(parsed);
        }
      );
    });
  },

  getCalendarEventHistory(calendarId, limit = 50) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM event_history WHERE calendar_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [calendarId, limit],
        (err, rows) => {
          if (err) return reject(err);
          const parsed = (rows || []).map(r => ({
            ...r,
            changes: r.changes ? JSON.parse(r.changes) : null
          }));
          resolve(parsed);
        }
      );
    });
  },

  saveSession(sid, userId, sessJson, expiredMs) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO sessions (sid, user_id, sess, expired) VALUES (?, ?, ?, ?)`,
        [sid, userId || null, sessJson, expiredMs],
        (err) => {
          if (err) return reject(err);
          resolve(true);
        }
      );
    });
  },

  getRawSession(sid) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT sid, user_id, sess, expired FROM sessions WHERE sid = ?`, [sid], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  },

  deleteSession(sid) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM sessions WHERE sid = ?`, [sid], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  },

  deleteSessionsForUser(userId) {
    return new Promise((resolve, reject) => {
      if (!userId) return resolve(0);
      db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId], function(err) {
        if (err) return reject(err);
        resolve(this.changes || 0);
      });
    });
  },

  getSessionsForUser(userId) {
    return new Promise((resolve, reject) => {
      if (!userId) return resolve([]);
      const now = Date.now();
      db.all(`SELECT sid, user_id, sess, expired FROM sessions WHERE user_id = ? AND expired > ?`, [userId, now], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  touchSession(sid, expiredMs) {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE sessions SET expired = ? WHERE sid = ?`, [expiredMs, sid], (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  },

  clearExpiredSessions() {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(`DELETE FROM sessions WHERE expired < ?`, [now], function(err) {
        if (err) return reject(err);
        resolve(this.changes || 0);
      });
    });
  },

  async quiesceDatabase(mode = 'TRUNCATE') {
    const validModes = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);
    const normalizedMode = String(mode || 'TRUNCATE').toUpperCase();
    if (!validModes.has(normalizedMode)) {
      throw new Error(`Invalid wal_checkpoint mode: ${mode}`);
    }
    // A TRUNCATE checkpoint fails with SQLITE_LOCKED while the boot-time key check (#333) still reads.
    await ready;
    return new Promise((resolve, reject) => {
      db.get(`PRAGMA wal_checkpoint(${normalizedMode})`, (err, row) => {
        if (err) return reject(err);
        resolve({
          busy: row ? (row.busy ?? 0) : 0,
          log: row ? (row.log ?? 0) : 0,
          checkpointed: row ? (row.checkpointed ?? 0) : 0
        });
      });
    });
  },

  async createBackup(targetPath) {
    if (!targetPath) {
      throw new Error('targetPath is required for database backup');
    }
    const quiesceResult = await this.quiesceDatabase('TRUNCATE');
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      db.run(`VACUUM INTO ?`, [targetPath], (err) => {
        if (!err) {
          const stats = fs.statSync(targetPath);
          return resolve({ backupPath: targetPath, size: stats.size, quiesceResult });
        }
        try {
          fs.copyFileSync(dbPath, targetPath);
          const stats = fs.statSync(targetPath);
          resolve({ backupPath: targetPath, size: stats.size, quiesceResult, fallback: true });
        } catch (copyErr) {
          reject(copyErr);
        }
      });
    });
  },

  verifyDatabaseIntegrity(targetPath = dbPath) {
    return new Promise((resolve, reject) => {
      let checkDb = db;
      let shouldClose = false;
      if (targetPath && targetPath !== dbPath) {
        checkDb = new sqlite3.Database(targetPath, sqlite3.OPEN_READONLY);
        shouldClose = true;
      }
      checkDb.get('PRAGMA integrity_check', (err, row) => {
        if (shouldClose) {
          checkDb.close();
        }
        if (err) return reject(err);
        const val = row ? Object.values(row)[0] : null;
        resolve(val === 'ok');
      });
    });
  },

  checkHealth() {
    return new Promise((resolve, reject) => {
      db.get('SELECT 1', (err, row) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  },

  getSchemaVersion(targetDb = db) {
    return getSchemaVersion(targetDb);
  },

  setSchemaVersion(targetDb = db, version) {
    return setSchemaVersion(targetDb, version);
  },

  runMigrations(targetDb = db, migrationList = migrations) {
    return runMigrations(targetDb, migrationList);
  },

  migrations
};

Db.validateEncryptionKey = validateEncryptionKey;
Db.resolveEncryptionKey = resolveEncryptionKey;
Db.getSchemaVersion = (targetDb = db) => getSchemaVersion(targetDb);
Db.setSchemaVersion = (targetDb = db, version) => setSchemaVersion(targetDb, version);
Db.runMigrations = (targetDb = db, migrationList = migrations) => runMigrations(targetDb, migrationList);
Db.migrations = migrations;
Db.db = db;
Db.getDbPath = () => dbPath;
Db.dbPath = dbPath;

module.exports = Db;
module.exports.validateEncryptionKey = validateEncryptionKey;
module.exports.resolveEncryptionKey = resolveEncryptionKey;
module.exports.ready = ready;
module.exports.withTransaction = Db.withTransaction.bind(Db);
module.exports.getSchemaVersion = Db.getSchemaVersion;
module.exports.setSchemaVersion = Db.setSchemaVersion;
module.exports.runMigrations = Db.runMigrations;
module.exports.migrations = migrations;
module.exports.db = db;
module.exports.getDbPath = Db.getDbPath;
module.exports.dbPath = dbPath;
