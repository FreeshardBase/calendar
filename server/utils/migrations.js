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
  },
  {
    version: 4,
    name: '004_hot_query_indexes',
    up: async (db) => {
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_app_passwords_user_id ON app_passwords(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_calendar_shares_calendar_id ON calendar_shares(calendar_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_sync_queue_user_id ON sync_queue(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_sync_queue_status_retry ON sync_queue(status, next_retry_at)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_user_calendar_shares_sharee ON user_calendar_shares(sharee_user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_msgraph_accounts_user_id ON msgraph_accounts(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_msgraph_event_mappings_graph_id ON msgraph_event_mappings(graph_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_msgraph_event_mappings_account_id ON msgraph_event_mappings(account_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user_id ON web_push_subscriptions(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_resource_bookings_resource_id ON resource_bookings(resource_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_resource_bookings_user_id ON resource_bookings(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_availability_pages_user_id ON availability_pages(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_availability_pages_calendar_id ON availability_pages(calendar_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_slot_bookings_page_id ON slot_bookings(page_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_id ON sync_conflicts(user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_delegate_permissions_delegate ON delegate_permissions(delegate_user_id)');
      await runSql(db, 'CREATE INDEX IF NOT EXISTS idx_cross_user_deletions_owner ON cross_user_deletions(owner_user_id)');
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
