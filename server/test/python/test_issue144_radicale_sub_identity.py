"""Issue #144: in AUTH_METHOD=oidc the OIDC sub is the storage identity.

The web app logs in to Radicale with the sub. The auth plugin must resolve that
login to the same sub even when another member's display name (username) is
the identical string, otherwise the rights plugin compares the wrong identity
against the /<sub>/ collection path.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import types
import unittest

m_radicale = types.ModuleType('radicale')
m_auth = types.ModuleType('radicale.auth')
m_rights = types.ModuleType('radicale.rights')
m_pathutils = types.ModuleType('radicale.pathutils')


class BaseAuth:
    def __init__(self, configuration):
        self.configuration = configuration


class BaseRights:
    def __init__(self, configuration):
        self.configuration = configuration


m_auth.BaseAuth = BaseAuth
m_rights.BaseRights = BaseRights
m_pathutils.strip_path = lambda path: path.strip("/")
sys.modules['radicale'] = m_radicale
sys.modules['radicale.auth'] = m_auth
sys.modules['radicale.rights'] = m_rights
sys.modules['radicale.pathutils'] = m_pathutils

RADICALE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../radicale"))
if RADICALE_DIR not in sys.path:
    sys.path.insert(0, RADICALE_DIR)

import radicale_custom_auth  # noqa: E402
import radicale_custom_rights  # noqa: E402

SECRET = "issue144-system-sync-secret-0123456789abcdef"


class TestRadicaleSubIdentity(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        self.collections = os.path.join(self.temp_dir, "collections")
        os.makedirs(os.path.join(self.collections, "1", "personal"))
        os.makedirs(os.path.join(self.collections, "2", "personal"))
        self.saved_env = {k: os.environ.get(k) for k in
                          ("DATABASE_PATH", "RADICALE_COLLECTIONS_FOLDER", "SYSTEM_SYNC_SECRET")}
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["RADICALE_COLLECTIONS_FOLDER"] = self.collections
        os.environ["SYSTEM_SYNC_SECRET"] = SECRET

        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT)")
        conn.execute("CREATE TABLE app_passwords (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_hash TEXT NOT NULL)")
        conn.execute("""CREATE TABLE user_calendar_shares (
            id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, owner_user_id TEXT, sharee_user_id TEXT NOT NULL,
            read_write INTEGER DEFAULT 0, role TEXT DEFAULT 'READ', status TEXT DEFAULT 'ACCEPTED')""")
        # Member '2' was created first and carries the display name '1', which is member 1's sub.
        conn.execute("INSERT INTO users (user_id, username) VALUES ('2', '1')")
        conn.execute("INSERT INTO users (user_id, username) VALUES ('1', 'testuser')")
        conn.commit()
        conn.close()

        self.auth = radicale_custom_auth.Auth({})
        self.rights = radicale_custom_rights.Rights({})

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_login_with_a_sub_resolves_to_that_sub(self):
        self.assertEqual(self.auth._login("1", SECRET), "1")
        self.assertEqual(self.auth._login("2", SECRET), "2")

    def test_sub_owns_its_collection_root_and_not_another(self):
        user = self.auth._login("1", SECRET)
        self.assertEqual(self.rights.authorization(user, "/1/"), "RW")
        self.assertEqual(self.rights.authorization(user, "/1/personal/"), "rw")
        self.assertEqual(self.rights.authorization(user, "/2/personal/"), "")


if __name__ == "__main__":
    unittest.main()
