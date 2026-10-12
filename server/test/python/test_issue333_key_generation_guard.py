"""Issue #333: the sync worker must not mint a new encryption key next to existing ciphertexts."""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402

KEY_A = "issue333-original-install-key-0123456789abcdef"
KEY_B = "issue333-some-other-install-key-fedcba9876543210"


class TestIssue333KeyGenerationGuard(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        self.key_file = os.path.join(self.temp_dir, ".encryption_key")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _db_with_account(self, secret):
        enc, iv = sync_worker.encrypt("testuser-pass", sync_worker.derive_key(secret))
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT, url TEXT, username TEXT,"
            " password_encrypted TEXT, iv TEXT, display_name TEXT, auth_type TEXT)"
        )
        conn.execute(
            "INSERT INTO linked_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("acc-1", "testuser", "https://caldav.example.com/", "testuser", enc, iv, "Test User", "basic"),
        )
        conn.commit()
        conn.close()

    def _add_key_check(self, secret):
        enc, iv = sync_worker.encrypt(sync_worker.KEY_CHECK_PLAINTEXT, sync_worker.derive_key(secret))
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE encryption_key_check (id INTEGER PRIMARY KEY, ciphertext TEXT, iv TEXT, created_at INTEGER)")
        conn.execute("INSERT INTO encryption_key_check VALUES (1, ?, ?, 0)", (enc, iv))
        conn.commit()
        conn.close()

    def test_refuses_to_generate_key_when_encrypted_rows_exist(self):
        self._db_with_account(KEY_A)
        for node_env in ("production", "development"):
            with self.assertRaisesRegex(ValueError, "encrypted"):
                sync_worker.resolve_encryption_secret({"NODE_ENV": node_env}, self.db_path)
            self.assertFalse(os.path.exists(self.key_file))

    def test_generates_key_on_fresh_install(self):
        key = sync_worker.resolve_encryption_secret({"NODE_ENV": "production"}, self.db_path)
        self.assertEqual(len(key), 64)
        with open(self.key_file, encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), key)

    def test_verify_encryption_key_against_key_check_row(self):
        self._add_key_check(KEY_A)
        sync_worker.verify_encryption_key(self.db_path, sync_worker.derive_key(KEY_A))
        with self.assertRaisesRegex(ValueError, "cannot decrypt"):
            sync_worker.verify_encryption_key(self.db_path, sync_worker.derive_key(KEY_B))


if __name__ == "__main__":
    unittest.main()
