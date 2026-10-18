"""Issue #196 — Google token files and the vdirsyncer config must be private and never outlive sync_user.

Every test runs under umask 0, so a file created with the default open() mode would be 0666:
the 0600 / 0700 assertions only hold if the worker sets the mode itself.
"""
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "testuser-196"
REFRESH_TOKEN = "1//0testuser-refresh-token-196"
ACCESS_TOKEN = "ya29.testuser-access-token-196"
FAR_FUTURE_MS = 10000000000000


class TestIssue196GoogleTokenFiles(unittest.TestCase):
    def setUp(self):
        self.work_dir = tempfile.mkdtemp()
        # Private tempdir for the worker so leftovers can be listed exactly.
        self.worker_tmp = os.path.join(self.work_dir, "tmp")
        os.mkdir(self.worker_tmp)
        self.tempdir_patch = patch.object(tempfile, "tempdir", self.worker_tmp)
        self.tempdir_patch.start()
        self.old_umask = os.umask(0)

        self.db_path = os.path.join(self.work_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = os.path.join(self.work_dir, "status")
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT)")
        conn.commit()
        conn.close()
        self.seen = {}

    def tearDown(self):
        os.umask(self.old_umask)
        self.tempdir_patch.stop()
        shutil.rmtree(self.work_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def _add_account(self, acc_id, password_encrypted=None, iv=None, expires_at=FAR_FUTURE_MS):
        if password_encrypted is None:
            password_encrypted, iv = sync_worker.encrypt(REFRESH_TOKEN, sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type, access_token, expires_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 'oauth2', ?, ?)",
            (acc_id, USER_ID, "https://apidata.googleusercontent.com/caldav/v2/", "testuser@example.com",
             password_encrypted, iv, sync_worker.encrypt_token(ACCESS_TOKEN, sync_worker.KEY_BYTES), expires_at),
        )
        conn.commit()
        conn.close()

    def _record(self, path):
        with open(path) as f:
            content = f.read()
        self.seen[os.path.basename(path)] = (
            path,
            stat.S_IMODE(os.stat(path).st_mode),
            stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode),
            content,
        )

    def _record_token_files(self):
        for root, _dirs, files in os.walk(self.worker_tmp):
            for name in files:
                if name.startswith("google_token_"):
                    self._record(os.path.join(root, name))

    def _discovery(self, url, access_token):
        self._record_token_files()
        return [{"id": "testuser@example.com", "name": "Test User"}]

    def _sync_user(self):
        with patch.object(sync_worker, "discover_google_collections", side_effect=self._discovery), \
             patch.object(sync_worker, "local_collection_for_google_calendar", return_value="google-testcollection"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")):
            return sync_worker.sync_user(USER_ID)

    def assert_private_token_file_seen(self):
        token_files = [v for k, v in self.seen.items() if k.startswith("google_token_")]
        self.assertEqual(len(token_files), 1, self.seen)
        path, file_mode, dir_mode, content = token_files[0]
        self.assertIn(REFRESH_TOKEN, content)
        self.assertFalse(path.startswith("/tmp/google_token_"), path)
        self.assertEqual(file_mode, 0o600, oct(file_mode))
        self.assertEqual(dir_mode, 0o700, oct(dir_mode))

    def assert_nothing_left(self):
        self.assertEqual(os.listdir(self.worker_tmp), [])

    def test_undecryptable_second_account_leaves_no_token_file_of_the_first(self):
        # The report's scenario: account 0 writes its token file, account 1 returns early at decryption.
        self._add_account("acc-0")
        self._add_account("acc-1", password_encrypted="not-hex", iv="not-hex")

        ok, err = self._sync_user()

        self.assertFalse(ok)
        self.assertIn("Token decryption failed", err)
        self.assert_private_token_file_seen()
        self.assert_nothing_left()

    def test_failed_token_refresh_of_second_account_leaves_no_token_file_of_the_first(self):
        self._add_account("acc-0")
        self._add_account("acc-1", expires_at=1)

        with patch.object(sync_worker, "refresh_google_token", side_effect=RuntimeError("invalid_grant")):
            ok, err = self._sync_user()

        self.assertFalse(ok)
        self.assertIn("Google token refresh failed", err)
        self.assert_private_token_file_seen()
        self.assert_nothing_left()

    def test_config_and_token_file_are_private_during_vdirsyncer_and_removed_after(self):
        self._add_account("acc-0")
        commands = []

        def fake_vdirsyncer(config_path, command, policy, stdin=None):
            commands.append(command)
            self._record(config_path)
            self._record_token_files()
            return MagicMock(returncode=0, stdout="", stderr="")

        with patch.object(sync_worker, "run_vdirsyncer", side_effect=fake_vdirsyncer), \
             patch.object(sync_worker, "SYSTEM_SYNC_SECRET", "testuser-sync-secret-196"):
            ok, err = self._sync_user()

        self.assertTrue(ok, err)
        self.assertEqual(commands, ["discover", "sync", "metasync"])
        configs = [v for k, v in self.seen.items() if not k.startswith("google_token_")]
        self.assertEqual(len(configs), 1, self.seen)
        config_path, file_mode, dir_mode, content = configs[0]
        self.assertIn("testuser-sync-secret-196", content)
        self.assertNotEqual(config_path, f"/tmp/vdir_{USER_ID}.ini")
        self.assertEqual(file_mode, 0o600, oct(file_mode))
        self.assertEqual(dir_mode, 0o700, oct(dir_mode))
        self.assert_private_token_file_seen()
        self.assert_nothing_left()

    def test_failed_vdirsyncer_run_removes_config_and_token_file(self):
        self._add_account("acc-0")

        with patch.object(sync_worker, "run_vdirsyncer",
                          return_value=MagicMock(returncode=1, stdout="", stderr="discover failed")):
            ok, err = self._sync_user()

        self.assertFalse(ok)
        self.assertIn("vdirsyncer discover failed", err)
        self.assert_private_token_file_seen()
        self.assert_nothing_left()


if __name__ == "__main__":
    unittest.main()
