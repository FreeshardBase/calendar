"""Issue #282 — the local Radicale storage must never get `verify = false`.

vdirsyncer >= 0.19 (0.19.3 is pinned in sync-worker/requirements.txt) rejects `verify = false`
at config parse ("Invalid value for verify (False), must be a path to a PEM-file"), so every pair
of the user fails. Without the internal certificate the key is left out (default verification;
for the plain-HTTP shard topology it does not apply), with it the key names the PEM file.

Drives the real sync_user() for a basic-auth and a Google account with subprocess.run replaced by
a recorder, and parses the generated config the way vdirsyncer does (INI keys, JSON values).
"""
import configparser
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "testuser"


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


class TestIssue282LocalCaldavVerify(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = os.path.join(self.temp_dir, "status")
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("""
            CREATE TABLE cross_user_deletions (
                id TEXT PRIMARY KEY, owner_user_id TEXT, uid TEXT, calendar_id TEXT, deleted_by TEXT,
                href TEXT, ics TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE google_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, google_calendar_id TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection)
            )
        """)
        conn.execute("""
            CREATE TABLE caldav_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, remote_collection TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection)
            )
        """)
        enc, iv = sync_worker.encrypt("pass123", sync_worker.KEY_BYTES)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
            " VALUES ('acc-basic', ?, 'https://caldav.example.com/testuser/', 'testuser', ?, ?, 'basic')",
            (USER_ID, enc, iv),
        )
        enc, iv = sync_worker.encrypt("refresh-token", sync_worker.KEY_BYTES)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type,"
            " access_token, expires_at) VALUES ('acc-google', ?, 'https://google.example.com/',"
            " 'testuser@example.com', ?, ?, 'oauth2', ?, ?)",
            (USER_ID, enc, iv, sync_worker.encrypt_token("tok", sync_worker.KEY_BYTES),
             int(time.time() * 1000) + 3600 * 1000),
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def generated_configs(self, cert_path):
        """{'basic': config, 'google': config} as written by sync_user() for the given cert path."""
        configs = {}

        def fake_run(cmd, *args, **kwargs):
            with open(cmd[2]) as f:
                text = f.read()
            configs["google" if "google_calendar" in text else "basic"] = parse_like_vdirsyncer(text)
            return MagicMock(returncode=0, stdout="", stderr="")

        def fake_urlopen(req, *args, **kwargs):
            res = MagicMock(status=201)
            res.__enter__ = lambda s: s
            res.__exit__ = lambda s, *a: False
            return res

        with patch.object(sync_worker, "LOCAL_CALDAV_CERT_PATH", cert_path, create=True), \
             patch.object(sync_worker, "discover_google_collections",
                          return_value=[{"id": "primary", "name": "Privat"}]), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker, "discover_caldav_collections", return_value={"work": "Arbeit"}), \
             patch.object(sync_worker.urllib.request, "urlopen", side_effect=fake_urlopen), \
             patch("subprocess.run", side_effect=fake_run):
            ok, err = sync_worker.sync_user(USER_ID)
        self.assertTrue(ok, err)
        self.assertEqual(set(configs), {"basic", "google"})
        return configs

    def test_without_certificate_the_local_storage_has_no_verify_key(self):
        missing = os.path.join(self.temp_dir, "ssl", "cert.pem")
        configs = self.generated_configs(missing)
        self.assertNotIn("verify", configs["basic"]["storage basic_local_0"])
        self.assertNotIn("verify", configs["google"]["storage local_0"])
        for config in configs.values():
            for section, values in config.items():
                self.assertNotEqual(values.get("verify", None), False, section)

    def test_with_certificate_the_local_storage_verifies_against_it(self):
        cert = os.path.join(self.temp_dir, "cert.pem")
        with open(cert, "w") as f:
            f.write("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")
        configs = self.generated_configs(cert)
        self.assertEqual(configs["basic"]["storage basic_local_0"]["verify"], cert)
        self.assertEqual(configs["google"]["storage local_0"]["verify"], cert)
        for config in configs.values():
            for values in config.values():
                self.assertNotIn("verify_fingerprint", values)
        # The external storages keep vdirsyncer's default (system CA) verification.
        self.assertNotIn("verify", configs["basic"]["storage basic_ext_0"])
        self.assertNotIn("verify", configs["google"]["storage google_0"])


if __name__ == "__main__":
    unittest.main()
