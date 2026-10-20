"""Issue #614 — a disconnected mirror is neither synced nor mirrored a second time.

A mapping row whose collection is `detached:<collection>` stands for a calendar the user detached
from a still-linked account, or one a re-linked account may take back (server/db.js). The workers
skip its remote calendar: no new collection, no pair. Once re-attached, the row points at the old
collection again and the sync resumes in it.
"""
import os
import sqlite3
import sys
import unittest
from unittest.mock import patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker
import msgraph_worker

USER_ID = "testuser"


class TestIssue614DetachedMirrors(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE google_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
              google_calendar_id TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection));
            CREATE TABLE caldav_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
              remote_collection TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection));
            CREATE TABLE msgraph_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
              graph_calendar_id TEXT NOT NULL, local_collection TEXT NOT NULL, graph_name TEXT, graph_color TEXT,
              delta_link TEXT, delta_started_at INTEGER, created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, graph_calendar_id), UNIQUE (user_id, local_collection));
        """)
        self.created = []
        patcher = patch.object(sync_worker, "create_local_collection",
                               side_effect=lambda user, coll, *a, **k: self.created.append(coll))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.conn.close)

    def _map(self, table, remote_col, remote_id, local):
        self.conn.execute(
            f"INSERT INTO {table} (account_id, user_id, {remote_col}, local_collection, created_at) VALUES (?, ?, ?, ?, 0)",
            ("acc-new", USER_ID, remote_id, local))

    def test_detached_caldav_calendar_is_skipped_and_reattached_one_resumes(self):
        self._map("caldav_calendar_collections", "remote_collection", "work", "detached:caldav-old")
        self.assertIsNone(sync_worker.local_collection_for_caldav_calendar(
            self.conn, USER_ID, "acc-new", "work", "Work"))
        self.assertEqual(self.created, [])
        self.conn.execute("UPDATE caldav_calendar_collections SET local_collection = 'caldav-old'")
        self.assertEqual(sync_worker.local_collection_for_caldav_calendar(
            self.conn, USER_ID, "acc-new", "work", "Work"), "caldav-old")
        self.assertEqual(self.created, [])

    def test_detached_google_calendar_is_skipped(self):
        self._map("google_calendar_collections", "google_calendar_id", "testuser@example.com", "detached:google-old")
        self.assertIsNone(sync_worker.local_collection_for_google_calendar(
            self.conn, USER_ID, "acc-new", {"id": "testuser@example.com", "name": "Test User"}, "/nonexistent"))
        self.assertEqual(self.created, [])
        count = self.conn.execute("SELECT COUNT(*) FROM google_calendar_collections").fetchone()[0]
        self.assertEqual(count, 1)

    def test_detached_microsoft_calendar_is_skipped(self):
        self._map("msgraph_calendar_collections", "graph_calendar_id", "cal-1", "detached:msgraph-old")
        self.assertIsNone(msgraph_worker._mirror_for_graph_calendar(
            self.conn, USER_ID, "acc-new", {"id": "cal-1", "name": "Kalender"}))
        self.assertEqual(self.created, [])


if __name__ == "__main__":
    unittest.main()
