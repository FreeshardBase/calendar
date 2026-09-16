const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

test('Issue #277 — Radicale Custom Rights Case-Insensitive Sharee & Owner Matching', async (t) => {
  await t.test('radicale_custom_rights.py matches sharee and owner usernames case-insensitively', () => {
    const pythonScript = `
import sys
import os
import sqlite3
import tempfile
import shutil
import types

m_radicale = types.ModuleType('radicale')
m_rights = types.ModuleType('radicale.rights')
m_pathutils = types.ModuleType('radicale.pathutils')

class BaseRights:
    def __init__(self, configuration):
        self.configuration = configuration

def strip_path(path):
    return path.strip("/")

m_rights.BaseRights = BaseRights
m_pathutils.strip_path = strip_path

sys.modules['radicale'] = m_radicale
sys.modules['radicale.rights'] = m_rights
sys.modules['radicale.pathutils'] = m_pathutils

radicale_dir = '${path.join(__dirname, '../../radicale').replace(/\\/g, '/')}'
if radicale_dir not in sys.path:
    sys.path.insert(0, radicale_dir)

import radicale_custom_rights

temp_dir = tempfile.mkdtemp()
try:
    db_path = os.path.join(temp_dir, "webcalendar.db")
    collections_dir = os.path.join(temp_dir, "collections")
    os.environ["DATABASE_PATH"] = db_path
    os.environ["RADICALE_COLLECTIONS_FOLDER"] = collections_dir

    os.makedirs(os.path.join(collections_dir, "user2", "shared-read"), exist_ok=True)
    os.makedirs(os.path.join(collections_dir, "user2", "shared-write"), exist_ok=True)

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE user_calendar_shares (
            id TEXT PRIMARY KEY,
            calendar_id TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            sharee_user_id TEXT NOT NULL,
            read_write INTEGER DEFAULT 0,
            role TEXT DEFAULT 'READ',
            status TEXT DEFAULT 'ACCEPTED'
        )
    """)

    cursor.execute("""
        INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
        VALUES ('s1', 'internal-caldav::/user2/shared-read/', 'user2', 'user1', 0, 'READ', 'ACCEPTED')
    """)

    cursor.execute("""
        INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
        VALUES ('s2', 'internal-caldav::/user2/shared-write/', 'user2', 'user1', 1, 'WRITE', 'ACCEPTED')
    """)

    conn.commit()
    conn.close()

    rights = radicale_custom_rights.Rights({})

    # 1. Sharee uppercase
    assert rights.authorization("USER1", "user2/shared-read") == "r", "USER1 should get read permission"

    # 2. Owner uppercase in path
    assert rights.authorization("user1", "USER2/shared-read") == "r", "user1 should get read permission on USER2 path"

    # 3. Mixed case both
    assert rights.authorization("User1", "User2/shared-write") == "rw", "User1 should get read-write permission on User2 path"

    print("OK")
finally:
    shutil.rmtree(temp_dir)
`;

    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `Python test exited with status ${res.status}. Output: ${res.stdout}\nError: ${res.stderr}`);
    assert.ok(res.stdout.includes('OK'), 'Python test output must contain OK');
  });
});
