import unittest
from unittest.mock import patch, MagicMock
import os
import sqlite3
import tempfile
import shutil
import sys
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

class TestSyncWorker(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE sync_queue (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDING',
                error_message TEXT,
                attempts INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 5,
                next_retry_at INTEGER,
                retry_state TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )
        """)
        cursor.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                account_type TEXT NOT NULL,
                server_url TEXT,
                url TEXT,
                username TEXT,
                password TEXT,
                password_encrypted TEXT,
                iv TEXT,
                access_token TEXT,
                refresh_token TEXT,
                auth_type TEXT
            )
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)

    def test_encrypt_decrypt_roundtrip(self):
        key = sync_worker.KEY_BYTES
        plaintext = "my-secret-password-12345"
        enc_hex, iv_hex = sync_worker.encrypt(plaintext, key)
        decrypted = sync_worker.decrypt(enc_hex, iv_hex, key)
        self.assertEqual(decrypted, plaintext)

    def test_encrypt_decrypt_token_roundtrip(self):
        key = sync_worker.KEY_BYTES
        token = "secret-token-value"
        token_enc = sync_worker.encrypt_token(token, key)
        self.assertIn(":", token_enc)
        parts = token_enc.split(":", 1)
        decrypted = sync_worker.decrypt(parts[1], parts[0], key)
        self.assertEqual(decrypted, token)

    def test_decrypt_invalid_pkcs7_padding_bytes(self):
        key = sync_worker.KEY_BYTES
        iv = os.urandom(16)
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        encryptor = cipher.encryptor()
        # Invalid padding: len byte says 4, but bytes don't match
        payload = b"012345678912" + b"\x04\x04\x04\x00"
        encrypted = encryptor.update(payload) + encryptor.finalize()

        with self.assertRaises(ValueError) as ctx:
            sync_worker.decrypt(encrypted.hex(), iv.hex(), key)
        self.assertIn("Invalid PKCS#7 padding", str(ctx.exception))

    def test_decrypt_invalid_pkcs7_padding_length(self):
        key = sync_worker.KEY_BYTES
        iv = os.urandom(16)
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        encryptor = cipher.encryptor()
        # Invalid padding length > 16
        payload = b"0123456789123456" # zero length byte if evaluated as offset
        encrypted = encryptor.update(payload) + encryptor.finalize()

        with self.assertRaises(ValueError) as ctx:
            sync_worker.decrypt(encrypted.hex(), iv.hex(), key)
        self.assertIn("Invalid PKCS#7 padding", str(ctx.exception))

    def test_recover_stranded_jobs(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sync_queue (id, user_id, status) VALUES (?, ?, ?)",
            ("job-1", "user-stranded", "RUNNING")
        )
        conn.commit()
        conn.close()

        count = sync_worker.recover_stranded_jobs(self.db_path)
        self.assertEqual(count, 1)

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM sync_queue WHERE id = ?", ("job-1",))
        row = cursor.fetchone()
        conn.close()
        self.assertEqual(row[0], "PENDING")

    def test_purge_tmp_credential_files(self):
        f1 = "/tmp/vdir_test_py_user1.ini"
        f2 = "/tmp/vdir_basic_test_py_user1.ini"
        f3 = "/tmp/google_token_test_py_user1_0.json"
        for f in [f1, f2, f3]:
            with open(f, "w") as fp:
                fp.write("secret payload")
        self.assertTrue(os.path.exists(f1))
        self.assertTrue(os.path.exists(f2))
        self.assertTrue(os.path.exists(f3))

        sync_worker.purge_tmp_credential_files("test_py_user1")
        self.assertFalse(os.path.exists(f1))
        self.assertFalse(os.path.exists(f2))
        self.assertFalse(os.path.exists(f3))

    def test_resolve_encryption_secret_fallback(self):
        secret = sync_worker.resolve_encryption_secret(
            env={"NODE_ENV": "development", "ALLOW_INSECURE_ENCRYPTION_KEY": "true"},
            target_db_path=self.db_path
        )
        self.assertTrue(len(secret) > 0)

    def test_vdirsyncer_verify_config_compatibility(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        enc, iv = sync_worker.encrypt("pass123", sync_worker.KEY_BYTES)
        cursor.execute(
            "INSERT INTO linked_accounts (id, user_id, account_type, url, username, password_encrypted, iv, auth_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("acc-basic-1", "user-verify-test", "caldav", "http://example.com/caldav", "testuser", enc, iv, "basic")
        )
        conn.commit()
        conn.close()

        captured_content = []

        def mock_run(cmd, *args, **kwargs):
            config_file = cmd[2]
            with open(config_file, "r") as f:
                captured_content.append(f.read())
            mock_res = MagicMock()
            mock_res.returncode = 0
            return mock_res

        os.environ["STATUS_ROOT"] = self.temp_dir
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        with patch("subprocess.run", side_effect=mock_run):
            sync_worker.sync_basic_caldav_accounts("user-verify-test", conn)

        conn.close()

        self.assertEqual(len(captured_content), 2)
        content = captured_content[0]

        self.assertNotIn("verify_fingerprint", content)
        if os.path.exists("/etc/ssl/certs/local/cert.pem"):
            self.assertIn('verify = "/etc/ssl/certs/local/cert.pem"', content)
        else:
            self.assertIn('verify = false', content)

        sync_worker.purge_tmp_credential_files("user-verify-test")

    def test_issue82_resolve_encryption_secret_rendered_portal_id(self):
        rendered_portal_id = "8271dd" + "a" * 97
        self.assertEqual(len(rendered_portal_id), 103)
        with self.assertRaises(ValueError):
            sync_worker.resolve_encryption_secret(
                env={"NODE_ENV": "production", "ENCRYPTION_KEY": rendered_portal_id},
                target_db_path=self.db_path
            )

    def test_issue82_resolve_encryption_secret_weak_file_in_production(self):
        key_file = os.path.join(self.temp_dir, ".encryption_key")
        with open(key_file, "w") as f:
            f.write("freeshard-default-encryption-key-do-not-use-in-prod")
        with self.assertRaises(ValueError):
            sync_worker.resolve_encryption_secret(
                env={"NODE_ENV": "production"},
                target_db_path=self.db_path
            )

        rendered_portal_id = "8271dd" + "a" * 97
        with open(key_file, "w") as f:
            f.write(rendered_portal_id)
        with self.assertRaises(ValueError):
            sync_worker.resolve_encryption_secret(
                env={"NODE_ENV": "production"},
                target_db_path=self.db_path
            )

    def test_issue82_resolve_encryption_secret_generates_key_per_install(self):
        key_file = os.path.join(self.temp_dir, ".encryption_key")
        if os.path.exists(key_file):
            os.remove(key_file)
        key = sync_worker.resolve_encryption_secret(
            env={"NODE_ENV": "development"},
            target_db_path=self.db_path
        )
        self.assertNotEqual(key, "freeshard-default-encryption-key-do-not-use-in-prod")
        self.assertEqual(len(key), 64)
        self.assertTrue(os.path.exists(key_file))
        with open(key_file, "r") as f:
            self.assertEqual(f.read().strip(), key)

if __name__ == "__main__":
    unittest.main()

