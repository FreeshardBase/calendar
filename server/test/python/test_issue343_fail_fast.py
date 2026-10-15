"""Issue #343 — the workers and Radicale plugins must not swallow errors.

Each case drives a real failure (bad key, unreachable server, broken database) through the
production code path and checks that it surfaces instead of being turned into a plausible value.
"""
import os
import shutil
import sqlite3
import sys
import json
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

TEST_DIR = os.path.dirname(os.path.abspath(__file__))
SYNC_WORKER_DIR = os.path.abspath(os.path.join(TEST_DIR, "../../../sync-worker"))
RADICALE_DIR = os.path.abspath(os.path.join(TEST_DIR, "../../../radicale"))
for directory in (SYNC_WORKER_DIR, RADICALE_DIR):
    if directory not in sys.path:
        sys.path.insert(0, directory)



class _BasePlugin:
    def __init__(self, configuration):
        self.configuration = configuration


# The Radicale plugins import radicale.*; the other plugin tests install the same stand-ins.
if "radicale.rights" not in sys.modules:
    m_rights = types.ModuleType("radicale.rights")
    m_rights.BaseRights = _BasePlugin
    m_pathutils = types.ModuleType("radicale.pathutils")
    m_pathutils.strip_path = lambda path: path.strip("/")
    sys.modules.setdefault("radicale", types.ModuleType("radicale"))
    sys.modules.update({"radicale.rights": m_rights, "radicale.pathutils": m_pathutils})
if "radicale.auth" not in sys.modules:
    m_auth = types.ModuleType("radicale.auth")
    m_auth.BaseAuth = _BasePlugin
    sys.modules.setdefault("radicale", types.ModuleType("radicale"))
    sys.modules["radicale.auth"] = m_auth

import msgraph_worker  # noqa: E402
import sync_worker  # noqa: E402
import radicale_custom_auth  # noqa: E402
import radicale_custom_rights  # noqa: E402


class TokenCryptoTest(unittest.TestCase):
    def test_encrypt_token_failure_never_falls_back_to_plaintext(self):
        with patch.object(sync_worker, "encrypt", side_effect=ValueError("testuser encryption failure")):
            with self.assertRaises(ValueError):
                msgraph_worker.encrypt_token("testuser-graph-refresh-token")

    def test_undecryptable_token_is_an_error_not_a_bearer_token(self):
        iv = msgraph_worker.encrypt_token("testuser-graph-access-token").split(":", 1)[0]
        corrupted = f"{iv}:not-hex-ciphertext"
        with self.assertRaises(ValueError):
            msgraph_worker.decrypt_token(corrupted)


class GraphSyncTest(unittest.TestCase):
    ENDPOINT = "https://graph.example.com/v1.0/me/calendarView/delta?$deltatoken=previous"

    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("""CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT,
            account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER,
            delta_link TEXT, target_calendar_id TEXT, reconnect_required INTEGER NOT NULL DEFAULT 0,
            sync_lock_until INTEGER, updated_at INTEGER, delta_started_at INTEGER)""")
        self.conn.execute("""CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT UNIQUE NOT NULL,
            account_id TEXT NOT NULL, last_synced_at INTEGER, e_tag TEXT)""")
        self.conn.execute(
            "INSERT INTO msgraph_accounts VALUES ('acc1', 'testuser', 'testuser@example.com', "
            "?, NULL, 4102444800000, ?, 'persoenlich', 0, NULL, 0, NULL)",
            (msgraph_worker.encrypt_token("testuser-graph-token"), self.ENDPOINT),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_fetch_failure_fails_the_sync_and_keeps_the_delta_link(self):
        unreachable = urllib.error.URLError("connection refused")
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=unreachable):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok, "an unreachable Graph API must fail the sync job")
        self.assertIn("connection refused", error)
        row = self.conn.execute("SELECT delta_link FROM msgraph_accounts WHERE id = 'acc1'").fetchone()
        self.assertEqual(row["delta_link"], self.ENDPOINT, "the delta link must not advance past unfetched changes")

    def test_other_http_errors_keep_the_delta_link(self):
        unavailable = urllib.error.HTTPError(self.ENDPOINT, 503, "Service Unavailable", {}, None)
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=unavailable):
            ok, _ = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok)
        row = self.conn.execute("SELECT delta_link FROM msgraph_accounts WHERE id = 'acc1'").fetchone()
        self.assertEqual(row["delta_link"], self.ENDPOINT, "only an expired (410) delta link restarts the delta round")

    def test_token_refresh_failure_fails_the_sync(self):
        self.conn.execute("UPDATE msgraph_accounts SET refresh_token = ?, expires_at = 0",
                          (msgraph_worker.encrypt_token("testuser-refresh-token"),))
        refused = urllib.error.HTTPError("https://login.example.com/token", 400, "invalid_grant", {}, None)
        with patch.object(msgraph_worker, "refresh_msgraph_token", side_effect=refused), \
             patch.object(msgraph_worker.urllib.request, "urlopen") as urlopen:
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok)
        self.assertIn("token refresh failed", error)
        urlopen.assert_not_called()

    def _graph_page(self, items):
        page = MagicMock()
        page.__enter__.return_value.read.return_value = json.dumps({"value": items, "@odata.deltaLink": self.ENDPOINT}).encode("utf-8")
        return page

    def test_failed_local_write_fails_the_sync_and_records_no_mapping(self):
        event = {"id": "g1", "subject": "Test", "start": {"dateTime": "2026-01-01T09:00:00", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-01-01T10:00:00", "timeZone": "UTC"}}
        local_down = urllib.error.URLError("connection refused")
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=[self._graph_page([event]), local_down]):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok, "a failed local write fails the sync job")
        self.assertIn("connection refused", error)

        mapped = self.conn.execute("SELECT COUNT(*) FROM msgraph_event_mappings").fetchone()[0]
        self.assertEqual(mapped, 0, "an event that was never written locally must not be recorded as synced")

    def test_failed_local_delete_keeps_the_mapping(self):
        self.conn.execute("INSERT INTO msgraph_event_mappings VALUES ('msgraph-event-g1', 'g1', 'acc1', 0, '')")
        forbidden = urllib.error.HTTPError("https://caldav.example.com/", 403, "Forbidden", {}, None)
        with patch.object(msgraph_worker.urllib.request, "urlopen",
                          side_effect=[self._graph_page([{"id": "g1", "@removed": {"reason": "deleted"}}]), forbidden]):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok, "a failed local delete fails the sync job")
        self.assertIn("403", error)

        mapped = self.conn.execute("SELECT COUNT(*) FROM msgraph_event_mappings").fetchone()[0]
        self.assertEqual(mapped, 1)

    def test_local_delete_of_an_already_gone_event_succeeds(self):
        self.conn.execute("INSERT INTO msgraph_event_mappings VALUES ('msgraph-event-g1', 'g1', 'acc1', 0, '')")
        gone = urllib.error.HTTPError("https://caldav.example.com/", 404, "Not Found", {}, None)
        with patch.object(msgraph_worker.urllib.request, "urlopen",
                          side_effect=[self._graph_page([{"id": "g1", "@removed": {"reason": "deleted"}}]), gone]):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertTrue(ok, error)
        mapped = self.conn.execute("SELECT COUNT(*) FROM msgraph_event_mappings").fetchone()[0]
        self.assertEqual(mapped, 0)

    def test_expired_delta_link_fails_the_sync_and_restarts_the_delta_round(self):
        gone = urllib.error.HTTPError(self.ENDPOINT, 410, "Gone", {}, None)
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=gone):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok)
        self.assertIn("410", error)
        row = self.conn.execute("SELECT delta_link FROM msgraph_accounts WHERE id = 'acc1'").fetchone()
        self.assertIsNone(row["delta_link"], "an expired delta link must not block every later sync")


EVENT_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-1\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"


class CrossUserDeletionTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("CREATE TABLE cross_user_deletions (id INTEGER PRIMARY KEY, owner_user_id TEXT, uid TEXT, "
                          "href TEXT, ics TEXT)")
        self.conn.execute("INSERT INTO cross_user_deletions (owner_user_id, uid, href, ics) "
                          "VALUES ('testuser', 'evt-1', '/testuser/persoenlich/evt-1.ics', ?)", (EVENT_ICS,))

    def tearDown(self):
        self.conn.close()

    def test_failed_restore_keeps_the_record_for_the_next_sync(self):
        # Writing the event back to the local Radicale fails.
        with patch.object(sync_worker.urllib.request, "urlopen", side_effect=urllib.error.URLError("timed out")), \
             self.assertRaises(sync_worker.CrossUserRestoreError):
            sync_worker.protect_cross_user_deletions("testuser", self.conn)

        remaining = self.conn.execute("SELECT COUNT(*) FROM cross_user_deletions").fetchone()[0]
        self.assertEqual(remaining, 1, "a deletion whose event was not restored must not be forgotten")

    def test_restored_record_is_removed(self):
        with patch.object(sync_worker.urllib.request, "urlopen", MagicMock()):
            sync_worker.protect_cross_user_deletions("testuser", self.conn)

        remaining = self.conn.execute("SELECT COUNT(*) FROM cross_user_deletions").fetchone()[0]
        self.assertEqual(remaining, 0)


class RadicalePluginDatabaseErrorTest(unittest.TestCase):
    """A database the plugins cannot query is an error (Radicale answers 500), never a denial."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        # A database file without the webcalendar schema: every query fails.
        sqlite3.connect(self.db_path).close()
        collections = os.path.join(self.temp_dir, "collections")
        os.makedirs(os.path.join(collections, "owneruser", "shared"))
        self.env = patch.dict(os.environ, {
            "DATABASE_PATH": self.db_path,
            "RADICALE_COLLECTIONS_FOLDER": collections,
            "SYSTEM_SYNC_SECRET": "",
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.temp_dir)

    def test_rights_lookup_failure_propagates(self):
        rights = radicale_custom_rights.Rights(None)
        with self.assertRaises(sqlite3.OperationalError):
            rights.authorization("testuser", "/owneruser/shared/")

    def _create(self, sql):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(sql)

    def test_auth_user_lookup_failure_propagates(self):
        # app_passwords exists; only the username lookup fails.
        self._create("CREATE TABLE app_passwords (id TEXT, user_id TEXT, password_hash TEXT)")
        auth = radicale_custom_auth.Auth(None)
        with self.assertRaisesRegex(sqlite3.OperationalError, "users"):
            auth._login("testuser", "testuser-app-password")

    def test_auth_password_lookup_failure_is_not_a_wrong_password(self):
        # users exists; only the app-password lookup fails.
        self._create("CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT)")
        auth = radicale_custom_auth.Auth(None)
        with self.assertRaisesRegex(sqlite3.OperationalError, "app_passwords"):
            auth._login("testuser", "testuser-app-password")


if __name__ == "__main__":
    unittest.main()
