'use strict';

/**
 * Issue #250 — MEDIUM: npm test in a checkout deletes the developer's linked accounts, app passwords, share links and sync queue
 *
 * Verifies that running tests under NODE_ENV=test (when DATABASE_PATH is not explicitly set)
 * uses an isolated test database (webcalendar.test.db) rather than overwriting or deleting
 * data from the developer's main database (webcalendar.db).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Db = require('../db');

test('Issue #250 — npm test uses isolated test database when DATABASE_PATH is unset', () => {
  assert.ok(typeof Db.getDbPath === 'function', 'Db.getDbPath must be exported as a function');
  const activeDbPath = Db.getDbPath();

  assert.ok(activeDbPath, 'Active database path must be non-empty');
  assert.strictEqual(
    path.basename(activeDbPath),
    'webcalendar.test.db',
    'Under NODE_ENV=test without DATABASE_PATH override, Db must connect to webcalendar.test.db instead of developer webcalendar.db'
  );
  assert.notStrictEqual(
    activeDbPath,
    path.join(__dirname, '../webcalendar.db'),
    'Active database path must NOT be the developer production webcalendar.db file'
  );
});
