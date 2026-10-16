"""Issue #60 — a Microsoft 365 sync job reports success only when the event data reached Radicale.

Drives the sync worker's job loop (process_next_job -> sync_user -> msgraph_worker) against a fake
Microsoft Graph and a fake local Radicale (urlopen is routed to them; no request leaves the process):
  - a Graph event is PUT as a VEVENT into the account's target calendar before the job is SUCCESS;
  - a Radicale PUT that fails makes the job ERROR, records no mapping and does not advance the delta link;
  - a Graph deletion DELETEs the local event; a failed DELETE makes the job ERROR and keeps the mapping.
"""
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402

GRAPH = "https://graph.microsoft.com/v1.0"
DELTA = f"{GRAPH}/me/calendarView/delta"
NEXT_DELTA = f"{DELTA}?$deltatoken=round2"
USER_ID = "testuser"


class _Response:
    def __init__(self, body=""):
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class FakeGraphAndRadicale:
    def __init__(self, page, put_status=201, delete_status=204):
        self.page = page
        self.put_status = put_status
        self.delete_status = delete_status
        self.requests = []

    def __call__(self, req, context=None, timeout=None):
        url = req.full_url
        method = req.get_method()
        self.requests.append({"method": method, "url": url,
                              "body": req.data.decode("utf-8") if req.data else ""})
        if url.startswith(DELTA):
            return _Response(json.dumps(self.page))
        if url.startswith(sync_worker.LOCAL_CALDAV_URL.rstrip("/")):
            status = self.put_status if method == "PUT" else self.delete_status
            if status >= 400:
                raise urllib.error.HTTPError(url, status, "error", {}, io.BytesIO(b""))
            return _Response()
        raise AssertionError(f"unexpected request {method} {url}")

    def radicale(self, method):
        return [r for r in self.requests if r["method"] == method]


class MSGraphSyncJobWritesEventsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        self.env = patch.dict(os.environ, {"DATABASE_PATH": self.db_path, "MSGRAPH_CLIENT_ID": "testuser-client-id"})
        self.env.start()
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER);
            CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, owner_user_id TEXT, uid TEXT,
                calendar_id TEXT, deleted_by TEXT, href TEXT, ics TEXT);
            CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                account_email TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT,
                delta_started_at INTEGER, target_calendar_id TEXT, reconnect_required INTEGER NOT NULL DEFAULT 0,
                sync_lock_until INTEGER, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT NOT NULL,
                account_id TEXT NOT NULL, last_synced_at INTEGER NOT NULL, e_tag TEXT);
            CREATE TABLE sync_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
                error_message TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5,
                next_retry_at INTEGER, retry_state TEXT, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE sync_job_progress (job_id TEXT PRIMARY KEY, items_done INTEGER NOT NULL DEFAULT 0);
        """)
        # A fresh access token, so the job goes straight to Graph.
        conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,"
            " target_calendar_id) VALUES ('acc1', ?, 'testuser@example.com', ?, ?, 4102444800000, 'arbeit')",
            (USER_ID, sync_worker.encrypt_token("testuser-access-token", sync_worker.KEY_BYTES),
             sync_worker.encrypt_token("testuser-refresh-token", sync_worker.KEY_BYTES)))
        conn.execute("INSERT INTO sync_queue (id, user_id, status, attempts, max_attempts, created_at, updated_at)"
                     " VALUES ('job-60', ?, 'PENDING', 0, 1, 1, 1)", (USER_ID,))
        conn.commit()
        conn.close()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp)

    def _run_job(self, fake):
        with patch.object(urllib.request, "urlopen", side_effect=fake):
            self.assertTrue(sync_worker.process_next_job(self.db_path))

    def _query(self, sql, *params):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def _job(self):
        return self._query("SELECT status, error_message FROM sync_queue WHERE id = 'job-60'")[0]

    def _mappings(self):
        return self._query("SELECT local_uid, graph_id FROM msgraph_event_mappings")

    def _delta_link(self):
        return self._query("SELECT delta_link FROM msgraph_accounts WHERE id = 'acc1'")[0][0]

    def _set_delta_link_and_mapping(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE msgraph_accounts SET delta_link = ?, delta_started_at = strftime('%s','now') * 1000",
                     (f"{DELTA}?$deltatoken=round1",))
        conn.execute("INSERT INTO msgraph_event_mappings VALUES ('msgraph-event-g1', 'g1', 'acc1', 0, '')")
        conn.commit()
        conn.close()

    def _event_page(self):
        return {"value": [{
            "id": "g1", "subject": "Test User review", "isAllDay": False,
            "start": {"dateTime": "2026-10-05T08:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-10-05T09:00:00.0000000", "timeZone": "UTC"},
        }], "@odata.deltaLink": NEXT_DELTA}

    def test_a_graph_event_is_written_into_the_target_calendar_before_the_job_succeeds(self):
        fake = FakeGraphAndRadicale(self._event_page())

        self._run_job(fake)

        self.assertEqual(self._job(), ("SUCCESS", None))
        puts = fake.radicale("PUT")
        self.assertEqual(len(puts), 1, "the event data is written to Radicale, not only a mapping row")
        self.assertTrue(puts[0]["url"].endswith(f"/{USER_ID}/arbeit/msgraph-event-g1.ics"), puts[0]["url"])
        self.assertIn("BEGIN:VEVENT\r\n", puts[0]["body"])
        self.assertIn("UID:msgraph-event-g1\r\n", puts[0]["body"])
        self.assertIn("SUMMARY:Test User review\r\n", puts[0]["body"])
        self.assertIn("DTSTART:20261005T080000Z\r\n", puts[0]["body"])
        self.assertEqual(self._mappings(), [("msgraph-event-g1", "g1")])
        self.assertEqual(self._delta_link(), NEXT_DELTA)

    def test_a_failed_radicale_put_fails_the_job_and_records_nothing(self):
        fake = FakeGraphAndRadicale(self._event_page(), put_status=500)

        self._run_job(fake)

        status, error = self._job()
        self.assertEqual(status, "ERROR")
        self.assertIn("testuser@example.com", error)
        self.assertEqual(len(fake.radicale("PUT")), 1)
        self.assertEqual(self._mappings(), [], "no mapping for an event that was never written")
        self.assertIsNone(self._delta_link(), "the changes are fetched again by the next sync")

    def test_a_graph_deletion_deletes_the_local_event(self):
        self._set_delta_link_and_mapping()
        fake = FakeGraphAndRadicale({"value": [{"id": "g1", "@removed": {"reason": "deleted"}}],
                                     "@odata.deltaLink": NEXT_DELTA})

        self._run_job(fake)

        self.assertEqual(self._job(), ("SUCCESS", None))
        deletes = fake.radicale("DELETE")
        self.assertEqual(len(deletes), 1, "the local event is deleted, not only its mapping row")
        self.assertTrue(deletes[0]["url"].endswith(f"/{USER_ID}/arbeit/msgraph-event-g1.ics"), deletes[0]["url"])
        self.assertEqual(self._mappings(), [])
        self.assertEqual(self._delta_link(), NEXT_DELTA)

    def test_a_failed_radicale_delete_fails_the_job_and_keeps_the_mapping(self):
        self._set_delta_link_and_mapping()
        fake = FakeGraphAndRadicale({"value": [{"id": "g1", "@removed": {"reason": "deleted"}}],
                                     "@odata.deltaLink": NEXT_DELTA}, delete_status=500)

        self._run_job(fake)

        status, error = self._job()
        self.assertEqual(status, "ERROR")
        self.assertTrue(error)
        self.assertEqual(self._mappings(), [("msgraph-event-g1", "g1")], "the local event still exists")
        self.assertEqual(self._delta_link(), f"{DELTA}?$deltatoken=round1")


if __name__ == "__main__":
    unittest.main()
