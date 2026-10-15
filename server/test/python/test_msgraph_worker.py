import unittest
import os
import sqlite3
import tempfile
import shutil
import sys
from unittest.mock import MagicMock, patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import msgraph_worker

class TestMSGraphWorker(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE msgraph_accounts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                account_email TEXT,
                access_token TEXT,
                refresh_token TEXT,
                expires_at INTEGER,
                delta_link TEXT,
                target_calendar_id TEXT,
                reconnect_required INTEGER NOT NULL DEFAULT 0,
                sync_lock_until INTEGER,
                delta_started_at INTEGER,
                updated_at INTEGER
            )
        """)
        cursor.execute("""
            CREATE TABLE msgraph_event_mappings (
                local_uid TEXT PRIMARY KEY,
                graph_id TEXT UNIQUE NOT NULL,
                account_id TEXT NOT NULL,
                last_synced_at INTEGER,
                e_tag TEXT
            )
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)

    def test_get_db(self):
        conn = msgraph_worker.get_db(self.db_path)
        self.assertIsNotNone(conn)
        conn.close()

    def test_token_encryption_helpers(self):
        token = "msgraph-test-token"
        enc = msgraph_worker.encrypt_token(token)
        dec = msgraph_worker.decrypt_token(enc)
        self.assertEqual(dec, token)

    def test_sync_no_accounts(self):
        status, err = msgraph_worker.sync_msgraph_accounts("user-no-accs")
        self.assertTrue(status)
        self.assertEqual(err, "")

    def test_sync_with_account_no_events(self):
        conn = msgraph_worker.get_db(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at, target_calendar_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("acc-1", "user-1", "testuser@example.com", msgraph_worker.encrypt_token("testuser-access-token"),
              msgraph_worker.encrypt_token("testuser-refresh-token"), 9999999999999, "persoenlich"))
        conn.commit()

        # An empty delta page from Graph: the sync succeeds without touching the local calendar.
        graph_page = MagicMock()
        graph_page.__enter__.return_value.read.return_value = b'{"value": [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=x"}'
        with patch.object(msgraph_worker.urllib.request, "urlopen", return_value=graph_page):
            status, err = msgraph_worker.sync_msgraph_accounts("user-1", conn=conn)
        self.assertTrue(status, err)

        conn.close()

if __name__ == "__main__":
    unittest.main()
