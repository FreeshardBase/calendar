import unittest
import os
import sqlite3
import tempfile
import shutil
import sys
import types
import hashlib

# Mock radicale module before importing radicale_custom_auth
m_radicale = types.ModuleType('radicale')
m_auth = types.ModuleType('radicale.auth')

class BaseAuth:
    def __init__(self, configuration):
        self.configuration = configuration

m_auth.BaseAuth = BaseAuth
sys.modules['radicale'] = m_radicale
sys.modules['radicale.auth'] = m_auth

# Add radicale folder to sys.path
RADICALE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../radicale"))
if RADICALE_DIR not in sys.path:
    sys.path.insert(0, RADICALE_DIR)

import radicale_custom_auth

class TestRadicaleCustomAuth(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE users (
                user_id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL
            )
        """)
        cursor.execute("""
            CREATE TABLE app_passwords (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                password_hash TEXT NOT NULL
            )
        """)
        
        # Insert test user
        cursor.execute("INSERT INTO users (user_id, username) VALUES (?, ?)", ("uuid-user-1", "testuser"))
        
        # Insert legacy SHA256 app password ('legacypass')
        legacy_hash = hashlib.sha256("legacypass".encode("utf-8")).hexdigest()
        cursor.execute("INSERT INTO app_passwords (id, user_id, password_hash) VALUES (?, ?, ?)", ("ap-1", "uuid-user-1", legacy_hash))
        
        # Insert PBKDF2 app password ('pbkdf2pass')
        salt = "testsalt"
        pbkdf2_hash = hashlib.pbkdf2_hmac('sha256', "pbkdf2pass".encode("utf-8"), salt.encode("utf-8"), 100000).hex()
        stored_pbkdf2 = f"{salt}:{pbkdf2_hash}"
        cursor.execute("INSERT INTO app_passwords (id, user_id, password_hash) VALUES (?, ?, ?)", ("ap-2", "uuid-user-1", stored_pbkdf2))

        conn.commit()
        conn.close()

        self.auth = radicale_custom_auth.Auth({})

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)

    def test_login_username_resolution(self):
        # Login with username 'testuser' and system sync secret
        os.environ["SYSTEM_SYNC_SECRET"] = "sync-secret-123"
        user_id = self.auth._login("testuser", "sync-secret-123")
        self.assertEqual(user_id, "uuid-user-1")

    def test_login_user_id_direct(self):
        # Login with user_id 'uuid-user-1' and system sync secret
        os.environ["SYSTEM_SYNC_SECRET"] = "sync-secret-123"
        user_id = self.auth._login("uuid-user-1", "sync-secret-123")
        self.assertEqual(user_id, "uuid-user-1")

    def test_login_legacy_sha256_pass(self):
        user_id = self.auth._login("testuser", "legacypass")
        self.assertEqual(user_id, "uuid-user-1")

    def test_login_pbkdf2_pass(self):
        user_id = self.auth._login("testuser", "pbkdf2pass")
        self.assertEqual(user_id, "uuid-user-1")

    def test_login_invalid_password(self):
        user_id = self.auth._login("testuser", "wrongpass")
        self.assertEqual(user_id, "")

    def test_login_nonexistent_user(self):
        user_id = self.auth._login("nonexistent", "pbkdf2pass")
        self.assertEqual(user_id, "")

    def test_login_missing_db(self):
        os.environ["DATABASE_PATH"] = "/nonexistent/path/db.sqlite"
        user_id = self.auth._login("testuser", "pbkdf2pass")
        self.assertEqual(user_id, "")

if __name__ == "__main__":
    unittest.main()
