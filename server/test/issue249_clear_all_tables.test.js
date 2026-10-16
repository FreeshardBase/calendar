'use strict';

// Issue #249: Db.clearAll is how tests isolate themselves. Removing any one of its DELETEs left
// the suite green (e.g. calendar_shares rows survived), so this writes a row to every table it
// owns and asserts each one is empty afterwards. Runs against an isolated database.

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue249-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, '.encryption_key');

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

const USER = 'testuser';

function sql(method, statement, params = []) {
  return new Promise((resolve, reject) => {
    Db.db[method](statement, params, function (err, value) {
      if (err) return reject(err);
      resolve(method === 'run' ? this : value);
    });
  });
}

const count = async (table) => (await sql('get', `SELECT COUNT(*) AS n FROM ${table}`)).n;

const SEEDS = {
  linked_accounts: () => Db.addAccount(USER, {
    label: 'Test Account', url: 'https://caldav.example.com/', username: 'testuser', password: 'secret', authType: 'basic'
  }),
  app_passwords: () => sql('run',
    'INSERT INTO app_passwords (id, user_id, label, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ['asp-1', USER, 'Test', 'hash', Date.now()]),
  calendar_shares: () => Db.addCalendarShare(`internal-caldav::/${USER}/personal/`, 'Test Share'),
  availability_pages: () => sql('run',
    'INSERT INTO availability_pages (id, user_id, slug, title, calendar_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['page-1', USER, 'testuser-slots', 'Test Page', `internal-caldav::/${USER}/personal/`, Date.now()]),
  slot_bookings: () => sql('run',
    'INSERT INTO slot_bookings (id, page_id, guest_name, guest_email, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['booking-1', 'page-1', 'Test User', 'testuser@example.com', '2026-10-20T09:00:00Z', '2026-10-20T09:30:00Z', Date.now()]),
  event_history: () => sql('run',
    'INSERT INTO event_history (event_uid, calendar_id, user_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
    ['uid-1@example.com', `internal-caldav::/${USER}/personal/`, USER, 'create', Date.now()]),
  user_calendar_color_overrides: () => sql('run',
    'INSERT INTO user_calendar_color_overrides (user_id, calendar_id, color, updated_at) VALUES (?, ?, ?, ?)',
    [USER, `internal-caldav::/${USER}/personal/`, '#ff0000', Date.now()]),
  webcal_subscriptions: () => sql('run',
    'INSERT INTO webcal_subscriptions (id, user_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)',
    ['webcal-1', USER, 'Test Feed', 'https://feeds.example.com/test.ics', Date.now()]),
  sync_queue: () => sql('run',
    'INSERT INTO sync_queue (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['job-1', USER, 'PENDING', Date.now(), Date.now()])
};

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Db.clearAll empties every table it owns, not just some of them', async () => {
  await Db.ready;
  await Db.upsertUser(USER, USER, 'testuser@example.com');
  for (const seed of Object.values(SEEDS)) await seed();
  for (const table of Object.keys(SEEDS)) {
    assert.equal(await count(table), 1, `${table} was seeded`);
  }

  const usersBefore = await count('users');
  await Db.clearAll();

  for (const table of Object.keys(SEEDS)) {
    assert.equal(await count(table), 0, `${table} must be empty after clearAll`);
  }
  assert.ok(usersBefore >= 1);
  assert.equal(await count('users'), usersBefore, 'clearAll leaves users alone');
});
