'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const { checkCalendarAccess } = require('../utils/calendarAuth');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

const pyRightsPath = path.join(__dirname, '../../radicale/radicale_custom_rights.py');

test('Issue #201 — Prevent Unauthenticated & Sharee Permanent Calendar Deletion', async (t) => {
  let server;
  let baseUrl;

  t.before(async () => {
    await Db.upsertUser('owner_201', 'owner_201', 'owner_201@example.com');
    await Db.upsertUser('sharee_201', 'sharee_201', 'sharee_201@example.com');
    await Db.upsertUser('attacker_201', 'attacker_201', 'attacker_201@example.com');

    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret-201',
      resave: false,
      saveUninitialized: true
    }));

    app.use((req, res, next) => {
      const authUser = req.headers['x-test-user'];
      if (authUser) {
        req.session.userId = authUser;
        req.session.accounts = [{
          id: 'internal-caldav',
          url: 'http://localhost:5232/owner_201/',
          username: authUser,
          password: 'test-password'
        }];
      }
      next();
    });

    app.use('/api/calendars', calendarsRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('1. Python unit execution: Rights.authorization returns "RWDrwd" for owner and "rw"/"r" for sharees on collection level', () => {
    const pythonScript = `
import sys
import os
import sqlite3
import tempfile
import types

if 'radicale' not in sys.modules:
    radicale = types.ModuleType('radicale')
    rights_mod = types.ModuleType('radicale.rights')
    class BaseRights:
        def __init__(self, configuration=None):
            self.configuration = configuration
    rights_mod.BaseRights = BaseRights
    radicale.rights = rights_mod

    pathutils_mod = types.ModuleType('radicale.pathutils')
    def strip_path(path):
        return path.strip('/')
    pathutils_mod.strip_path = strip_path
    radicale.pathutils = pathutils_mod

    sys.modules['radicale'] = radicale
    sys.modules['radicale.rights'] = rights_mod
    sys.modules['radicale.pathutils'] = pathutils_mod

sys.path.insert(0, os.path.dirname(os.path.abspath('''${pyRightsPath}''')))
import radicale_custom_rights

with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
    db_path = tmp.name

try:
    os.environ['DATABASE_PATH'] = db_path
    conn = sqlite3.connect(db_path)
    conn.execute('''
        CREATE TABLE user_calendar_shares (
            calendar_id TEXT,
            sharee_user_id TEXT,
            read_write INTEGER,
            role TEXT,
            status TEXT
        )
    ''')
    conn.execute(
        "INSERT INTO user_calendar_shares VALUES ('internal-caldav::/owner1/cal1/', 'sharee_write', 1, 'WRITE', 'ACCEPTED')"
    )
    conn.execute(
        "INSERT INTO user_calendar_shares VALUES ('internal-caldav::/owner1/cal1/', 'sharee_read', 0, 'READ', 'ACCEPTED')"
    )
    conn.commit()
    conn.close()

    rights = radicale_custom_rights.Rights()

    # Owner access check at collection level (must have 'D' and 'd' to delete collection/items)
    owner_perm = rights.authorization('owner1', 'owner1/cal1')
    assert 'D' in owner_perm and 'd' in owner_perm, f"Owner expected collection delete permission 'D' and 'd', got {owner_perm!r}"
    assert owner_perm == 'RWDrwd', f"Owner expected 'RWDrwd', got {owner_perm!r}"

    # Write sharee access check at collection level (must NOT contain 'd' or 'D' at collection level)
    rw_sharee_col_perm = rights.authorization('sharee_write', 'owner1/cal1')
    assert 'd' not in rw_sharee_col_perm and 'D' not in rw_sharee_col_perm, f"Write sharee collection level must NOT contain 'd' or 'D', got {rw_sharee_col_perm!r}"
    assert rw_sharee_col_perm == 'rw', f"Write sharee collection level expected 'rw', got {rw_sharee_col_perm!r}"

    # Write sharee access check at item level (must contain 'd' to delete events inside collection)
    rw_sharee_item_perm = rights.authorization('sharee_write', 'owner1/cal1/event1.ics')
    assert 'd' in rw_sharee_item_perm, f"Write sharee item level expected 'd', got {rw_sharee_item_perm!r}"
    assert rw_sharee_item_perm == 'rwd', f"Write sharee item level expected 'rwd', got {rw_sharee_item_perm!r}"

    # Read sharee access check at collection level
    ro_sharee_col_perm = rights.authorization('sharee_read', 'owner1/cal1')
    assert ro_sharee_col_perm == 'r', f"Read sharee collection level expected 'r', got {ro_sharee_col_perm!r}"

    print("ALL_ISSUE201_PYTHON_RIGHTS_TESTS_PASSED")
finally:
    if os.path.exists(db_path):
        os.remove(db_path)
`;

    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Python test execution failed:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`);
    assert.match(res.stdout, /ALL_ISSUE201_PYTHON_RIGHTS_TESTS_PASSED/);
  });

  await t.test('2. checkCalendarAccess denies non-owners for requiredAccess="owner"', async () => {
    const reqNonOwner = { session: { userId: 'sharee_201' } };
    const calId = 'internal-caldav::/owner_201/personal/';

    const access = await checkCalendarAccess(reqNonOwner, calId, 'owner');
    assert.equal(access.allowed, false, 'Non-owner must not be allowed for requiredAccess="owner"');
    assert.equal(Boolean(access.isOwner), false, 'Non-owner must have isOwner falsy');
  });

  await t.test('3. DELETE /api/calendars/:id rejects non-owner calendar deletion with 403', async () => {
    const calId = encodeURIComponent('internal-caldav::/owner_201/personal/');
    const res = await fetch(`${baseUrl}/api/calendars/${calId}`, {
      method: 'DELETE',
      headers: {
        'x-test-user': 'attacker_201'
      }
    });

    assert.equal(res.status, 403, 'Non-owner calendar deletion must return 403 Forbidden');
    const data = await res.json();
    assert.ok(data.error, 'Error message must be present');
  });
});
