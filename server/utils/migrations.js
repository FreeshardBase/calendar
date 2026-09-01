'use strict';

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        // If column already exists (e.g. legacy databases), swallow duplicate column error gracefully
        if (err.message && err.message.includes('duplicate column')) {
          return resolve(this);
        }
        return reject(err);
      }
      resolve(this);
    });
  });
}

function getSchemaVersion(db) {
  return new Promise((resolve, reject) => {
    db.get('PRAGMA user_version', (err, row) => {
      if (err) return reject(err);
      const version = row ? (row.user_version ?? Object.values(row)[0] ?? 0) : 0;
      resolve(Number(version) || 0);
    });
  });
}

function setSchemaVersion(db, version) {
  const v = Math.max(0, parseInt(version, 10) || 0);
  return runSql(db, `PRAGMA user_version = ${v}`);
}

const MIGRATIONS = [
  {
    version: 1,
    name: '001_linked_accounts_columns_and_urls',
    up: async (db) => {
      await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN auth_type TEXT DEFAULT 'basic'");
      await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN access_token TEXT");
      await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN expires_at INTEGER");
      await runSql(db, `
        UPDATE linked_accounts 
        SET url = 'https://apidata.googleusercontent.com/caldav/v2/' || replace(username, '@', '%40') || '/' 
        WHERE auth_type = 'oauth2' AND url LIKE '%/user/'
      `);
    }
  },
  {
    version: 2,
    name: '002_sync_queue_retry_columns',
    up: async (db) => {
      await runSql(db, "ALTER TABLE sync_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      await runSql(db, "ALTER TABLE sync_queue ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3");
      await runSql(db, "ALTER TABLE sync_queue ADD COLUMN next_retry_at INTEGER");
      await runSql(db, "ALTER TABLE sync_queue ADD COLUMN retry_state TEXT NOT NULL DEFAULT 'IDLE'");
    }
  },
  {
    version: 3,
    name: '003_user_calendar_shares_role_permissions',
    up: async (db) => {
      await runSql(db, "ALTER TABLE user_calendar_shares ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'");
      await runSql(db, "ALTER TABLE user_calendar_shares ADD COLUMN role TEXT DEFAULT 'WRITE'");
      await runSql(db, "ALTER TABLE user_calendar_shares ADD COLUMN can_view_private INTEGER DEFAULT 0");
      await runSql(db, "ALTER TABLE user_calendar_shares ADD COLUMN can_manage_shares INTEGER DEFAULT 0");
    }
  }
];

async function runMigrations(db, migrationList = MIGRATIONS) {
  if (!db) {
    throw new Error('Database instance is required for running migrations');
  }

  const initialVersion = await getSchemaVersion(db);
  const pending = migrationList
    .slice()
    .filter((m) => m.version > initialVersion)
    .sort((a, b) => a.version - b.version);

  const appliedVersions = [];
  let currentVersion = initialVersion;

  for (const migration of pending) {
    if (typeof migration.up === 'function') {
      await migration.up(db);
    }
    await setSchemaVersion(db, migration.version);
    currentVersion = migration.version;
    appliedVersions.push(migration.version);
  }

  return {
    initialVersion,
    currentVersion,
    appliedCount: appliedVersions.length,
    appliedVersions
  };
}

module.exports = {
  getSchemaVersion,
  setSchemaVersion,
  runMigrations,
  migrations: MIGRATIONS,
  runSql
};
