'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { v4: uuidv4 } = require('uuid');
const { getSchemaVersion, setSchemaVersion, runMigrations, migrations } = require('./utils/migrations');
const { canonicalAccountUrl, sameAccountUrl } = require('./utils/accountUrl');

// #614: the sync workers' mapping tables, per provider, with the column naming the remote calendar.
const MIRROR_TABLES = {
  google: { table: 'google_calendar_collections', remote: 'google_calendar_id' },
  caldav: { table: 'caldav_calendar_collections', remote: 'remote_collection' },
  msgraph: { table: 'msgraph_calendar_collections', remote: 'graph_calendar_id' }
};
// A mapping row whose collection starts with this is skipped by the workers (#614).
const DETACHED_PREFIX = 'detached:';

// #614: records the account's mirrors (or just `onlyCollection`) as detached, labelled by provider
// and account identity. A mirror already detached keeps its row.
async function detachMirrors(tx, providers, account, onlyCollection = null) {
  for (const provider of providers) {
    const { table, remote } = MIRROR_TABLES[provider];
    const rows = await tx.all(
      `SELECT local_collection, ${remote} AS remote_id FROM ${table}
        WHERE account_id = ? AND substr(local_collection, 1, ?) != ? AND (? IS NULL OR local_collection = ?)`,
      [account.id, DETACHED_PREFIX.length, DETACHED_PREFIX, onlyCollection, onlyCollection]
    );
    for (const row of rows) {
      await tx.run(
        `INSERT OR IGNORE INTO detached_mirrors
          (user_id, local_collection, provider, account_url, account_username, remote_id, former_account_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [account.userId, row.local_collection, provider, account.url, account.username, row.remote_id, account.id, Date.now()]
      );
    }
  }
}

// #248: params (userId, username, key, key, key). Stored basic-auth URLs are canonical
// and end their path in "/", so a string prefix is a path-segment prefix.
const OVERLAPPING_ACCOUNT =
  'user_id = ? AND username = ? AND (substr(?, 1, length(url)) = url OR substr(url, 1, length(?)) = ?)';

const defaultDbFilename = process.env.NODE_ENV === 'test' ? '../webcalendar.test.db' : '../webcalendar.db';
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, defaultDbFilename);
const dbExistedAtBoot = fs.existsSync(dbPath);
// Issue #259: a database that cannot be opened (e.g. a data directory not writable by this uid)
// is fatal and names the file, so a container restart loop shows its cause in the log.
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) throw new Error(`Cannot open database ${dbPath}: ${err.message}`, { cause: err });
});
// Issue #149: one statement at a time on this connection. Transactions commit on a second
// connection (withTransaction); a write that started inside another statement's read snapshot
// would then fail with SQLITE_BUSY at once instead of waiting out busy_timeout.
db.serialize();

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

  if ((isProd || isStaging) && isWeak && env.ALLOW_INSECURE_ENCRYPTION_KEY !== 'true') {
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

// #72: every stored secret is AES-256-GCM under a key derived with scrypt from the install secret
// and a random salt of its own. Layout, shared with sync-worker/sync_worker.py:
//   iv column (or token part before ':')        = salt (16 bytes) || nonce (12 bytes), hex
//   ciphertext column (or token part after ':') = ciphertext || auth tag (16 bytes), hex
// #348: how long a deleted calendar, task list, event or task stays restorable.
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ENCRYPTION_KEY_STATE = resolveEncryptionKeyState(process.env, dbPath, dbExistedAtBoot);
const ENCRYPTION_SECRET = ENCRYPTION_KEY_STATE.secret;
const ENCRYPTION_KEY_MATERIAL = Buffer.from(ENCRYPTION_SECRET, 'utf8');

// Initialize table and index
let migrated;
db.serialize(() => {
  // WAL: the DB file is shared with the Radicale plugins and the sync-worker;
  // a MEMORY journal would risk corruption on concurrent multi-process writes.
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 30000');
  db.run('PRAGMA foreign_keys = ON');
  // #526: deleted rows (sessions, credentials) are overwritten, not left readable in free pages.
  db.run('PRAGMA secure_delete = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT
    )
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
      created_at INTEGER NOT NULL,
      detail TEXT NOT NULL DEFAULT 'busy'
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
  // #174: events the sync worker has written in a job's current run, shown as sync progress.
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_job_progress (
      job_id TEXT PRIMARY KEY,
      items_done INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES sync_queue(id) ON DELETE CASCADE
    )
  `);
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
  // #193: the sync worker pairs each Google calendar with an opaque local collection
  // (`google-<hex>`), never one derived from the display name. One row per Google
  // calendar per account; a local collection can belong to only one of them.
  db.run(`
    CREATE TABLE IF NOT EXISTS google_calendar_collections (
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      google_calendar_id TEXT NOT NULL,
      local_collection TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, google_calendar_id),
      UNIQUE (user_id, local_collection),
      FOREIGN KEY (account_id) REFERENCES linked_accounts(id) ON DELETE CASCADE
    )
  `);
  // #531: same for Basic-auth CalDAV accounts (`caldav-<hex>`). Only the account's own
  // calendars are mirrored; the remote name is checked against a safe charset first.
  db.run(`
    CREATE TABLE IF NOT EXISTS caldav_calendar_collections (
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      remote_collection TEXT NOT NULL,
      local_collection TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, remote_collection),
      UNIQUE (user_id, local_collection),
      FOREIGN KEY (account_id) REFERENCES linked_accounts(id) ON DELETE CASCADE
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
      account_email TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      reconnect_required INTEGER NOT NULL DEFAULT 0,
      sync_lock_until INTEGER,
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
      e_tag TEXT,
      href TEXT,
      local_etag TEXT
    )
  `);
  // #613: each Microsoft calendar of a linked account is mirrored into its own opaque, VEVENT-only
  // collection (`msgraph-<hex>`); the delta round state is kept per calendar. Mapped events carry
  // the local resource (href) and the ETag the sync last wrote or pushed (local_etag), so the next
  // sync sees what was created, edited or deleted in the shard.
  db.run(`
    CREATE TABLE IF NOT EXISTS msgraph_calendar_collections (
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      graph_calendar_id TEXT NOT NULL,
      local_collection TEXT NOT NULL,
      graph_name TEXT,
      graph_color TEXT,
      delta_link TEXT,
      delta_started_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, graph_calendar_id),
      UNIQUE (user_id, local_collection)
    )
  `);
  // #614: a mirror whose account (or which alone) was disconnected. The collection stays in Radicale
  // as a normal calendar; this row labels it ("früher Google") and remembers the remote calendar, so
  // linking the same account again can offer to re-attach it. While an offer is open, and while a
  // single calendar is detached from a still-linked account, the account's mapping row for the
  // remote calendar points at `detached:<collection>`: the sync workers skip it instead of creating
  // a second mirror.
  db.run(`
    CREATE TABLE IF NOT EXISTS detached_mirrors (
      user_id TEXT NOT NULL,
      local_collection TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_url TEXT,
      account_username TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      former_account_id TEXT NOT NULL,
      claimed_account_id TEXT,
      offer INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, local_collection)
    )
  `);
  // #597: trash items restored into a Microsoft 365 mirror; the worker creates each at Graph.
  db.run(`
    CREATE TABLE IF NOT EXISTS msgraph_restores (
      account_id TEXT NOT NULL,
      href TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, href)
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
      weekly_hours TEXT NOT NULL,
      buffer_minutes INTEGER NOT NULL DEFAULT 0,
      max_bookings_per_day INTEGER,
      min_notice_minutes INTEGER NOT NULL DEFAULT 0,
      busy_calendar_ids TEXT NOT NULL DEFAULT '[]',
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
      created_at INTEGER NOT NULL,
      UNIQUE (page_id, start_time)
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
  // #498: what a user last chose to see; one row per user, absent until they choose.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      task_view TEXT NOT NULL DEFAULT 'kanban' CHECK (task_view IN ('list', 'kanban')),
      secondary_timezone TEXT,
      show_week_numbers INTEGER NOT NULL DEFAULT 0 CHECK (show_week_numbers IN (0, 1)),
      geo_provider TEXT NOT NULL DEFAULT 'off',
      conference_base_url TEXT,
      week_start TEXT CHECK (week_start IN ('mon', 'sun', 'sat')),
      time_format TEXT CHECK (time_format IN ('12h', '24h')),
      default_duration INTEGER NOT NULL DEFAULT 60,
      default_calendar_id TEXT,
      default_reminder INTEGER,
      time_zone TEXT,
      language TEXT CHECK (language IN ('de', 'de-formal', 'en')),
      updated_at INTEGER NOT NULL
    )
  `);
  // #514: the country/region whose public holidays a user sees as a built-in subscription
  // (ISO 3166-2 code, e.g. DE-BY). Absent while the user has not chosen one.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_holiday_region (
      user_id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // #513: where a user wants the weather forecast for, rounded to two decimals (about 1 km).
  // Absent while the weather is off, so nothing is sent to the provider.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_weather_location (
      user_id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // #518: the task lists whose due tasks a user does not want in the calendar views; every other
  // list shows them. Absent until the user turns a list off.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_tasks_hidden_in_calendar (
      user_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      PRIMARY KEY (user_id, calendar_id)
    )
  `);
  // #515: "Als Vorlage speichern" — an event's or task's fields without date and time, per user.
  // Kept here only, never written to Radicale, so no provider sees them.
  db.run(`
    CREATE TABLE IF NOT EXISTS item_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('event', 'task')),
      name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cross_user_deletions (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      deleted_by TEXT NOT NULL,
      href TEXT NOT NULL,
      ics TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // #348: the shard's trash. payload is JSON: { href, ics } for an event or task,
  // { url, name, color, components, items: [{ href, ics }] } for a calendar or task list.
  // #597: origin 'provider' is an item the sync worker found deleted at a linked provider; one
  // from the Microsoft 365 import also carries payload.msgraph = { accountId }.
  db.run(`
    CREATE TABLE IF NOT EXISTS trash_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('event', 'task', 'calendar')),
      calendar_id TEXT NOT NULL,
      title TEXT NOT NULL,
      linked INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'shard' CHECK (origin IN ('shard', 'provider')),
      payload TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_trash_items_user ON trash_items(user_id, deleted_at)');
  db.run(`
    CREATE TABLE IF NOT EXISTS user_calendar_color_overrides (
      user_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      color TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, calendar_id)
    )
  `);
  // #504: the user's order of calendars, task lists and subscriptions (`webcal::<id>`) in the sidebar.
  // Positions count within one sidebar group.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_calendar_order (
      user_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      position INTEGER NOT NULL,
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
  // Indexes on columns added by migrations live in server/utils/migrations.js (004).
  // #333: one value encrypted with the install's key, checked on every boot.
  db.run(`
    CREATE TABLE IF NOT EXISTS encryption_key_check (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // #343: the only place the schema changes after CREATE TABLE; server/index.js exits if it fails.
  migrated = runMigrations(db);
});

// scrypt costs tens of milliseconds; each value's key is derived once per process.
const valueKeys = new WeakMap();

function valueKey(keyMaterial, salt) {
  let keys = valueKeys.get(keyMaterial);
  if (!keys) {
    keys = new Map();
    valueKeys.set(keyMaterial, keys);
  }
  const saltHex = salt.toString('hex');
  if (!keys.has(saltHex)) keys.set(saltHex, crypto.scryptSync(keyMaterial, salt, 32, SCRYPT_PARAMS));
  return keys.get(saltHex);
}

function encryptWithKey(keyMaterial, text) {
  if (typeof text !== 'string') throw new TypeError('Only strings can be encrypted');
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, valueKey(keyMaterial, salt), nonce);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    encrypted: ciphertext.toString('hex'),
    iv: Buffer.concat([salt, nonce]).toString('hex')
  };
}

class DecryptionError extends Error {}

const IV_PATTERN = new RegExp(`^[0-9a-fA-F]{${2 * (SALT_BYTES + NONCE_BYTES)}}$`);

/** Throws DecryptionError for a malformed, tampered or foreign-key value. */
function decryptWithKey(keyMaterial, encryptedHex, ivHex) {
  if (typeof ivHex !== 'string' || !IV_PATTERN.test(ivHex) ||
      typeof encryptedHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(encryptedHex) ||
      encryptedHex.length < 2 * TAG_BYTES) {
    throw new DecryptionError('Stored value is not an AES-256-GCM value of this app');
  }
  const header = Buffer.from(ivHex, 'hex');
  const body = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, valueKey(keyMaterial, header.subarray(0, SALT_BYTES)),
    header.subarray(SALT_BYTES));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
  } catch (err) {
    throw new DecryptionError('Stored value failed authentication (tampered, corrupted or encrypted with another key)',
      { cause: err });
  }
  return plain.toString('utf8');
}

function encrypt(text) {
  return encryptWithKey(ENCRYPTION_KEY_MATERIAL, text);
}

function decrypt(encryptedText, ivHex) {
  return decryptWithKey(ENCRYPTION_KEY_MATERIAL, encryptedText, ivHex);
}

const KEY_CHECK_PLAINTEXT = 'freeshard-webcalendar-key-check-v1';
const ENCRYPTED_TOKEN_PATTERN = new RegExp(`^([0-9a-fA-F]{${2 * (SALT_BYTES + NONCE_BYTES)}}):([0-9a-fA-F]+)$`);

function decryptsWithKey(keyMaterial, cipherHex, ivHex) {
  try {
    return decryptWithKey(keyMaterial, cipherHex, ivHex);
  } catch (err) {
    // Wrong key, corrupted or foreign value: this value does not decrypt.
    if (err instanceof DecryptionError) return null;
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
      const match = typeof token === 'string' && token.match(ENCRYPTED_TOKEN_PATTERN);
      if (match) ciphertexts.push({ ref: `msgraph_accounts/${row.id}`, cipherHex: match[2], ivHex: match[1] });
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
async function verifyEncryptionKey(database, keyMaterial, keyState) {
  const missingKeyHint = keyState.generated
    ? 'No ENCRYPTION_KEY is set and no .encryption_key file was found, so a new key was generated - '
    : '';
  const check = await dbGet(database, 'SELECT ciphertext, iv FROM encryption_key_check WHERE id = 1');
  if (check && decryptsWithKey(keyMaterial, check.ciphertext, check.iv) !== KEY_CHECK_PLAINTEXT) {
    throw new Error(`${missingKeyHint}the configured encryption key cannot decrypt the key-check value of this database. ` +
      'Restore the original .encryption_key / ENCRYPTION_KEY; refusing to start.');
  }

  if (!check) {
    const ciphertexts = await findCiphertexts(database);
    if (ciphertexts.length > 0 && keyState.generated) {
      throw new Error(`${missingKeyHint}but the database already holds ${ciphertexts.length} encrypted credential(s). ` +
        'Restore the original .encryption_key / ENCRYPTION_KEY; refusing to start and not persisting a new encryption key.');
    }
    if (ciphertexts.length > 0 && !ciphertexts.some((c) => decryptsWithKey(keyMaterial,c.cipherHex, c.ivHex) !== null)) {
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
    const { encrypted, iv } = encryptWithKey(keyMaterial, KEY_CHECK_PLAINTEXT);
    await dbRun(database, 'INSERT INTO encryption_key_check (id, ciphertext, iv, created_at) VALUES (1, ?, ?, ?)',
      [encrypted, iv, Date.now()]);
  }
}

// Resolves once the schema migrations have run and the configured key is proven to match this
// database; server/index.js does not listen before then and exits on rejection.
const ready = migrated
  .then(() => verifyEncryptionKey(db, ENCRYPTION_KEY_MATERIAL, ENCRYPTION_KEY_STATE))
  .then(() => purgeCredentialSessions(db));

/**
 * Issue #526: sessions.sess is plain JSON and is copied into every backup. The session store never
 * writes `accounts` (decrypted credentials, SYSTEM_SYNC_SECRET) any more; a row that still carries
 * them, and every expired row, is deleted before the server serves a request or writes a backup.
 * secure_delete zeroes the freed pages; the checkpoint moves them into the database file and
 * truncates the WAL, so the shard backup's file copy holds no residue either.
 */
async function purgeCredentialSessions(database) {
  await dbRun(database,
    `DELETE FROM sessions WHERE expired < ?
       OR NOT json_valid(sess)
       OR json_type(CASE WHEN json_valid(sess) THEN sess END, '$.accounts') IS NOT NULL`,
    [Date.now()]);
  const checkpoint = await dbGet(database, 'PRAGMA wal_checkpoint(TRUNCATE)');
  if (checkpoint.busy) throw new Error('Could not checkpoint the WAL after purging credential-carrying sessions');
}

// ── Transactions (#149) ───────────────────────────────────────────────────────
const txContext = new AsyncLocalStorage();
let txQueue = Promise.resolve();
let txConnection = null;
let savepointSeq = 0;

function openTxConnection() {
  if (!txConnection) {
    txConnection = ready.then(() => new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(dbPath, (err) => {
        if (err) return reject(new Error(`Cannot open database ${dbPath}: ${err.message}`, { cause: err }));
        conn.serialize(() => {
          conn.run('PRAGMA busy_timeout = 30000');
          conn.run('PRAGMA foreign_keys = ON', (pragmaErr) => (pragmaErr ? reject(pragmaErr) : resolve(conn)));
        });
      });
    }));
  }
  return txConnection;
}

function makeTx(conn) {
  const state = { conn, done: false, tx: null };
  const call = (method, sql, params) => new Promise((res, rej) => {
    if (state.done) return rej(new Error('Transaction already finished'));
    conn[method](sql, params, function (err, value) {
      if (err) return rej(err);
      res(method === 'run' ? this : value);
    });
  });
  state.tx = {
    run: (sql, params = []) => call('run', sql, params),
    get: (sql, params = []) => call('get', sql, params),
    all: (sql, params = []) => call('all', sql, params)
  };
  return state;
}

function exec(conn, sql) {
  return new Promise((resolve, reject) => conn.run(sql, (err) => (err ? reject(err) : resolve())));
}

async function runTransaction(fn) {
  const conn = await openTxConnection();
  await exec(conn, 'BEGIN IMMEDIATE');
  const state = makeTx(conn);
  let result;
  try {
    result = await txContext.run(state, () => fn(state.tx));
  } catch (fnErr) {
    state.done = true;
    await exec(conn, 'ROLLBACK');
    throw fnErr;
  }
  state.done = true;
  try {
    await exec(conn, 'COMMIT');
  } catch (commitErr) {
    await exec(conn, 'ROLLBACK');
    throw commitErr;
  }
  return result;
}

async function runSavepoint(outer, fn) {
  const name = `sp_${++savepointSeq}`;
  await outer.tx.run(`SAVEPOINT ${name}`);
  let result;
  try {
    result = await fn(outer.tx);
  } catch (fnErr) {
    await outer.tx.run(`ROLLBACK TO ${name}`);
    await outer.tx.run(`RELEASE ${name}`);
    throw fnErr;
  }
  await outer.tx.run(`RELEASE ${name}`);
  return result;
}

// A token column holds `iv:ciphertext` in one string; an absent token stays absent.
function encryptToken(token) {
  if (token === null || token === undefined || token === '') return token;
  const { encrypted, iv } = encrypt(token);
  return `${iv}:${encrypted}`;
}

function decryptToken(token) {
  if (token === null || token === undefined || token === '') return token;
  const match = typeof token === 'string' && token.match(ENCRYPTED_TOKEN_PATTERN);
  if (!match) throw new DecryptionError('Stored token is not an AES-256-GCM value of this app');
  return decrypt(match[2], match[1]);
}

function msGraphAccountFromRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    accountEmail: r.account_email,
    accessToken: decryptToken(r.access_token),
    refreshToken: decryptToken(r.refresh_token),
    expiresAt: r.expires_at,
    reconnectRequired: r.reconnect_required === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

const Db = {
  getAccounts(userId) {
    return Db._loadAccountRows(userId).then(({ readable }) => readable);
  },

  /**
   * Issue #136: linked_accounts rows whose credentials cannot be decrypted (wrong
   * ENCRYPTION_KEY after a restore, corrupted ciphertext). Returned in a degraded
   * shape without any secret so GET /api/accounts can list them and the user can
   * delete them from the UI. They are never part of getAccounts().
   */
  getUnreadableAccounts(userId) {
    return Db._loadAccountRows(userId).then(({ unreadable }) => unreadable);
  },

  _loadAccountRows(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM linked_accounts WHERE user_id = ?',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          const readable = [];
          const unreadable = [];
          for (const row of rows) {
            let password;
            let accessToken;
            try {
              password = decrypt(row.password_encrypted, row.iv); // decrypts either password or refresh_token
              accessToken = decryptToken(row.access_token);
            } catch (decryptionError) {
              if (!(decryptionError instanceof DecryptionError)) throw decryptionError;
              // Issue #136: one undecryptable row is a broken account, not a broken app.
              console.error(`[db] Skipping undecryptable linked_accounts row id=${row.id}:`, decryptionError.message);
              unreadable.push({
                id: row.id,
                url: row.url,
                username: row.username,
                displayName: row.display_name,
                authType: row.auth_type || 'basic',
                credentialsUnreadable: true
              });
              continue;
            }
            readable.push({
              id: row.id,
              url: row.url,
              username: row.username,
              password,
              displayName: row.display_name,
              authType: row.auth_type || 'basic',
              accessToken,
              expiresAt: row.expires_at
            });
          }
          resolve({ readable, unreadable });
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
              accessToken: decryptToken(row.access_token),
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
   * Returns the user's existing account for `username` whose canonical URL equals
   * or path-prefixes (either way) the canonical form of `url`, null otherwise.
   * Never decrypts credentials.
   */
  findAccountByUrlAndUsername(userId, url, username) {
    const key = canonicalAccountUrl(url);
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, url, username, display_name FROM linked_accounts WHERE ${OVERLAPPING_ACCOUNT}`,
        [userId, username, key, key, key],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? { id: row.id, url: row.url, username: row.username, displayName: row.display_name } : null);
        }
      );
    });
  },

  /**
   * Stores the URL in canonical form (#248). Check and insert are one statement, so
   * a concurrent POST with another spelling of the same server cannot slip in a
   * second row; that case rejects with err.code === 'ACCOUNT_EXISTS'.
   */
  addAccount(userId, { url, username, password, displayName }) {
    const key = canonicalAccountUrl(url);
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const { encrypted, iv } = encrypt(password);
      db.run(
        `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM linked_accounts WHERE ${OVERLAPPING_ACCOUNT})`,
        [id, userId, key, username, encrypted, iv, displayName || username, 'basic',
          userId, username, key, key, key],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) {
            const exists = new Error(`Account ${username} at ${key} is already linked`);
            exists.code = 'ACCOUNT_EXISTS';
            return reject(exists);
          }
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
        [id, userId, url, username, encrypted, iv, displayName || username, 'oauth2', encryptToken(accessToken), expiresAt],
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
        [encryptToken(accessToken), expiresAt, id],
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

  // #496: { local collection name → { accountId, accountName } } for every collection the sync
  // worker mirrors from one of the user's linked accounts (Google and Basic-auth CalDAV, whose names
  // the client looks up in its account list, and Microsoft 365 (#613), named by its e-mail address).
  getMirroredCollectionAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT local_collection, account_id, NULL AS account_name FROM google_calendar_collections WHERE user_id = ?
         UNION ALL
         SELECT local_collection, account_id, NULL AS account_name FROM caldav_calendar_collections WHERE user_id = ?
         UNION ALL
         SELECT m.local_collection, m.account_id, a.account_email AS account_name
           FROM msgraph_calendar_collections m JOIN msgraph_accounts a ON a.id = m.account_id
          WHERE m.user_id = ?`,
        [userId, userId, userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(new Map(rows.map(r => [r.local_collection, { accountId: r.account_id, accountName: r.account_name }])));
        }
      );
    });
  },

  // #614: disconnecting stops the sync and deletes nothing: each mirror stays in Radicale as a normal
  // calendar, remembered in detached_mirrors so linking the account again can offer to re-attach it.
  deleteAccount(id) {
    return this.withTransaction(async (tx) => {
      const account = await tx.get('SELECT user_id, url, username FROM linked_accounts WHERE id = ?', [id]);
      if (account) {
        await detachMirrors(tx, ['google', 'caldav'], { id, userId: account.user_id, url: account.url, username: account.username });
      }
      await tx.run('UPDATE detached_mirrors SET claimed_account_id = NULL WHERE claimed_account_id = ?', [id]);
      await tx.run('DELETE FROM linked_accounts WHERE id = ?', [id]);
    });
  },

  // #614: { local collection → { provider, accountUsername } } for the user's detached mirrors.
  async getDetachedMirrors(userId) {
    const rows = await dbAll(db, 'SELECT local_collection, provider, account_username FROM detached_mirrors WHERE user_id = ?', [userId]);
    return new Map(rows.map(r => [r.local_collection, { provider: r.provider, accountUsername: r.account_username }]));
  },

  // #614: detaches one mirrored calendar from its still-linked account; false if it is no mirror.
  detachCalendar(userId, collection) {
    return this.withTransaction(async (tx) => {
      for (const [provider, { table }] of Object.entries(MIRROR_TABLES)) {
        const row = await tx.get(`SELECT account_id FROM ${table} WHERE user_id = ? AND local_collection = ?`, [userId, collection]);
        if (!row) continue;
        const account = provider === 'msgraph'
          ? await tx.get('SELECT NULL AS url, account_email AS username FROM msgraph_accounts WHERE id = ?', [row.account_id])
          : await tx.get('SELECT url, username FROM linked_accounts WHERE id = ?', [row.account_id]);
        if (!account) throw new Error(`Mirror ${collection} belongs to no account`);
        await detachMirrors(tx, [provider], { id: row.account_id, userId, url: account.url, username: account.username }, collection);
        await tx.run(`UPDATE ${table} SET local_collection = ? WHERE account_id = ? AND local_collection = ?`,
          [`${DETACHED_PREFIX}${collection}`, row.account_id, collection]);
        return true;
      }
      return false;
    });
  },

  // #614: pairs each detached mirror whose account is linked again (same provider and identity, a new
  // account row) with that account. Its mapping row points at `detached:<collection>`, so the workers
  // neither sync the remote calendar nor mirror it a second time until the user decides.
  claimDetachedMirrors(userId) {
    return this.withTransaction(async (tx) => {
      const rows = await tx.all(
        'SELECT * FROM detached_mirrors WHERE user_id = ? AND offer = 1 AND claimed_account_id IS NULL', [userId]);
      if (!rows.length) return;
      const linked = await tx.all('SELECT id, url, username, auth_type FROM linked_accounts WHERE user_id = ?', [userId]);
      const graph = await tx.all('SELECT id, account_email FROM msgraph_accounts WHERE user_id = ?', [userId]);
      const existing = new Set([...linked.map(a => a.id), ...graph.map(a => a.id)]);
      const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
      for (const row of rows) {
        // A calendar detached on its own from a still-linked account is not offered.
        if (existing.has(row.former_account_id)) continue;
        let match;
        if (row.provider === 'msgraph') {
          match = graph.find(a => sameName(a.account_email, row.account_username));
        } else if (row.provider === 'google') {
          match = linked.find(a => a.auth_type === 'oauth2' && sameName(a.username, row.account_username));
        } else {
          match = linked.find(a => a.auth_type !== 'oauth2' && a.username === row.account_username &&
            sameAccountUrl(a.url, row.account_url));
        }
        if (!match) continue;
        const { table, remote } = MIRROR_TABLES[row.provider];
        // The account synced before this claim and already mirrors the remote calendar anew.
        if (await tx.get(`SELECT 1 FROM ${table} WHERE account_id = ? AND ${remote} = ?`, [match.id, row.remote_id])) continue;
        await tx.run(
          `INSERT INTO ${table} (account_id, user_id, ${remote}, local_collection, created_at) VALUES (?, ?, ?, ?, ?)`,
          [match.id, userId, row.remote_id, `${DETACHED_PREFIX}${row.local_collection}`, Date.now()]
        );
        await tx.run('UPDATE detached_mirrors SET claimed_account_id = ? WHERE user_id = ? AND local_collection = ?',
          [match.id, userId, row.local_collection]);
      }
    });
  },

  // #614: the detached calendars a newly linked account can take back.
  async getReattachOffers(userId) {
    await this.claimDetachedMirrors(userId);
    const rows = await dbAll(db,
      `SELECT local_collection, provider, account_username FROM detached_mirrors
        WHERE user_id = ? AND offer = 1 AND claimed_account_id IS NOT NULL ORDER BY created_at, local_collection`,
      [userId]);
    return rows.map(r => ({
      calendarId: `internal-caldav::/${userId}/${r.local_collection}/`,
      provider: r.provider,
      accountUsername: r.account_username
    }));
  },

  // #614: accepting re-attaches every offered calendar: its mapping points at the collection again,
  // and a Microsoft 365 mirror's event mappings move to the new account, so the next sync matches each
  // event instead of copying it. Declining leaves them normal calendars; the account mirrors anew.
  resolveReattachOffers(userId, accept) {
    return this.withTransaction(async (tx) => {
      const rows = await tx.all(
        'SELECT * FROM detached_mirrors WHERE user_id = ? AND offer = 1 AND claimed_account_id IS NOT NULL', [userId]);
      for (const row of rows) {
        const { table, remote } = MIRROR_TABLES[row.provider];
        const where = `account_id = ? AND ${remote} = ? AND local_collection = ?`;
        const params = [row.claimed_account_id, row.remote_id, `${DETACHED_PREFIX}${row.local_collection}`];
        if (accept) {
          await tx.run(`UPDATE ${table} SET local_collection = ? WHERE ${where}`, [row.local_collection, ...params]);
          if (row.provider === 'msgraph') {
            const prefix = `/${userId}/${row.local_collection}/`;
            await tx.run('UPDATE msgraph_event_mappings SET account_id = ? WHERE account_id = ? AND substr(href, 1, ?) = ?',
              [row.claimed_account_id, row.former_account_id, prefix.length, prefix]);
          }
          await tx.run('DELETE FROM detached_mirrors WHERE user_id = ? AND local_collection = ?', [userId, row.local_collection]);
        } else {
          await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);
          await tx.run('UPDATE detached_mirrors SET offer = 0, claimed_account_id = NULL WHERE user_id = ? AND local_collection = ?',
            [userId, row.local_collection]);
        }
      }
      return rows.length;
    });
  },

  // Issue #149: runs fn(tx) atomically. Transactions use their own connection, so the autocommit
  // statements other requests send on `db` never land inside them, and run one at a time in this
  // process under BEGIN IMMEDIATE (the sync worker and Radicale write this file too). A call made
  // from inside fn — the same async context, tracked with AsyncLocalStorage — becomes a SAVEPOINT
  // of the enclosing transaction; an unrelated caller that merely overlaps in time waits its turn.
  // Inside fn, write through tx only: a write on `db` waits for this transaction's lock.
  withTransaction(fn) {
    const outer = txContext.getStore();
    // A continuation fn left running after its transaction finished is no longer nested in it.
    if (outer && !outer.done) return runSavepoint(outer, fn);
    const run = () => runTransaction(fn);
    const result = txQueue.then(run, run);
    txQueue = result.then(() => undefined, () => undefined);
    return result;
  },

  cleanUserTmpCredentials(userId) {
    if (!userId) return;
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) return;
    for (const file of fs.readdirSync(tmpDir)) {
      if (file.startsWith(`vdir_${userId}.ini`) ||
          file.startsWith(`vdir_basic_${userId}.ini`) ||
          file.startsWith(`google_token_${userId}_`)) {
        try {
          fs.unlinkSync(path.join(tmpDir, file));
        } catch (err) {
          // Removed concurrently (e.g. by the sync worker): already gone. Any other failure leaves
          // plaintext credentials behind and must stop the user deletion (#196, #343).
          if (err.code !== 'ENOENT') throw err;
        }
      }
    }
  },

  deleteUser(userId) {
    if (!userId) return Promise.resolve();
    try {
      this.cleanUserTmpCredentials(userId);
    } catch (err) {
      return Promise.reject(err);
    }
    const calPattern = `%${userId}%`;
    return this.withTransaction(async (tx) => {
      await tx.run('DELETE FROM users WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM linked_accounts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM app_passwords WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM sync_queue WHERE user_id = ? OR user_id LIKE ?', [userId, `${userId}%`]);
      await tx.run('DELETE FROM user_calendar_shares WHERE sharee_user_id = ? OR calendar_id LIKE ?', [userId, calPattern]);
      await tx.run('DELETE FROM msgraph_event_mappings WHERE account_id IN (SELECT id FROM msgraph_accounts WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM msgraph_event_mappings WHERE account_id IN (SELECT former_account_id FROM detached_mirrors WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM detached_mirrors WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM msgraph_restores WHERE account_id IN (SELECT id FROM msgraph_accounts WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM msgraph_calendar_collections WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM msgraph_accounts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM web_push_subscriptions WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM resource_bookings WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM slot_bookings WHERE page_id IN (SELECT id FROM availability_pages WHERE user_id = ?)', [userId]);
      await tx.run('DELETE FROM availability_pages WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM sync_conflicts WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM delegate_permissions WHERE principal_user_id = ? OR delegate_user_id = ?', [userId, userId]);
      await tx.run('DELETE FROM working_hours_policy WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_preferences WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_tasks_hidden_in_calendar WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_holiday_region WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_weather_location WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM item_templates WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM cross_user_deletions WHERE owner_user_id = ? OR deleted_by = ?', [userId, userId]);
      await tx.run('DELETE FROM trash_items WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_calendar_color_overrides WHERE user_id = ?', [userId]);
      await tx.run('DELETE FROM user_calendar_order WHERE user_id = ?', [userId]);
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
      await tx.run('DELETE FROM user_calendar_order WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM user_tasks_hidden_in_calendar WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM calendar_sync_cache WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      // #614: a deleted former mirror is no longer offered for re-attaching.
      await tx.run(
        "DELETE FROM detached_mirrors WHERE 'internal-caldav::/' || user_id || '/' || local_collection || '/' IN (?, ?)",
        [calendarId, altId]
      );
      await tx.run('DELETE FROM sync_conflicts WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM cross_user_deletions WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run('DELETE FROM delegate_permissions WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      await tx.run(
        'DELETE FROM slot_bookings WHERE page_id IN (SELECT id FROM availability_pages WHERE calendar_id = ? OR calendar_id = ?)',
        [calendarId, altId]
      );
      await tx.run('DELETE FROM availability_pages WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      // A deleted calendar no longer feeds busy time into other booking pages (#345).
      await tx.run(
        `UPDATE availability_pages SET busy_calendar_ids = (
           SELECT json_group_array(value) FROM json_each(availability_pages.busy_calendar_ids) WHERE value NOT IN (?, ?)
         ) WHERE EXISTS (SELECT 1 FROM json_each(availability_pages.busy_calendar_ids) WHERE value IN (?, ?))`,
        [calendarId, altId, calendarId, altId]
      );
      await tx.run('DELETE FROM event_history WHERE calendar_id = ? OR calendar_id = ?', [calendarId, altId]);
      // #613: a deleted Microsoft 365 mirror is unpaired, so its events are not deleted at Microsoft;
      // the next sync mirrors that calendar afresh.
      const mirror = /^internal-caldav::\/([^/]+)\/([^/]+)\/?$/.exec(calendarId);
      if (mirror) {
        const prefix = `/${mirror[1]}/${mirror[2]}/`;
        await tx.run('DELETE FROM msgraph_event_mappings WHERE substr(href, 1, ?) = ?', [prefix.length, prefix]);
        await tx.run('DELETE FROM msgraph_calendar_collections WHERE user_id = ? AND local_collection = ?', [mirror[1], mirror[2]]);
      }
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
      await tx.run('DELETE FROM user_calendar_order');
      await tx.run('DELETE FROM user_tasks_hidden_in_calendar');
      await tx.run('DELETE FROM user_holiday_region');
      await tx.run('DELETE FROM user_weather_location');
      await tx.run('DELETE FROM webcal_subscriptions');
      await tx.run('DELETE FROM sync_queue');
      await tx.run('DELETE FROM trash_items');
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
        'SELECT token, label, created_at, detail FROM calendar_shares WHERE calendar_id = ? ORDER BY created_at DESC',
        [calendarId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({
            token: r.token,
            label: r.label,
            createdAt: r.created_at,
            detail: r.detail
          })));
        }
      );
    });
  },

  addCalendarShare(calendarId, label, detail = 'busy') {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(24).toString('hex'); // unique random path token
      const now = Date.now();

      db.run(
        'INSERT INTO calendar_shares (token, calendar_id, label, created_at, detail) VALUES (?, ?, ?, ?, ?)',
        [token, calendarId, label, now, detail],
        (err) => {
          if (err) return reject(err);
          resolve({ token, calendarId, label, createdAt: now, detail });
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
        // A job without a progress row has written nothing in its current run yet.
        'SELECT q.id, q.user_id, q.status, q.error_message, q.attempts, q.max_attempts, q.next_retry_at, q.retry_state, COALESCE(p.items_done, 0) AS items_done, q.created_at, q.updated_at' +
        ' FROM sync_queue q LEFT JOIN sync_job_progress p ON p.job_id = q.id WHERE q.id = ?',
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
            itemsDone: row.items_done,
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
        'SELECT q.id, q.user_id, q.status, q.error_message, q.attempts, q.max_attempts, q.next_retry_at, q.retry_state, COALESCE(p.items_done, 0) AS items_done, q.created_at, q.updated_at' +
        ' FROM sync_queue q LEFT JOIN sync_job_progress p ON p.job_id = q.id WHERE q.user_id = ? ORDER BY q.created_at DESC',
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
            // Events the sync worker has written in this run so far (#174).
            itemsDone: row.items_done,
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

  // null when no such user exists (#121).
  getUsernameByUserId(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT username FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.username : null);
      });
    });
  },

  getUserIdByUsername(username) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT user_id FROM users WHERE username = ? OR user_id = ? OR username LIKE ?',
        [username, username, `${username}@%`],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
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
         (id, user_id, account_email, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          accountData.userId,
          accountData.accountEmail,
          encAccess,
          encRefresh,
          accountData.expiresAt || 0,
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
        `SELECT id, user_id, account_email, access_token, refresh_token, expires_at, reconnect_required, created_at, updated_at
         FROM msgraph_accounts WHERE user_id = ? ORDER BY created_at ASC`,
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          // #72: a token that fails to decrypt rejects the read, never reaches the caller altered.
          try {
            resolve(rows.map(msGraphAccountFromRow));
          } catch (decryptionError) {
            reject(decryptionError);
          }
        }
      );
    });
  },

  getMSGraphAccountById(accountId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, user_id, account_email, access_token, refresh_token, expires_at, reconnect_required, created_at, updated_at
         FROM msgraph_accounts WHERE id = ?`,
        [accountId],
        (err, r) => {
          if (err) return reject(err);
          if (!r) return resolve(null);
          try {
            resolve(msGraphAccountFromRow(r));
          } catch (decryptionError) {
            reject(decryptionError);
          }
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
      if (updates.reconnectRequired !== undefined) { fields.push('reconnect_required = ?'); values.push(updates.reconnectRequired ? 1 : 0); }
      
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
      const account = await tx.get('SELECT user_id, account_email FROM msgraph_accounts WHERE id = ?', [accountId]);
      if (account) {
        await detachMirrors(tx, ['msgraph'], { id: accountId, userId: account.user_id, url: null, username: account.account_email });
      }
      await tx.run('UPDATE detached_mirrors SET claimed_account_id = NULL WHERE claimed_account_id = ?', [accountId]);
      await tx.run(`DELETE FROM msgraph_accounts WHERE id = ?`, [accountId]);
      await tx.run(`DELETE FROM msgraph_restores WHERE account_id = ?`, [accountId]);
      // #613/#614: the mirrors stay in Radicale as the user's own calendars, no longer synced. Their
      // event mappings stay too, so a re-attach (#614) matches each event instead of copying it.
      await tx.run(`DELETE FROM msgraph_calendar_collections WHERE account_id = ?`, [accountId]);
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
  // #503: weeklyHours is required (see utils/availabilityBooking.js); there is no implicit week.
  createAvailabilityPage({ id, userId, slug, title, calendarId, durationMinutes = 30, weeklyHours, bufferMinutes = 0, maxBookingsPerDay = null, minNoticeMinutes = 0, busyCalendarIds = [] }) {
    return new Promise((resolve, reject) => {
      const pageId = id || `ap-${uuidv4()}`;
      const now = Date.now();
      db.run(
        `INSERT INTO availability_pages (id, user_id, slug, title, calendar_id, duration_minutes, weekly_hours, buffer_minutes, max_bookings_per_day, min_notice_minutes, busy_calendar_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pageId, userId, slug, title, calendarId, durationMinutes, JSON.stringify(weeklyHours), bufferMinutes, maxBookingsPerDay, minNoticeMinutes, JSON.stringify(busyCalendarIds), now],
        (err) => {
          if (err) return reject(err);
          resolve({
            id: pageId,
            userId,
            slug,
            title,
            calendarId,
            durationMinutes,
            weeklyHours,
            bufferMinutes,
            maxBookingsPerDay,
            minNoticeMinutes,
            busyCalendarIds,
            createdAt: now
          });
        }
      );
    });
  },

  getAvailabilityPages(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, user_id, slug, title, calendar_id, duration_minutes, weekly_hours, buffer_minutes, max_bookings_per_day, min_notice_minutes, busy_calendar_ids, created_at
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
            weeklyHours: JSON.parse(r.weekly_hours),
            bufferMinutes: r.buffer_minutes,
            maxBookingsPerDay: r.max_bookings_per_day,
            minNoticeMinutes: r.min_notice_minutes,
            busyCalendarIds: JSON.parse(r.busy_calendar_ids),
            createdAt: r.created_at
          })));
        }
      );
    });
  },

  getAvailabilityPageBySlug(slug) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT id, user_id, slug, title, calendar_id, duration_minutes, weekly_hours, buffer_minutes, max_bookings_per_day, min_notice_minutes, busy_calendar_ids, created_at
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
            weeklyHours: JSON.parse(r.weekly_hours),
            bufferMinutes: r.buffer_minutes,
            maxBookingsPerDay: r.max_bookings_per_day,
            minNoticeMinutes: r.min_notice_minutes,
            busyCalendarIds: JSON.parse(r.busy_calendar_ids),
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

  deleteDelegatePermission(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM delegate_permissions WHERE id = ? AND (principal_user_id = ? OR delegate_user_id = ?)`, [id, userId, userId], function(err) {
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

  // #498: the task area shows the kanban board until the user picks the list.
  getTaskViewPreference(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT task_view FROM user_preferences WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.task_view : 'kanban');
      });
    });
  },

  setTaskViewPreference(userId, taskView) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, task_view, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET task_view = excluded.task_view, updated_at = excluded.updated_at`,
        [userId, taskView, Date.now()],
        (err) => (err ? reject(err) : resolve(taskView))
      );
    });
  },

  // #512: the address lookup / map service a user opted into; 'off' until they choose one.
  getGeoProviderPreference(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT geo_provider FROM user_preferences WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.geo_provider : 'off');
      });
    });
  },

  setGeoProviderPreference(userId, provider) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, geo_provider, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET geo_provider = excluded.geo_provider, updated_at = excluded.updated_at`,
        [userId, provider, Date.now()],
        (err) => (err ? reject(err) : resolve(provider))
      );
    });
  },

  // #518: ids of the task lists whose due tasks stay out of the user's calendar views.
  async getTasksHiddenInCalendar(userId) {
    const rows = await dbAll(db,
      'SELECT calendar_id FROM user_tasks_hidden_in_calendar WHERE user_id = ? ORDER BY calendar_id', [userId]);
    return rows.map(r => r.calendar_id);
  },

  setTaskListInCalendar(userId, calendarId, shown) {
    const sql = shown
      ? 'DELETE FROM user_tasks_hidden_in_calendar WHERE user_id = ? AND calendar_id = ?'
      : 'INSERT OR IGNORE INTO user_tasks_hidden_in_calendar (user_id, calendar_id) VALUES (?, ?)';
    return new Promise((resolve, reject) => {
      db.run(sql, [userId, calendarId], (err) => (err ? reject(err) : resolve()));
    });
  },

  // #517: ISO week numbers in the grids and the mini month; off until the user switches them on.
  getWeekNumbersPreference(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT show_week_numbers FROM user_preferences WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.show_week_numbers === 1 : false);
      });
    });
  },

  setWeekNumbersPreference(userId, show) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, show_week_numbers, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET show_week_numbers = excluded.show_week_numbers, updated_at = excluded.updated_at`,
        [userId, show ? 1 : 0, Date.now()],
        (err) => (err ? reject(err) : resolve(show))
      );
    });
  },

  // #521: the Jitsi base URL for "Videokonferenz hinzufügen"; null (off) until the user sets one.
  getConferenceBaseUrlPreference(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT conference_base_url FROM user_preferences WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.conference_base_url : null);
      });
    });
  },

  setConferenceBaseUrlPreference(userId, url) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, conference_base_url, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET conference_base_url = excluded.conference_base_url, updated_at = excluded.updated_at`,
        [userId, url, Date.now()],
        (err) => (err ? reject(err) : resolve(url))
      );
    });
  },

  // #625: week start, 12/24 h, default duration/calendar/reminder and time zone; #626: the UI
  // language. null = not chosen.
  getCalendarPreferences(userId) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT week_start, time_format, default_duration, default_calendar_id, default_reminder, time_zone, language
              FROM user_preferences WHERE user_id = ?`, [userId], (err, row) => {
        if (err) return reject(err);
        resolve({
          weekStart: row ? row.week_start : null,
          timeFormat: row ? row.time_format : null,
          defaultDuration: row ? row.default_duration : 60,
          defaultCalendarId: row ? row.default_calendar_id : null,
          defaultReminder: row ? row.default_reminder : null,
          timeZone: row ? row.time_zone : null,
          language: row ? row.language : null,
        });
      });
    });
  },

  // `values` maps keys of getCalendarPreferences to values the route has validated.
  setCalendarPreferences(userId, values) {
    const COLUMNS = {
      weekStart: 'week_start', timeFormat: 'time_format', defaultDuration: 'default_duration',
      defaultCalendarId: 'default_calendar_id', defaultReminder: 'default_reminder', timeZone: 'time_zone',
      language: 'language',
    };
    const keys = Object.keys(values);
    for (const key of keys) {
      if (!Object.hasOwn(COLUMNS, key)) throw new Error(`Unknown calendar preference: ${key}`);
    }
    const columns = keys.map(k => COLUMNS[k]);
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, ${columns.join(', ')}, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${columns.map(c => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`,
        [userId, ...keys.map(k => values[k]), Date.now()],
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  // #515: the user's templates of one kind, oldest first.
  async listTemplates(userId, kind) {
    const rows = await dbAll(db,
      'SELECT id, kind, name, fields FROM item_templates WHERE user_id = ? AND kind = ? ORDER BY created_at, rowid',
      [userId, kind]);
    return rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, fields: JSON.parse(r.fields) }));
  },

  createTemplate(userId, { kind, name, fields }) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO item_templates (id, user_id, kind, name, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, userId, kind, name, JSON.stringify(fields), Date.now()],
        (err) => (err ? reject(err) : resolve({ id, kind, name, fields }))
      );
    });
  },

  // True when the user had such a template.
  deleteTemplate(userId, id) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM item_templates WHERE id = ? AND user_id = ?', [id, userId], function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      });
    });
  },

  // #509: the second time zone column of the week/day grid; null while switched off.
  getSecondaryTimezonePreference(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT secondary_timezone FROM user_preferences WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.secondary_timezone : null);
      });
    });
  },

  setSecondaryTimezonePreference(userId, timeZone) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_preferences (user_id, secondary_timezone, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET secondary_timezone = excluded.secondary_timezone, updated_at = excluded.updated_at`,
        [userId, timeZone, Date.now()],
        (err) => (err ? reject(err) : resolve(timeZone))
      );
    });
  },

  // #514: the holiday region a user chose, or null.
  getHolidayRegion(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT region FROM user_holiday_region WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.region : null);
      });
    });
  },

  // null switches the holidays off.
  setHolidayRegion(userId, region) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(region));
      if (region === null) {
        db.run('DELETE FROM user_holiday_region WHERE user_id = ?', [userId], done);
      } else {
        db.run(
          `INSERT INTO user_holiday_region (user_id, region, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET region = excluded.region, updated_at = excluded.updated_at`,
          [userId, region, Date.now()], done
        );
      }
    });
  },

  // #513: the weather location a user set, { latitude, longitude } or null.
  getWeatherLocation(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT latitude, longitude FROM user_weather_location WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row ? { latitude: row.latitude, longitude: row.longitude } : null);
      });
    });
  },

  // null switches the weather off.
  setWeatherLocation(userId, location) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(location));
      if (location === null) {
        db.run('DELETE FROM user_weather_location WHERE user_id = ?', [userId], done);
      } else {
        db.run(
          `INSERT INTO user_weather_location (user_id, latitude, longitude, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude,
             updated_at = excluded.updated_at`,
          [userId, location.latitude, location.longitude, Date.now()], done
        );
      }
    });
  },

  // Whether the user's sync writes calendars out to an external account: the two-way CalDAV and
  // Google pairs (linked_accounts). Microsoft 365 (msgraph_accounts) only imports.
  hasExternalAccounts(userId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT EXISTS (SELECT 1 FROM linked_accounts WHERE user_id = ?) AS has_accounts',
        [userId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row.has_accounts === 1);
        }
      );
    });
  },

  // href and ics are the deleted resource as Radicale stored it; the sync worker puts it back (#319).
  recordCrossUserDeletion(uid, calendarId, ownerUserId, deletedBy, href, ics) {
    return new Promise((resolve, reject) => {
      const id = require('node:crypto').randomUUID();
      const createdAt = Date.now();
      db.run(
        `INSERT INTO cross_user_deletions (id, uid, calendar_id, owner_user_id, deleted_by, href, ics, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, uid, calendarId, ownerUserId, deletedBy, href, ics, createdAt],
        function(err) {
          if (err) return reject(err);
          resolve({ id, uid, calendarId, ownerUserId, deletedBy, href, createdAt });
        }
      );
    });
  },

  getCrossUserDeletions(ownerUserId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, uid, calendar_id, owner_user_id, deleted_by, href, ics, created_at
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

  // ── Trash (#348) ───────────────────────────────────────────────────────────
  addTrashItem({ userId, kind, calendarId, title, linked = false, payload, deletedAt = Date.now() }) {
    const id = require('node:crypto').randomUUID();
    return dbRun(db,
      `INSERT INTO trash_items (id, user_id, kind, calendar_id, title, linked, payload, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, kind, calendarId, title, linked ? 1 : 0, JSON.stringify(payload), deletedAt]
    ).then(() => id);
  },

  // Newest first, without the payload (a calendar's can be large).
  async listTrashItems(userId, now = Date.now()) {
    await this.purgeExpiredTrash(now);
    const rows = await dbAll(db,
      `SELECT id, kind, calendar_id, title, linked, origin, deleted_at,
              CASE WHEN kind = 'calendar' THEN json_array_length(payload, '$.items') END AS item_count,
              CASE WHEN kind = 'calendar' THEN json_extract(payload, '$.components') END AS components
       FROM trash_items WHERE user_id = ? ORDER BY deleted_at DESC`,
      [userId]);
    return rows.map(r => ({
      id: r.id,
      kind: r.kind,
      calendarId: r.calendar_id,
      title: r.title,
      linked: r.linked === 1,
      deletedAtProvider: r.origin === 'provider',
      deletedAt: new Date(r.deleted_at).toISOString(),
      purgeAt: new Date(r.deleted_at + TRASH_RETENTION_MS).toISOString(),
      ...(r.kind === 'calendar' ? { itemCount: r.item_count, components: JSON.parse(r.components) } : {})
    }));
  },

  async getTrashItem(id, userId) {
    const r = await dbGet(db,
      'SELECT id, kind, calendar_id, title, linked, payload, deleted_at FROM trash_items WHERE id = ? AND user_id = ?',
      [id, userId]);
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, calendarId: r.calendar_id, title: r.title, linked: r.linked === 1,
      payload: JSON.parse(r.payload), deletedAt: r.deleted_at
    };
  },

  deleteTrashItem(id, userId) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM trash_items WHERE id = ? AND user_id = ?', [id, userId], function(err) {
        if (err) return reject(err);
        resolve(this.changes);
      });
    });
  },

  // #597: the Microsoft 365 import creates the restored item at Graph on its next sync. An
  // account disconnected meanwhile leaves the item a plain local one.
  addMSGraphRestore(userId, accountId, href) {
    return dbRun(db,
      `INSERT OR IGNORE INTO msgraph_restores (account_id, href, created_at)
       SELECT id, ?, ? FROM msgraph_accounts WHERE id = ? AND user_id = ?`,
      [href, Date.now(), accountId, userId]);
  },

  purgeExpiredTrash(now = Date.now()) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM trash_items WHERE deleted_at <= ?', [now - TRASH_RETENTION_MS], function(err) {
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

  // #504: `calendarIds` is one sidebar group in its new order.
  setUserCalendarOrder(userId, calendarIds) {
    return this.withTransaction(async (tx) => {
      for (const [position, calendarId] of calendarIds.entries()) {
        await tx.run(
          'INSERT OR REPLACE INTO user_calendar_order (user_id, calendar_id, position) VALUES (?, ?, ?)',
          [userId, calendarId, position]
        );
      }
    });
  },

  // Map calendarId -> position.
  getUserCalendarOrder(userId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT calendar_id, position FROM user_calendar_order WHERE user_id = ?', [userId], (err, rows) => {
        if (err) return reject(err);
        resolve(new Map(rows.map(r => [r.calendar_id, r.position])));
      });
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

  getEventHistoryInCalendar(eventUid, calendarId, limit = 50) {
    if (!calendarId) return Promise.reject(new Error('getEventHistoryInCalendar: calendarId is required'));
    // Rows keep the calendarId the writer sent; with and without trailing slash name the same calendar.
    const altId = calendarId.endsWith('/') ? calendarId.slice(0, -1) : `${calendarId}/`;
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM event_history WHERE event_uid = ? AND calendar_id IN (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        [eventUid, calendarId, altId, limit],
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
        if (!row || typeof row.busy !== 'number') {
          return reject(new Error(`PRAGMA wal_checkpoint(${normalizedMode}) returned no result; is the database in WAL mode?`));
        }
        resolve({ busy: row.busy, log: row.log, checkpointed: row.checkpointed });
      });
    });
  },

  // Issue #120: a consistent copy of the live database for the shard backup, which copies the
  // data directory file by file and would tear the live WAL triplet. VACUUM INTO reads within one
  // transaction, so it includes commits still in the WAL and is not torn by concurrent writers.
  // It writes a temp file, checks it, and renames it into place, so targetPath is always whole.
  async createBackup(targetPath) {
    if (!targetPath) {
      throw new Error('targetPath is required for database backup');
    }
    await ready;
    const tmpPath = `${targetPath}.tmp`;
    // VACUUM INTO refuses an existing file; a leftover from an interrupted run is never valid.
    fs.rmSync(tmpPath, { force: true });
    await new Promise((resolve, reject) => {
      db.run('VACUUM INTO ?', [tmpPath], (err) => (err ? reject(err) : resolve()));
    });
    if (!(await this.verifyDatabaseIntegrity(tmpPath))) {
      fs.rmSync(tmpPath, { force: true });
      throw new Error(`Database snapshot ${tmpPath} failed PRAGMA integrity_check`);
    }
    fs.renameSync(tmpPath, targetPath);
    return { backupPath: targetPath, size: fs.statSync(targetPath).size };
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

  // Issue #270: a fresh read-only connection, so the check reads the file as it is on disk now.
  // The long-lived connection keeps working on a deleted or replaced file and would stay green.
  checkHealth() {
    return new Promise((resolve, reject) => {
      const probe = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
        if (openErr) return reject(openErr);
        probe.get('SELECT count(*) AS n FROM sqlite_master', (err) => {
          probe.close((closeErr) => {
            if (err || closeErr) return reject(err || closeErr);
            resolve(true);
          });
        });
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
Db.backupPath = `${dbPath}.backup`;

module.exports = Db;
module.exports.validateEncryptionKey = validateEncryptionKey;
module.exports.resolveEncryptionKey = resolveEncryptionKey;
module.exports.ready = ready;
module.exports.TRASH_RETENTION_MS = TRASH_RETENTION_MS;
module.exports.withTransaction = Db.withTransaction.bind(Db);
module.exports.getSchemaVersion = Db.getSchemaVersion;
module.exports.setSchemaVersion = Db.setSchemaVersion;
module.exports.runMigrations = Db.runMigrations;
module.exports.migrations = migrations;
module.exports.db = db;
module.exports.getDbPath = Db.getDbPath;
module.exports.dbPath = dbPath;
