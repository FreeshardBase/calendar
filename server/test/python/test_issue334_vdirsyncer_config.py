"""Issue #334 — vdirsyncer config injection, predictable /tmp config files, no subprocess timeouts.

vdirsyncer reads its config with configparser.RawConfigParser and decodes every value with
json.loads; parse_like_vdirsyncer() applies exactly those semantics to the generated file.
"""
import configparser
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "testuser-334"
EVIL_USERNAME = 'testuser"\n[storage evil]\ntype = "caldav"\nurl = "https://evil.example.com/"\nverify = false\nusername = "x'
EVIL_PASSWORD = 'pa"ss\\word\nverify = false'


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


class TestIssue334VdirsyncerConfig(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = os.path.join(self.temp_dir, "status")
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE sync_queue (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
                error_message TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5,
                next_retry_at INTEGER, retry_state TEXT, created_at INTEGER, updated_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE sync_job_progress (job_id TEXT PRIMARY KEY, items_done INTEGER NOT NULL DEFAULT 0)")
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_type TEXT, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT)")
        enc, iv = sync_worker.encrypt(EVIL_PASSWORD, sync_worker.KEY_BYTES)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, account_type, url, username, password_encrypted, iv, auth_type)"
            " VALUES (?, ?, 'caldav', ?, ?, ?, ?, 'basic')",
            ("acc-334", USER_ID, "https://caldav.example.com/dav", EVIL_USERNAME, enc, iv),
        )
        conn.commit()
        conn.close()
        # The account's calendars and their local collections (#531) are not under test here.
        for name, value in (("discover_caldav_collections", {"work": "Arbeit"}),
                            ("local_collection_for_caldav_calendar", "caldav-" + "0" * 32)):
            patcher = patch.object(sync_worker, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def _run_basic_sync(self, side_effect):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            with patch("subprocess.run", side_effect=side_effect) as run_mock:
                result = sync_worker.sync_basic_caldav_accounts(USER_ID, conn)
        finally:
            conn.close()
        return result, run_mock

    def test_injected_username_and_password_cannot_add_sections_or_keys(self):
        captured = []

        def fake_run(cmd, *args, **kwargs):
            with open(cmd[2]) as f:
                captured.append(f.read())
            return MagicMock(returncode=0, stdout="", stderr="")

        (ok, err), _ = self._run_basic_sync(fake_run)
        self.assertTrue(ok, err)
        config = parse_like_vdirsyncer(captured[0])

        self.assertEqual(
            set(config),
            {"general", "pair basic_0", "storage basic_ext_0", "storage basic_local_0"},
        )
        ext = config["storage basic_ext_0"]
        self.assertEqual(set(ext), {"type", "url", "username", "password"})
        self.assertEqual(ext["username"], EVIL_USERNAME)
        self.assertEqual(ext["password"], EVIL_PASSWORD)
        self.assertEqual(ext["url"], "https://caldav.example.com/dav/")
        self.assertEqual(config["storage basic_local_0"]["username"], USER_ID)
        self.assertEqual(config["storage basic_local_0"]["password"], sync_worker.SYSTEM_SYNC_SECRET)

    def test_config_is_private_unpredictable_and_deleted(self):
        seen = []

        def fake_run(cmd, *args, **kwargs):
            path = cmd[2]
            seen.append((path, stat.S_IMODE(os.stat(path).st_mode),
                         stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode)))
            return MagicMock(returncode=0, stdout="", stderr="")

        (ok, err), _ = self._run_basic_sync(fake_run)
        self.assertTrue(ok, err)
        self.assertEqual(len(seen), 2)
        path, file_mode, dir_mode = seen[0]
        self.assertNotEqual(path, f"/tmp/vdir_basic_{USER_ID}.ini")
        self.assertNotEqual(os.path.dirname(path), tempfile.gettempdir())
        self.assertEqual(file_mode, 0o600)
        self.assertEqual(dir_mode, 0o700)
        self.assertFalse(os.path.exists(path))
        self.assertFalse(os.path.exists(os.path.dirname(path)))

    def test_every_vdirsyncer_call_has_a_timeout(self):
        (ok, err), run_mock = self._run_basic_sync(
            lambda *a, **k: MagicMock(returncode=0, stdout="", stderr=""))
        self.assertTrue(ok, err)
        self.assertEqual(run_mock.call_count, 2)
        for call in run_mock.call_args_list:
            self.assertIsInstance(call.kwargs.get("timeout"), (int, float))
            self.assertGreater(call.kwargs["timeout"], 0)

    def test_timed_out_sync_marks_job_error_and_cleans_up(self):
        paths = []

        def hanging_run(cmd, *args, **kwargs):
            paths.append(cmd[2])
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO sync_queue (id, user_id, status, attempts, max_attempts, created_at, updated_at)"
            " VALUES ('job-334', ?, 'PENDING', 0, 5, 1, 1)",
            (USER_ID,),
        )
        conn.commit()
        conn.close()

        with patch("subprocess.run", side_effect=hanging_run):
            self.assertTrue(sync_worker.process_next_job(self.db_path))

        conn = sqlite3.connect(self.db_path)
        status, error_message = conn.execute(
            "SELECT status, error_message FROM sync_queue WHERE id = 'job-334'").fetchone()
        conn.close()
        self.assertEqual(status, "ERROR")
        self.assertIn("timed out", error_message)
        self.assertEqual(len(paths), 1)
        self.assertFalse(os.path.exists(os.path.dirname(paths[0])))


if __name__ == "__main__":
    unittest.main()
