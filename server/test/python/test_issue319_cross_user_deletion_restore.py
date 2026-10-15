"""Issue #319 — a sharee's delete must not be exported into the owner's external calendar.

Drives the real sync_user() for an owner with a pending cross_user_deletions row against a
loopback stand-in for the shard's Radicale. The replication passes (Basic-auth CalDAV pair,
MS Graph, Google) are replaced by recorders that snapshot what Radicale holds when they start:
the deleted event must already be back by then for every owner with a two-way CalDAV or Google
account. MS Graph only imports, so a Graph-only owner keeps the sharee's delete.
"""
import base64
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402

OWNER = "31931931-3193-4193-8193-319319319319"
HREF = f"/{OWNER}/privat/victim-evt.ics"
OTHER_OWNER = "31931931-3193-4193-8193-000000000002"
OTHER_HREF = f"/{OTHER_OWNER}/privat/other-evt.ics"
EVENT_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
    "BEGIN:VEVENT\r\nUID:victim-evt\r\nSUMMARY:Test User meeting\r\nDTSTART:20261020T090000Z\r\n"
    "DTEND:20261020T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


class _Radicale:
    """Loopback CalDAV store: PUT with If-None-Match: * creates an item or answers 412."""

    def __init__(self, put_status=None):
        self.items = {}
        self.requests = []
        store, requests = self.items, self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
                requests.append({"path": self.path, "if_none_match": self.headers.get("If-None-Match"),
                                 "accept_encoding": self.headers.get("Accept-Encoding"),
                                 "authorization": self.headers.get("Authorization")})
                if put_status:
                    status = put_status
                elif self.path in store and self.headers.get("If-None-Match") == "*":
                    status = 412
                else:
                    store[self.path] = body
                    status = 201
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class CrossUserDeletionRestoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        self._saved = {k: os.environ.get(k) for k in ("DATABASE_PATH", "STATUS_ROOT")}
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = os.path.join(self.tmp, "status")
        self._saved_local = sync_worker.LOCAL_CALDAV_URL
        conn = sqlite3.connect(self.db_path)
        conn.execute("""CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT,
                        username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT,
                        expires_at INTEGER)""")
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        # Same shape as server/db.js.
        conn.execute("""CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT NOT NULL,
                        calendar_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, deleted_by TEXT NOT NULL,
                        href TEXT NOT NULL, ics TEXT NOT NULL, created_at INTEGER NOT NULL)""")
        conn.execute("INSERT INTO cross_user_deletions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     ("rec-1", "victim-evt", f"internal-caldav::/{OWNER}/privat/", OWNER,
                      "testuser-sharee", HREF, EVENT_ICS, 1))
        # Another owner's pending restore: not this job's business.
        conn.execute("INSERT INTO cross_user_deletions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     ("rec-other", "other-evt", f"internal-caldav::/{OTHER_OWNER}/privat/", OTHER_OWNER,
                      "testuser-sharee", OTHER_HREF, EVENT_ICS, 1))
        conn.commit()
        conn.close()
        self.radicale = None
        self.calls = []

    def tearDown(self):
        if self.radicale:
            self.radicale.close()
        sync_worker.LOCAL_CALDAV_URL = self._saved_local
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp)

    def _link(self, table_sql, params):
        conn = sqlite3.connect(self.db_path)
        conn.execute(table_sql, params)
        conn.commit()
        conn.close()

    def _reset_record(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("INSERT OR IGNORE INTO cross_user_deletions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     ("rec-1", "victim-evt", f"internal-caldav::/{OWNER}/privat/", OWNER,
                      "testuser-sharee", HREF, EVENT_ICS, 1))
        conn.commit()
        conn.close()

    def _start_radicale(self, **kw):
        self.radicale = _Radicale(**kw)
        sync_worker.LOCAL_CALDAV_URL = self.radicale.url

    def _recorder(self, name):
        def run(user_id, conn):
            self.calls.append((name, dict(self.radicale.items)))
            return True, ""
        return run

    def _pending(self):
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute("SELECT id FROM cross_user_deletions WHERE owner_user_id = ?", (OWNER,)).fetchall()
        other = conn.execute("SELECT id FROM cross_user_deletions WHERE owner_user_id = ?", (OTHER_OWNER,)).fetchall()
        conn.close()
        self.assertEqual(len(other), 1, "another owner's record must be left alone")
        return rows

    def _sync(self):
        with patch.object(sync_worker, "sync_basic_caldav_accounts", self._recorder("basic")), \
             patch.object(sync_worker, "sync_msgraph_accounts", self._recorder("msgraph")):
            return sync_worker.sync_user(OWNER)

    def test_basic_auth_owner_gets_the_event_back_before_the_two_way_pair_runs(self):
        self._start_radicale()
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, auth_type) VALUES (?, ?, ?, ?, 'basic')",
                   ("acc-basic", OWNER, "https://caldav.example.com/", "testuser"))

        self.assertEqual(self._sync(), (True, ""))

        self.assertEqual(self.calls[0][0], "basic")
        self.assertEqual(self.calls[0][1].get(HREF), EVENT_ICS,
                         "the sharee-deleted event must be back in Radicale before the pair can export the delete")
        self.assertEqual([r["path"] for r in self.radicale.requests], [HREF])
        self.assertEqual(self.radicale.requests[0]["if_none_match"], "*")
        self.assertEqual(self.radicale.requests[0]["accept_encoding"], "identity")
        expected_auth = base64.b64encode(f"{OWNER}:{sync_worker.SYSTEM_SYNC_SECRET}".encode()).decode()
        self.assertEqual(self.radicale.requests[0]["authorization"], f"Basic {expected_auth}")
        self.assertEqual(self._pending(), [], "a restored deletion is done")

    def test_google_owner_gets_the_event_back_before_the_google_pair_is_built(self):
        self._start_radicale()
        # An undecryptable refresh token stops the Google pass right after it starts.
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
                   " VALUES (?, ?, ?, ?, '00', '00', 'oauth2')",
                   ("acc-google", OWNER, "https://apidata.googleusercontent.com/caldav/v2/", "testuser@example.com"))

        ok, _ = self._sync()

        self.assertFalse(ok)
        self.assertEqual(self.radicale.items.get(HREF), EVENT_ICS)
        self.assertEqual(self._pending(), [])

    def test_msgraph_only_owner_keeps_the_delete(self):
        # The Graph sync only imports, so it cannot export the delete: nothing is put back.
        self._start_radicale()
        self._link("INSERT INTO msgraph_accounts (id, user_id) VALUES (?, ?)", ("acc-graph", OWNER))

        self.assertEqual(self._sync(), (True, ""))

        self.assertEqual([name for name, _ in self.calls], ["basic", "msgraph"])
        self.assertEqual(self.radicale.requests, [])
        self.assertEqual(self._pending(), [])

    def test_restore_logs_in_as_the_owner_named_in_the_path(self):
        # The calendar path may carry the username while the job runs under the UUID; the rights
        # plugin only grants the owner whose name is the path's first segment.
        username_href = "/testuser-owner319/privat/victim-evt.ics"
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE cross_user_deletions SET href = ? WHERE id = 'rec-1'", (username_href,))
        conn.commit()
        conn.close()
        self._start_radicale()
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, auth_type) VALUES (?, ?, ?, ?, 'basic')",
                   ("acc-basic", OWNER, "https://caldav.example.com/", "testuser"))

        self.assertEqual(self._sync(), (True, ""))

        self.assertEqual([r["path"] for r in self.radicale.requests], [username_href])
        expected_auth = base64.b64encode(f"testuser-owner319:{sync_worker.SYSTEM_SYNC_SECRET}".encode()).decode()
        self.assertEqual(self.radicale.requests[0]["authorization"], f"Basic {expected_auth}")
        self.assertEqual(self._pending(), [])

    def test_failed_restore_stops_the_sync_before_any_pair_and_keeps_the_record(self):
        self._start_radicale(put_status=500)
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, auth_type) VALUES (?, ?, ?, ?, 'basic')",
                   ("acc-basic", OWNER, "https://caldav.example.com/", "testuser"))

        ok, err = self._sync()

        self.assertFalse(ok)
        self.assertIn("victim-evt", err)
        self.assertEqual(self.calls, [], "no pair may run while the deleted event is missing locally")
        self.assertEqual(len(self._pending()), 1, "the next sync must retry the restore")

    def test_restore_into_a_calendar_that_no_longer_exists_is_dropped(self):
        # Radicale answers 409 (or 404) for a PUT below a missing collection; retrying would block every sync.
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, auth_type) VALUES (?, ?, ?, ?, 'basic')",
                   ("acc-basic", OWNER, "https://caldav.example.com/", "testuser"))
        for status in (404, 409):
            with self.subTest(status=status):
                self._reset_record()
                self.calls = []
                self._start_radicale(put_status=status)

                self.assertEqual(self._sync(), (True, ""))

                self.assertEqual(self.calls[0][0], "basic", "the sync goes on")
                self.assertEqual(self._pending(), [])
                self.radicale.close()
        self.radicale = None

    def test_event_recreated_meanwhile_is_not_overwritten(self):
        self._start_radicale()
        self.radicale.items[HREF] = "newer local version"
        self._link("INSERT INTO linked_accounts (id, user_id, url, username, auth_type) VALUES (?, ?, ?, ?, 'basic')",
                   ("acc-basic", OWNER, "https://caldav.example.com/", "testuser"))

        self.assertEqual(self._sync(), (True, ""))

        self.assertEqual(self.radicale.items[HREF], "newer local version")
        self.assertEqual(self._pending(), [])

    def test_owner_without_external_accounts_keeps_the_delete(self):
        # Nothing mirrors the calendar, so nothing can be exported: the sharee's delete stands.
        self._start_radicale()

        self.assertEqual(self._sync(), (True, ""))

        self.assertEqual(self.radicale.requests, [])
        self.assertEqual(self._pending(), [])


if __name__ == "__main__":
    unittest.main()
