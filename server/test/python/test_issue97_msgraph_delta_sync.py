"""Issue #97 — the Microsoft Graph import in sync-worker/msgraph_worker.py, the only Graph sync path.

Microsoft is replaced by a local fake (urlopen is routed to it) that answers as the documented Graph
and identity-platform contracts do; no request leaves the process.
  (a) change tracking runs on /me/calendarView/delta, pages nextLink, persists only the deltaLink;
  (b) token refresh sends client_id, scope and client_secret; invalid_grant means "reconnect";
  (d) a database lease keeps two syncs of one account apart, across connections;
  (e) times are requested in UTC (Prefer: outlook.timezone) and timeZone is read, not assumed.
"""
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
from unittest.mock import MagicMock, patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import msgraph_worker  # noqa: E402

TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
GRAPH = "https://graph.microsoft.com/v1.0"
CLIENT_ID = "00000000-0000-0000-0000-00000000c1d0"


def graph_event(graph_id, start="2026-10-05T12:00:00.0000000", end="2026-10-05T13:00:00.0000000", zone="UTC", **extra):
    event = {"id": graph_id, "subject": "Test User meeting",
             "start": {"dateTime": start, "timeZone": zone}, "end": {"dateTime": end, "timeZone": zone}}
    event.update(extra)
    return event


class _Response:
    def __init__(self, body):
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class FakeMicrosoft:
    """Routes urlopen: the token endpoint, Graph delta pages by URL, and the local Radicale."""

    def __init__(self, pages=None, token_response=None, on_graph=None):
        self.pages = pages or {}
        self.token_response = token_response
        self.on_graph = on_graph
        self.requests = []

    def __call__(self, req, context=None, timeout=None):
        assert timeout, "every request to Microsoft or Radicale carries a timeout"
        url = req.full_url
        record = {"method": req.get_method(), "url": url, "headers": dict(req.header_items()),
                  "body": req.data.decode("utf-8") if req.data else ""}
        self.requests.append(record)
        if url == TOKEN_URL:
            status, body = self.token_response
            if status != 200:
                raise urllib.error.HTTPError(url, status, "error", {}, io.BytesIO(json.dumps(body).encode("utf-8")))
            return _Response(json.dumps(body))
        if url.startswith(GRAPH):
            if self.on_graph:
                self.on_graph()
            for prefix, page in self.pages.items():
                if url.startswith(prefix):
                    if isinstance(page, int):
                        raise urllib.error.HTTPError(url, page, "error", {}, io.BytesIO(b"{}"))
                    return _Response(json.dumps(page))
            raise AssertionError(f"unexpected Graph request {url}")
        # Local Radicale: PUT / DELETE succeed; it keeps no content to read for the trash (#597).
        if req.get_method() == "GET":
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))
        return _Response("")

    def of(self, kind):
        if kind == "token":
            return [r for r in self.requests if r["url"] == TOKEN_URL]
        if kind == "graph":
            return [r for r in self.requests if r["url"].startswith(GRAPH)]
        return [r for r in self.requests if r["method"] == kind and not r["url"].startswith(("https://login", GRAPH))]


class MSGraphDeltaSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        self.conn = self._connect()
        self.conn.execute("""CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            account_email TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT,
            delta_started_at INTEGER, target_calendar_id TEXT, reconnect_required INTEGER NOT NULL DEFAULT 0,
            sync_lock_until INTEGER, created_at INTEGER, updated_at INTEGER)""")
        self.conn.execute("""CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT NOT NULL,
            account_id TEXT NOT NULL, last_synced_at INTEGER NOT NULL, e_tag TEXT)""")
        self.conn.execute("""CREATE TABLE msgraph_restores (account_id TEXT NOT NULL, href TEXT NOT NULL,
            created_at INTEGER NOT NULL, PRIMARY KEY (account_id, href))""")
        self.conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,"
            " delta_link, target_calendar_id) VALUES ('acc1', 'testuser', 'testuser@example.com',"
            " ?, ?, 4102444800000, NULL, 'persoenlich')",
            (msgraph_worker.encrypt_token("testuser-access-token"), msgraph_worker.encrypt_token("testuser-refresh-token")))
        self.conn.commit()
        self.env = patch.dict(os.environ, {"MSGRAPH_CLIENT_ID": CLIENT_ID})
        self.env.start()
        os.environ.pop("MSGRAPH_CLIENT_SECRET", None)

    def tearDown(self):
        self.env.stop()
        self.conn.close()
        shutil.rmtree(self.tmp)

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _account(self):
        return self.conn.execute("SELECT * FROM msgraph_accounts WHERE id = 'acc1'").fetchone()

    def _sync(self, fake, conn=None):
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=fake):
            return msgraph_worker.sync_msgraph_accounts("testuser", conn or self.conn)

    # --- (a) delta endpoint, paging, deltaLink -------------------------------------------------

    def test_first_round_uses_calendar_view_delta_pages_next_link_and_persists_only_the_delta_link(self):
        next_link = f"{GRAPH}/me/calendarView/delta?$skiptoken=page2"
        delta_link = f"{GRAPH}/me/calendarView/delta?$deltatoken=round1"
        fake = FakeMicrosoft(pages={
            next_link: {"value": [graph_event("g2")], "@odata.deltaLink": delta_link},
            f"{GRAPH}/me/calendarView/delta?startDateTime=": {"value": [graph_event("g1")], "@odata.nextLink": next_link},
        })

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        urls = [r["url"] for r in fake.of("graph")]
        self.assertEqual(len(urls), 2)
        first = urllib.parse.urlsplit(urls[0])
        self.assertEqual(f"{first.scheme}://{first.netloc}{first.path}", f"{GRAPH}/me/calendarView/delta")
        window = urllib.parse.parse_qs(first.query)
        self.assertIn("startDateTime", window)
        self.assertIn("endDateTime", window)
        self.assertEqual(urls[1], next_link, "the nextLink is followed within the same run")
        self.assertEqual(self._account()["delta_link"], delta_link, "only the deltaLink is a delta token")
        self.assertEqual(len(fake.of("PUT")), 2)

    def test_a_page_with_neither_next_link_nor_delta_link_fails_and_stores_nothing(self):
        fake = FakeMicrosoft(pages={f"{GRAPH}/me/calendarView/delta": {"value": []}})

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("neither nextLink nor deltaLink", error)
        self.assertIsNone(self._account()["delta_link"], "a page URL must never be stored as a delta token")

    def test_removed_item_in_a_delta_round_deletes_the_local_copy(self):
        stored = f"{GRAPH}/me/calendarView/delta?$deltatoken=round1"
        self.conn.execute("UPDATE msgraph_accounts SET delta_link = ?", (stored,))
        self.conn.execute("INSERT INTO msgraph_event_mappings VALUES ('msgraph-event-g1', 'g1', 'acc1', 0, '')")
        self.conn.commit()
        fake = FakeMicrosoft(pages={stored: {
            "value": [{"id": "g1", "@removed": {"reason": "deleted"}}],
            "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=round2"}})

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertEqual(fake.of("graph")[0]["url"], stored, "a stored delta link continues the round")
        deletes = fake.of("DELETE")
        self.assertEqual(len(deletes), 1)
        self.assertTrue(deletes[0]["url"].endswith("/testuser/persoenlich/msgraph-event-g1.ics"))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM msgraph_event_mappings").fetchone()[0], 0)

    # --- (b) token refresh ---------------------------------------------------------------------

    def _expire(self):
        self.conn.execute("UPDATE msgraph_accounts SET expires_at = 0")
        self.conn.commit()

    def _delta_page(self):
        return {f"{GRAPH}/me/calendarView/delta": {"value": [], "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=x"}}

    def test_refresh_sends_client_id_scope_and_secret_and_stores_the_rotated_tokens(self):
        self._expire()
        os.environ["MSGRAPH_CLIENT_SECRET"] = "testuser-client-secret"
        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(200, {
            "access_token": "testuser-new-access", "refresh_token": "testuser-new-refresh", "expires_in": 3600}))

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        body = urllib.parse.parse_qs(fake.of("token")[0]["body"])
        self.assertEqual(body["client_id"], [CLIENT_ID])
        self.assertEqual(body["client_secret"], ["testuser-client-secret"])
        self.assertEqual(body["grant_type"], ["refresh_token"])
        self.assertEqual(body["refresh_token"], ["testuser-refresh-token"])
        self.assertEqual(set(body["scope"][0].split()), {"offline_access", "User.Read", "Calendars.ReadWrite"})
        self.assertEqual(fake.of("graph")[0]["headers"]["Authorization"], "Bearer testuser-new-access")
        row = self._account()
        self.assertEqual(msgraph_worker.decrypt_token(row["refresh_token"]), "testuser-new-refresh")
        self.assertGreater(row["expires_at"], int(time.time() * 1000))

    def test_public_client_refresh_sends_no_secret(self):
        self._expire()
        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(200, {"access_token": "a", "expires_in": 3600}))

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        body = urllib.parse.parse_qs(fake.of("token")[0]["body"], keep_blank_values=True)
        self.assertNotIn("client_secret", body)
        self.assertEqual(msgraph_worker.decrypt_token(self._account()["refresh_token"]), "testuser-refresh-token")

    def test_refresh_without_a_configured_client_id_fails_without_a_placeholder_id(self):
        self._expire()
        del os.environ["MSGRAPH_CLIENT_ID"]
        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(200, {"access_token": "a"}))

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("MSGRAPH_CLIENT_ID", error)
        self.assertEqual(fake.requests, [], "no token request may go out with an invented client id")

    def test_invalid_grant_is_a_reconnect_error_and_marks_the_account(self):
        self._expire()
        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(400, {
            "error": "invalid_grant", "error_description": "AADSTS70008: The refresh token has expired."}))

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("please reconnect", error)
        self.assertEqual(fake.of("graph"), [], "an expired authorization must not be presented to Graph")
        self.assertEqual(self._account()["reconnect_required"], 1)

        again = FakeMicrosoft(pages=self._delta_page(), token_response=(200, {"access_token": "a"}))
        ok, error = self._sync(again)
        self.assertFalse(ok)
        self.assertIn("please reconnect", error)
        self.assertEqual(again.requests, [], "a refused refresh token is not retried")

    def test_other_refresh_failures_are_not_reported_as_reconnect(self):
        self._expire()
        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(503, {"error": "temporarily_unavailable"}))

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("token refresh failed", error)
        self.assertNotIn("reconnect", error)
        self.assertEqual(self._account()["reconnect_required"], 0)

    # --- (d) per-account lease -----------------------------------------------------------------

    def test_a_sync_started_while_another_holds_the_account_does_not_touch_graph(self):
        nested = {}

        def second_process_starts():
            if "result" in nested:
                return
            other = self._connect()
            inner = FakeMicrosoft(pages=self._delta_page())
            with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=inner):
                nested["result"] = msgraph_worker.sync_msgraph_accounts("testuser", other)
            other.close()
            nested["inner_requests"] = inner.requests

        fake = FakeMicrosoft(pages={f"{GRAPH}/me/calendarView/delta": {
            "value": [graph_event("g1")], "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=x"}},
            on_graph=second_process_starts)

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertEqual(nested["inner_requests"], [], "the overlapping sync must not fetch or write anything")
        self.assertIsNone(self._account()["sync_lock_until"], "the lease is released when the sync ends")
        self.assertEqual(len(fake.of("PUT")), 1)

    def test_a_lease_held_by_another_process_skips_the_account(self):
        held_until = int(time.time() * 1000) + 10 * 60 * 1000
        self.conn.execute("UPDATE msgraph_accounts SET sync_lock_until = ?", (held_until,))
        self.conn.commit()
        fake = FakeMicrosoft(pages=self._delta_page())

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertEqual(fake.requests, [], "nothing is fetched or written while another process syncs")
        self.assertEqual(self._account()["sync_lock_until"], held_until, "another process's lease is left alone")

    def test_the_lease_is_held_in_the_database_while_syncing(self):
        seen = []

        def look_from_another_connection():
            other = self._connect()
            seen.append(other.execute("SELECT sync_lock_until FROM msgraph_accounts WHERE id = 'acc1'").fetchone()[0])
            other.close()

        fake = FakeMicrosoft(pages=self._delta_page(), on_graph=look_from_another_connection)

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertIsNotNone(seen[0])
        self.assertGreater(seen[0], int(time.time() * 1000), "other processes see a lease in the future")

    def test_an_expired_lease_does_not_block_the_account(self):
        self.conn.execute("UPDATE msgraph_accounts SET sync_lock_until = 1")
        self.conn.commit()
        fake = FakeMicrosoft(pages=self._delta_page())

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertEqual(len(fake.of("graph")), 1)

    # --- (e) time zones ------------------------------------------------------------------------

    def test_every_graph_request_pins_utc_and_the_event_keeps_its_instant(self):
        next_link = f"{GRAPH}/me/calendarView/delta?$skiptoken=page2"
        fake = FakeMicrosoft(pages={
            next_link: {"value": [graph_event("allday", start="2026-10-06T00:00:00.0000000",
                                                 end="2026-10-07T00:00:00.0000000", isAllDay=True)],
                        "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=x"},
            f"{GRAPH}/me/calendarView/delta?startDateTime=": {
                "value": [graph_event("g1", subject="Plan, review; Test\nUser", body={"content": "Agenda; Test User"},
                                      location={"displayName": "Room 1, Floor 2"})], "@odata.nextLink": next_link},
        })

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        for request in fake.of("graph"):
            self.assertIn('outlook.timezone="UTC"', request["headers"].get("Prefer", ""))
        timed, all_day = fake.of("PUT")
        self.assertIn("DTSTART:20261005T120000Z\r\n", timed["body"])
        self.assertIn("DTEND:20261005T130000Z\r\n", timed["body"])
        self.assertIn("SUMMARY:Plan\\, review\\; Test\\nUser\r\n", timed["body"])
        self.assertIn("DESCRIPTION:Agenda\\; Test User\r\n", timed["body"])
        self.assertIn("LOCATION:Room 1\\, Floor 2\r\n", timed["body"])
        self.assertIn("DTSTART;VALUE=DATE:20261006\r\n", all_day["body"])
        self.assertIn("DTEND;VALUE=DATE:20261007\r\n", all_day["body"])

    def test_a_non_utc_time_is_never_read_as_utc(self):
        fake = FakeMicrosoft(pages={f"{GRAPH}/me/calendarView/delta": {
            "value": [graph_event("g1", start="2026-10-05T14:00:00.0000000", end="2026-10-05T15:00:00.0000000",
                                  zone="W. Europe Standard Time")],
            "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=x"}})

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("W. Europe Standard Time", error)
        self.assertEqual(fake.of("PUT"), [], "a 14:00 W. Europe event must not be stored as 14:00Z")
        self.assertIsNone(self._account()["delta_link"])

    def test_an_event_that_cannot_be_stored_fails_its_account_only(self):
        broken = f"{GRAPH}/me/calendarView/delta?$deltatoken=acc1"
        healthy = f"{GRAPH}/me/calendarView/delta?$deltatoken=acc2"
        self.conn.execute("UPDATE msgraph_accounts SET delta_link = ?", (broken,))
        self.conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,"
            " delta_link, target_calendar_id) VALUES ('acc2', 'testuser', 'testuser2@example.com',"
            " ?, ?, 4102444800000, ?, 'persoenlich')",
            (msgraph_worker.encrypt_token("testuser-access-token-2"), msgraph_worker.encrypt_token("testuser-refresh-token-2"),
             healthy))
        self.conn.commit()
        fake = FakeMicrosoft(pages={
            broken: {"value": [graph_event("g1", zone="Pacific Standard Time")], "@odata.deltaLink": broken + "-next"},
            healthy: {"value": [graph_event("g2")], "@odata.deltaLink": healthy + "-next"},
        })

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIn("testuser@example.com", error)
        self.assertNotIn("testuser2@example.com", error)
        puts = fake.of("PUT")
        self.assertEqual(len(puts), 1)
        self.assertTrue(puts[0]["url"].endswith("/msgraph-event-g2.ics"), "the other account is synced")
        self.assertEqual(self._account()["delta_link"], broken, "the failing account is fetched again next time")
        self.assertIsNone(self._account()["sync_lock_until"], "the lease is released after a failure")

    def test_a_failed_later_page_stores_no_page_link(self):
        next_link = f"{GRAPH}/me/calendarView/delta?$skiptoken=page2"
        fake = FakeMicrosoft(pages={
            next_link: 500,
            f"{GRAPH}/me/calendarView/delta?startDateTime=": {"value": [graph_event("g1")], "@odata.nextLink": next_link},
        })

        ok, error = self._sync(fake)

        self.assertFalse(ok)
        self.assertIsNone(self._account()["delta_link"], "a nextLink is never kept as a checkpoint")

    # --- isolation and round lifetime ----------------------------------------------------------

    def test_an_account_waiting_for_reconnect_does_not_stop_the_users_other_accounts(self):
        self.conn.execute("UPDATE msgraph_accounts SET reconnect_required = 1")
        self.conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,"
            " target_calendar_id) VALUES ('acc2', 'testuser', 'testuser2@example.com', ?, ?, 4102444800000, 'persoenlich')",
            (msgraph_worker.encrypt_token("testuser-access-token-2"), msgraph_worker.encrypt_token("testuser-refresh-token-2")))
        self.conn.commit()
        fake = FakeMicrosoft(pages={f"{GRAPH}/me/calendarView/delta": {
            "value": [graph_event("g2")], "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=acc2"}})

        ok, error = self._sync(fake)

        self.assertFalse(ok, "the job still reports the account that needs the user")
        self.assertIn("testuser@example.com", error)
        self.assertIn("please reconnect", error)
        self.assertEqual(len(fake.of("PUT")), 1, "the second account is synced anyway")
        row = self.conn.execute("SELECT delta_link FROM msgraph_accounts WHERE id = 'acc2'").fetchone()
        self.assertEqual(row["delta_link"], f"{GRAPH}/me/calendarView/delta?$deltatoken=acc2")

    def test_a_reconnect_during_a_refused_refresh_is_not_flagged(self):
        self._expire()

        def reconnect_while_refreshing():
            other = self._connect()
            other.execute("UPDATE msgraph_accounts SET refresh_token = ?, reconnect_required = 0",
                          (msgraph_worker.encrypt_token("testuser-fresh-refresh"),))
            other.commit()
            other.close()

        fake = FakeMicrosoft(pages=self._delta_page(), token_response=(400, {"error": "invalid_grant"}))
        original = fake.__call__

        def refresh_then_refuse(req, context=None, timeout=None):
            if req.full_url == TOKEN_URL:
                reconnect_while_refreshing()
            return original(req, context, timeout)

        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=refresh_then_refuse):
            ok, error = msgraph_worker.sync_msgraph_accounts("testuser", self.conn)

        self.assertFalse(ok)
        self.assertEqual(self._account()["reconnect_required"], 0, "the freshly connected tokens are not flagged")

    def test_a_delta_round_older_than_thirty_days_starts_over_with_a_current_window(self):
        stale = f"{GRAPH}/me/calendarView/delta?$deltatoken=old-window"
        now_ms = int(time.time() * 1000)
        self.conn.execute("UPDATE msgraph_accounts SET delta_link = ?, delta_started_at = ?",
                          (stale, now_ms - 31 * 86400 * 1000))
        self.conn.commit()
        fake = FakeMicrosoft(pages={f"{GRAPH}/me/calendarView/delta?startDateTime=": {
            "value": [], "@odata.deltaLink": f"{GRAPH}/me/calendarView/delta?$deltatoken=new-window"}})

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        first = urllib.parse.parse_qs(urllib.parse.urlsplit(fake.of("graph")[0]["url"]).query)
        window_end = time.mktime(time.strptime(first["endDateTime"][0], "%Y-%m-%dT%H:%M:%SZ"))
        self.assertGreater(window_end, time.time() + 700 * 86400, "the new window reaches ahead from today")
        row = self._account()
        self.assertEqual(row["delta_link"], f"{GRAPH}/me/calendarView/delta?$deltatoken=new-window")
        self.assertGreaterEqual(row["delta_started_at"], now_ms)

    def test_a_recent_delta_round_is_continued(self):
        current = f"{GRAPH}/me/calendarView/delta?$deltatoken=current"
        started = int(time.time() * 1000) - 86400 * 1000
        self.conn.execute("UPDATE msgraph_accounts SET delta_link = ?, delta_started_at = ?", (current, started))
        self.conn.commit()
        fake = FakeMicrosoft(pages={current: {"value": [], "@odata.deltaLink": current + "2"}})

        ok, error = self._sync(fake)

        self.assertTrue(ok, error)
        self.assertEqual(fake.of("graph")[0]["url"], current)
        self.assertEqual(self._account()["delta_started_at"], started, "continuing a round keeps its start, so it ages out")


TEST_DIR = os.path.dirname(os.path.abspath(__file__))
if TEST_DIR not in sys.path:
    sys.path.insert(0, TEST_DIR)
import test_issue193_google_collection_mapping as issue193  # noqa: E402  (module import: its tests are not re-collected)

import sync_worker  # noqa: E402


class GoogleSyncDespiteMicrosoftErrorTest(unittest.TestCase):
    """A Microsoft account waiting for reconnect must not stop the user's Google pairs (sync_worker.sync_user)."""

    setUp = issue193.TestIssue193GoogleCollectionMapping.setUp
    tearDown = issue193.TestIssue193GoogleCollectionMapping.tearDown
    add_google_account = issue193.TestIssue193GoogleCollectionMapping.add_google_account

    def test_google_pairs_run_and_the_microsoft_error_is_the_job_result(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        commands = []

        def fake_run(cmd, *args, **kwargs):
            commands.append(cmd[3])
            return MagicMock(returncode=0, stdout="", stderr="")

        def fake_urlopen(req, *args, **kwargs):
            res = MagicMock(status=201)
            res.__enter__ = lambda s: s
            res.__exit__ = lambda s, *a: False
            return res

        reconnect = "Microsoft 365 authorization for testuser@example.com has expired; please reconnect the account"
        with patch.object(sync_worker, "discover_google_collections",
                          return_value=[{"id": "primary", "name": "Privat"}]), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(False, reconnect)), \
             patch.object(sync_worker.urllib.request, "urlopen", side_effect=fake_urlopen), \
             patch.object(sync_worker, "snapshot_mirrors", return_value={}), \
             patch("subprocess.run", side_effect=fake_run):
            ok, error = sync_worker.sync_user(issue193.USER_ID)

        self.assertEqual(commands, ["discover", "sync", "metasync"], "the Google pair is synced")
        self.assertFalse(ok)
        self.assertEqual(error, reconnect)


if __name__ == "__main__":
    unittest.main()
