'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const Db = require('../db');

test('Issue #134 — Comprehensive User Deletion Cleanup & Radicale ASP Revocation', async (t) => {
  const userId = 'test-delete-user-134';
  const username = 'testuser134@example.com';

  t.after(async () => {
    await Db.deleteUser(userId);
  });

  // Helper to run query as promise
  const runQuery = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, (err) => err ? rej(err) : res()));
  const getCount = (sql, params = []) => new Promise((res, rej) => Db.db.get(sql, params, (err, row) => err ? rej(err) : res(Object.values(row)[0])));

  // 1. Seed data across all tables storing user data
  await Db.upsertUser(userId, username);

  // App password creation
  const aspResult = await Db.addAppPassword(userId, 'Test ASP');
  assert.ok(aspResult.id);
  assert.ok(aspResult.rawPassword);
  const rawPassword = aspResult.rawPassword;

  // Linked account
  await runQuery(
    `INSERT OR REPLACE INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['acc-134', userId, 'http://localhost/dav', username, 'enc', 'iv', 'Disp']
  );

  // Sync queue
  await runQuery(
    `INSERT OR REPLACE INTO sync_queue (id, user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['sync-134', userId, 'PENDING', Date.now(), Date.now()]
  );

  // User calendar shares
  await runQuery(
    `INSERT OR REPLACE INTO user_calendar_shares (id, calendar_id, sharee_user_id, read_write, status, created_at)
     VALUES (?, ?, ?, 1, 'ACCEPTED', ?)`,
    ['share-134', `/internal-caldav/${userId}/personal/`, userId, Date.now()]
  );

  // MS Graph account & event mappings
  await runQuery(
    `INSERT OR REPLACE INTO msgraph_accounts (id, user_id, account_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['msgraph-134', userId, username, Date.now(), Date.now()]
  );
  await runQuery(
    `INSERT OR REPLACE INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at)
     VALUES (?, ?, ?, ?)`,
    ['event-134', 'graph-134', 'msgraph-134', Date.now()]
  );

  // Push subscriptions
  await runQuery(
    `INSERT OR REPLACE INTO web_push_subscriptions (id, user_id, endpoint, created_at)
     VALUES (?, ?, ?, ?)`,
    ['push-134', userId, 'https://push.example.com/134', Date.now()]
  );

  // Resource bookings
  await runQuery(
    `INSERT OR REPLACE INTO resource_bookings (id, resource_id, user_id, start_time, end_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['booking-134', 'res-1', userId, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', Date.now()]
  );

  // Availability pages & slot bookings
  await runQuery(
    `INSERT OR REPLACE INTO availability_pages (id, user_id, slug, title, calendar_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['avail-134', userId, 'slug-134', 'Title', 'cal-134', Date.now()]
  );
  await runQuery(
    `INSERT OR REPLACE INTO slot_bookings (id, page_id, guest_name, guest_email, start_time, end_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['slot-134', 'avail-134', 'Guest', 'guest@example.com', '2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z', Date.now()]
  );

  // Sync conflicts
  await runQuery(
    `INSERT OR REPLACE INTO sync_conflicts (id, user_id, calendar_id, uid, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['conflict-134', userId, 'cal-134', 'uid-134', Date.now()]
  );

  // Delegate permissions
  await runQuery(
    `INSERT OR REPLACE INTO delegate_permissions (id, principal_user_id, delegate_user_id, created_at)
     VALUES (?, ?, ?, ?)`,
    ['del-134', userId, 'other-user', Date.now()]
  );

  // Working hours policy
  await runQuery(
    `INSERT OR REPLACE INTO working_hours_policy (user_id, created_at, updated_at)
     VALUES (?, ?, ?)`,
    [userId, Date.now(), Date.now()]
  );

  // Cross user deletions
  await runQuery(
    `INSERT OR REPLACE INTO cross_user_deletions (id, uid, calendar_id, owner_user_id, deleted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['cross-134', 'uid-134', 'cal-134', userId, 'other-user', Date.now()]
  );

  // Color overrides
  await runQuery(
    `INSERT OR REPLACE INTO user_calendar_color_overrides (user_id, calendar_id, color, updated_at)
     VALUES (?, ?, ?, ?)`,
    [userId, 'cal-134', '#ff0000', Date.now()]
  );

  // Webcal subscriptions
  await runQuery(
    `INSERT OR REPLACE INTO webcal_subscriptions (id, user_id, name, url, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['webcal-134', userId, 'Feed', 'http://example.com/ics', Date.now()]
  );

  // Event history
  await runQuery(
    `INSERT OR REPLACE INTO event_history (event_uid, calendar_id, user_id, action, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['uid-134', 'cal-134', userId, 'CREATE', Date.now()]
  );

  // Sessions
  await runQuery(
    `INSERT OR REPLACE INTO sessions (sid, user_id, sess, expired)
     VALUES (?, ?, ?, ?)`,
    ['sess-134', userId, '{}', Date.now() + 100000]
  );

  // Calendar shares
  await runQuery(
    `INSERT OR REPLACE INTO calendar_shares (token, calendar_id, label, created_at)
     VALUES (?, ?, ?, ?)`,
    ['token-134', `/internal-caldav/${userId}/personal/`, 'Share', Date.now()]
  );

  const dbPath = Db.dbPath || (Db.getDbPath && Db.getDbPath()) || process.env.DATABASE_PATH || path.join(__dirname, '../../webcalendar.db');

  // Helper to run Radicale auth logic via Python
  const checkRadicaleAuth = (login, pw) => {
    const pyScript = `
import sys, types
m_radicale = types.ModuleType('radicale')
m_auth = types.ModuleType('radicale.auth')
class BaseAuth:
    def __init__(self, configuration): pass
m_auth.BaseAuth = BaseAuth
m_radicale.auth = m_auth
sys.modules['radicale'] = m_radicale
sys.modules['radicale.auth'] = m_auth

sys.path.insert(0, '${path.join(__dirname, '../../radicale')}')
from radicale_custom_auth import Auth
auth = Auth({})
print(auth._login('${login}', '${pw}'))
`;
    return execFileSync('python3', ['-c', pyScript], {
      env: { ...process.env, DATABASE_PATH: dbPath },
      encoding: 'utf8'
    }).trim();
  };

  // 2. Verify Radicale authentication succeeds before user deletion (both via username and userId)
  const authBeforeUsername = checkRadicaleAuth(username, rawPassword);
  assert.strictEqual(authBeforeUsername, userId, 'App password should authenticate by username against Radicale before deletion');

  const authBeforeUserId = checkRadicaleAuth(userId, rawPassword);
  assert.strictEqual(authBeforeUserId, userId, 'App password should authenticate by userId against Radicale before deletion');

  // Also verify Db.verifyAppPassword before deletion
  assert.strictEqual(await Db.verifyAppPassword(userId, rawPassword), true);

  // 3. Execute User Deletion
  await Db.deleteUser(userId);

  // 4. Verify Radicale authentication fails after user deletion
  const authAfterUsername = checkRadicaleAuth(username, rawPassword);
  assert.strictEqual(authAfterUsername, '', 'App password MUST NOT authenticate by username after user deletion');

  const authAfterUserId = checkRadicaleAuth(userId, rawPassword);
  assert.strictEqual(authAfterUserId, '', 'App password MUST NOT authenticate by userId after user deletion');

  // Also verify Db.verifyAppPassword fails after deletion
  assert.strictEqual(await Db.verifyAppPassword(userId, rawPassword), false);

  // 5. Verify all tables cleared for userId
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM users WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM linked_accounts WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM app_passwords WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM sync_queue WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM user_calendar_shares WHERE sharee_user_id = ? OR calendar_id LIKE ?', [userId, `%${userId}%`]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM msgraph_accounts WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM msgraph_event_mappings WHERE account_id = ?', ['msgraph-134']), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM web_push_subscriptions WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM resource_bookings WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM availability_pages WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM slot_bookings WHERE page_id = ?', ['avail-134']), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM sync_conflicts WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM delegate_permissions WHERE principal_user_id = ? OR delegate_user_id = ?', [userId, userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM working_hours_policy WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM cross_user_deletions WHERE owner_user_id = ? OR deleted_by = ?', [userId, userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM user_calendar_color_overrides WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM webcal_subscriptions WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM event_history WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [userId]), 0);
  assert.strictEqual(await getCount('SELECT COUNT(*) FROM calendar_shares WHERE calendar_id LIKE ?', [`%${userId}%`]), 0);
});
