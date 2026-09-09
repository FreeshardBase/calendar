'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pyRightsPath = path.join(__dirname, '../../radicale/radicale_custom_rights.py');

test('Issue #192 — Read-Write Sharee Deny-Delete Permission Enforcement', async (t) => {
  await t.test('1. Static source analysis: radicale_custom_rights.py emits "rw" for collection and "rwd" for item sharee access', () => {
    const code = fs.readFileSync(pyRightsPath, 'utf8');
    assert.match(
      code,
      /return\s+["']rwd["']\s+if\s+has_write\s+else\s+["']rd["']/,
      'radicale_custom_rights.py must emit item level "rwd" for write sharees and "rd" for read sharees'
    );
  });

  await t.test('2. Python unit execution: Rights.authorization returns correct collection vs item permissions', () => {
    const pythonScript = `
import sys
import os
import sqlite3
import tempfile
import types

# Stub radicale modules if not present in environment
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
    # Insert a write share
    conn.execute(
        "INSERT INTO user_calendar_shares VALUES ('internal-caldav::/owner1/cal1/', 'sharee_write', 1, 'WRITE', 'ACCEPTED')"
    )
    # Insert a read share
    conn.execute(
        "INSERT INTO user_calendar_shares VALUES ('internal-caldav::/owner1/cal1/', 'sharee_read', 0, 'READ', 'ACCEPTED')"
    )
    conn.commit()
    conn.close()

    rights = radicale_custom_rights.Rights()

    # Owner access check (collection level)
    owner_perm = rights.authorization('owner1', 'owner1/cal1')
    assert owner_perm == 'RWDrwd', f"Owner expected 'RWDrwd', got {owner_perm!r}"

    # Read-write sharee access check (collection level must NOT include 'd' or 'D')
    rw_sharee_col_perm = rights.authorization('sharee_write', 'owner1/cal1')
    assert 'd' not in rw_sharee_col_perm and 'D' not in rw_sharee_col_perm, f"Read-write sharee collection expected 'rw', got {rw_sharee_col_perm!r}"
    assert rw_sharee_col_perm == 'rw', f"Read-write sharee collection expected 'rw', got {rw_sharee_col_perm!r}"

    # Read-write sharee access check (item level must include 'd')
    rw_sharee_item_perm = rights.authorization('sharee_write', 'owner1/cal1/item.ics')
    assert rw_sharee_item_perm == 'rwd', f"Read-write sharee item expected 'rwd', got {rw_sharee_item_perm!r}"

    # Read-only sharee access check
    ro_sharee_col_perm = rights.authorization('sharee_read', 'owner1/cal1')
    assert ro_sharee_col_perm == 'r', f"Read-only sharee collection expected 'r', got {ro_sharee_col_perm!r}"

    print("ALL_PYTHON_RIGHTS_TESTS_PASSED")
finally:
    if os.path.exists(db_path):
        os.remove(db_path)
`;

    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Python test execution failed:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`);
    assert.match(res.stdout, /ALL_PYTHON_RIGHTS_TESTS_PASSED/);
  });
});
