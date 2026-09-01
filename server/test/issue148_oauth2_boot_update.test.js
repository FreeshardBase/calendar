'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3').verbose();
const { migrations, runSql } = require('../utils/migrations');

test('Issue #148 — Boot-time migration 1 must not repoint non-Google OAuth2 CalDAV accounts to Google', async () => {
  const db = new sqlite3.Database(':memory:');

  await new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE linked_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT NOT NULL,
        password_encrypted TEXT NOT NULL,
        iv TEXT NOT NULL,
        display_name TEXT NOT NULL
      )`,
      (err) => (err ? reject(err) : resolve())
    );
  });

  const customOAuthUrl = 'https://caldav.custom-provider.org/remote.php/dav/user/';
  const customUsername = 'customuser@example.com';

  // Add columns that migration 1 adds
  await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN auth_type TEXT DEFAULT 'basic'");
  await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN access_token TEXT");
  await runSql(db, "ALTER TABLE linked_accounts ADD COLUMN expires_at INTEGER");

  // Insert account with auth_type = 'oauth2' and custom URL ending in /user/
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['acc-148', 'user-148', customOAuthUrl, customUsername, 'enc', 'iv', 'Custom OAuth Account', 'oauth2'],
      (err) => (err ? reject(err) : resolve())
    );
  });

  // Run migration 1's up function
  const migration1 = migrations.find((m) => m.version === 1);
  assert.ok(migration1, 'Migration 1 must exist');
  await migration1.up(db);

  const row = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM linked_accounts WHERE id = ?', ['acc-148'], (err, r) => (err ? reject(err) : resolve(r)));
  });

  assert.strictEqual(
    row.url,
    customOAuthUrl,
    'Migration 1 must preserve custom OAuth2 CalDAV account URL and not overwrite with Google CalDAV endpoint'
  );

  await new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
});
