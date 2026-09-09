import unittest
import os
import sqlite3
import tempfile
import shutil
import sys
import types

# Mock radicale module before importing radicale_custom_rights
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

RADICALE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../radicale"))
if RADICALE_DIR not in sys.path:
    sys.path.insert(0, RADICALE_DIR)

import radicale_custom_rights

class TestRadicaleCustomRights(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path

        conn = sqlite3.connect(self.db_path)
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

        # Insert test shares
        cursor.execute("""
            INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("s1", "internal-caldav::/user2/shared-read/", "user2", "user1", 0, "READ", "ACCEPTED"))

        cursor.execute("""
            INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("s2", "internal-caldav::/user2/shared-write/", "user2", "user1", 1, "WRITE", "ACCEPTED"))

        cursor.execute("""
            INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("s3", "internal-caldav::/user2/shared-pending/", "user2", "user1", 1, "WRITE", "PENDING"))

        cursor.execute("""
            INSERT INTO user_calendar_shares (id, calendar_id, owner_user_id, sharee_user_id, read_write, role, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("s4", "internal-caldav::/user2/shared-admin/", "user2", "user1", 0, "ADMIN", "ACCEPTED"))

        conn.commit()
        conn.close()

        self.rights = radicale_custom_rights.Rights({})

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)

    def test_unauthenticated_user(self):
        perm = self.rights.authorization(None, "user1/cal1")
        self.assertEqual(perm, "")

    def test_root_path_discovery(self):
        perm = self.rights.authorization("user1", "")
        self.assertEqual(perm, "R")
        perm_slash = self.rights.authorization("user1", "/")
        self.assertEqual(perm_slash, "R")

    def test_owner_principal_root(self):
        perm = self.rights.authorization("user1", "user1")
        self.assertEqual(perm, "RW")
        perm_case = self.rights.authorization("USER1", "user1")
        self.assertEqual(perm_case, "RW")

    def test_owner_calendar_subpath(self):
        perm = self.rights.authorization("user1", "user1/my-cal")
        self.assertEqual(perm, "RWDrwd")

    def test_other_user_principal_root_access_denied(self):
        perm = self.rights.authorization("user1", "user2")
        self.assertEqual(perm, "")

    def test_sharee_read_only_access(self):
        perm = self.rights.authorization("user1", "user2/shared-read")
        self.assertEqual(perm, "r")
        perm_item = self.rights.authorization("user1", "user2/shared-read/item.ics")
        self.assertEqual(perm_item, "rd")

    def test_sharee_write_access(self):
        perm = self.rights.authorization("user1", "user2/shared-write")
        self.assertEqual(perm, "rw")
        perm_item = self.rights.authorization("user1", "user2/shared-write/item.ics")
        self.assertEqual(perm_item, "rwd")

    def test_sharee_admin_access(self):
        perm = self.rights.authorization("user1", "user2/shared-admin")
        self.assertEqual(perm, "rw")
        perm_item = self.rights.authorization("user1", "user2/shared-admin/item.ics")
        self.assertEqual(perm_item, "rwd")

    def test_sharee_pending_access_denied(self):
        perm = self.rights.authorization("user1", "user2/shared-pending")
        self.assertEqual(perm, "")

    def test_unshared_calendar_access_denied(self):
        perm = self.rights.authorization("user1", "user2/unshared-cal")
        self.assertEqual(perm, "")

    def test_missing_db_returns_empty(self):
        os.environ["DATABASE_PATH"] = "/nonexistent/db.sqlite"
        perm = self.rights.authorization("user1", "user2/shared-read")
        self.assertEqual(perm, "")

if __name__ == "__main__":
    unittest.main()
