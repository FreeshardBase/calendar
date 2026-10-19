"""Issue #597 — an event or task deleted at the provider lands in the shard trash on the next sync.

vdirsyncer pairs (Basic-auth CalDAV and Google): the real sync_user() runs against in-memory CalDAV
servers on 127.0.0.1 (the local Radicale and the provider). vdirsyncer itself is replaced by
simulate_vdirsyncer(), which applies what vdirsyncer 0.19.3 `sync` does with a pair's items and its
status: an item known from the last run and gone on one side is deleted on the other, an item new on
one side is copied to the other.

Microsoft 365: the real sync_msgraph_accounts() with Graph replaced by a fake (urlopen is routed to
it) and the local Radicale by the same in-memory server.

In both, the deleted item must be in `trash_items` (same shape as server/db.js) with its last known
ICS, and restoring it (the trash route PUTs the payload back, and for Graph queues
`msgraph_restores`) must write it back to the provider.
"""
import configparser
import hashlib
import http.server
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import MagicMock, patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402
import msgraph_worker  # noqa: E402

USER_ID = "testuser"
GRAPH = "https://graph.microsoft.com/v1.0"


def ics(component, uid, summary, extra=""):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
            f"BEGIN:{component}\r\nUID:{uid}\r\nSUMMARY:{summary}\r\n{extra}"
            f"END:{component}\r\nEND:VCALENDAR\r\n")


EVENT = ics("VEVENT", "evt597", "Planning with Test User", "DTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n")
TASK = ics("VTODO", "task597", "Write report", "STATUS:NEEDS-ACTION\r\n")
KEPT = ics("VEVENT", "kept597", "Still there", "DTSTART:20261021T090000Z\r\nDTEND:20261021T100000Z\r\n")

# server/db.js
TRASH_SQL = """CREATE TABLE trash_items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'task', 'calendar')), calendar_id TEXT NOT NULL,
    title TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'shard' CHECK (origin IN ('shard', 'provider')),
    payload TEXT NOT NULL, deleted_at INTEGER NOT NULL)"""
RESTORES_SQL = """CREATE TABLE msgraph_restores (account_id TEXT NOT NULL, href TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (account_id, href))"""


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def etag_of(data):
    """The ETag the fake Radicale gives an item: it changes whenever the content does."""
    return '"' + hashlib.md5(data.encode("utf-8")).hexdigest() + '"'


class MemCalDAV:
    """CalDAV server with one calendar home: collections (name -> {resource: ics})."""

    def __init__(self, home):
        self.home = home
        self.collections = {}
        self.names = {}
        dav = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(length).decode("utf-8") if length else ""

            def _reply(self, status, body=b"", ctype="application/xml; charset=utf-8", etag=None):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                if etag:
                    self.send_header("ETag", etag)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _split(self):
                rel = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)[len(dav.home):]
                parts = [p for p in rel.split("/") if p]
                return (parts + [None, None])[:2]

            def do_PROPFIND(self):
                self._body()
                rows = [f"<d:response><d:href>{dav.home}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/>"
                        "</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"]
                for name in dav.collections:
                    rows.append(f"<d:response><d:href>{dav.home}{name}/</d:href><d:propstat><d:prop><d:resourcetype>"
                                "<d:collection/><c:calendar/></d:resourcetype>"
                                f"<d:displayname>{xml_escape(dav.names[name])}</d:displayname></d:prop>"
                                "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
                self._reply(207, ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" '
                                  'xmlns:c="urn:ietf:params:xml:ns:caldav">' + "".join(rows)
                                  + "</d:multistatus>").encode("utf-8"))

            def _create(self):
                self._body()
                coll, _ = self._split()
                dav.collections.setdefault(coll, {})
                dav.names.setdefault(coll, coll)
                self._reply(201)

            do_MKCALENDAR = _create
            do_MKCOL = _create

            def do_PROPPATCH(self):
                self._body()
                self._reply(207, b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>x</d:href>'
                                 b'<d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')

            def do_REPORT(self):
                self._body()
                coll, _ = self._split()
                if coll not in dav.collections:
                    return self._reply(404)
                rows = [f"<d:response><d:href>{dav.home}{coll}/{res}</d:href><d:propstat><d:prop>"
                        f"<d:getetag>{xml_escape(etag_of(data))}</d:getetag>"
                        f"<c:calendar-data>{xml_escape(data)}</c:calendar-data></d:prop>"
                        "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                        for res, data in dav.collections[coll].items()]
                self._reply(207, ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" '
                                  'xmlns:c="urn:ietf:params:xml:ns:caldav">' + "".join(rows)
                                  + "</d:multistatus>").encode("utf-8"))

            def do_GET(self):
                coll, res = self._split()
                data = dav.collections.get(coll, {}).get(res)
                if data is None:
                    return self._reply(404)
                self._reply(200, data.encode("utf-8"), "text/calendar")

            def do_PUT(self):
                body = self._body()
                coll, res = self._split()
                if coll not in dav.collections:
                    return self._reply(409)
                existed = res in dav.collections[coll]
                dav.collections[coll][res] = body
                self._reply(204 if existed else 201, etag=etag_of(body))

            def do_DELETE(self):
                coll, res = self._split()
                if dav.collections.get(coll, {}).pop(res, None) is None:
                    return self._reply(404)
                self._reply(204)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def url(self):
        return self.base + self.home

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


def trash_rows(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM trash_items ORDER BY title")]
    conn.close()
    for r in rows:
        r["payload"] = json.loads(r["payload"])
    return rows


class VdirsyncerPairsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        self.env = patch.dict(os.environ, {"DATABASE_PATH": self.db_path, "STATUS_ROOT": os.path.join(self.tmp, "status"),
                                           "OUTBOUND_FETCH_ALLOW_HOSTS": "127.0.0.1"})
        self.env.start()
        conn = sqlite3.connect(self.db_path)
        conn.execute("""CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                        password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)""")
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT)")
        conn.execute("""CREATE TABLE caldav_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
                        remote_collection TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                        PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection))""")
        conn.execute("""CREATE TABLE google_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
                        google_calendar_id TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                        PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection))""")
        conn.execute(TRASH_SQL)
        conn.commit()
        conn.close()
        self.local = MemCalDAV(f"/{USER_ID}/")
        self.remote = MemCalDAV("/dav/calendars/testuser/")
        self.status = {}

    def tearDown(self):
        self.local.stop()
        self.remote.stop()
        self.env.stop()
        shutil.rmtree(self.tmp)

    def simulate_vdirsyncer(self, cmd, *args, **kwargs):
        with open(cmd[2]) as f:
            config = parse_like_vdirsyncer(f.read())
        if cmd[3] != "sync":
            return MagicMock(returncode=0, stdout="", stderr="")
        for section, pair in config.items():
            if not section.startswith("pair "):
                continue
            for name, coll_a, coll_b in pair["collections"]:
                # The provider side (CalDAV url or Google) is the in-memory remote; b is the local mirror.
                a = self.remote.collections[coll_a]
                b = self.local.collections[coll_b]
                known = self.status.setdefault((section, name), set())
                for ident in set(a) | set(b) | set(known):
                    in_a, in_b = ident in a, ident in b
                    if ident in known and in_b and not in_a:
                        del b[ident]
                    elif ident in known and in_a and not in_b:
                        del a[ident]
                    elif in_a and not in_b:
                        b[ident] = a[ident]
                    elif in_b and not in_a:
                        a[ident] = b[ident]
                    if ident in a and ident in b:
                        known.add(ident)
                    else:
                        known.discard(ident)
        return MagicMock(returncode=0, stdout="", stderr="")

    def link_basic(self):
        self.remote.collections["work"] = {}
        self.remote.names["work"] = "Arbeit"
        enc, iv = sync_worker.encrypt("testpassword", sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute("INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
                     " VALUES ('acc-basic', ?, ?, 'testuser@example.com', ?, ?, 'basic')",
                     (USER_ID, self.remote.url, enc, iv))
        conn.commit()
        conn.close()
        return self.remote.collections["work"]

    def link_google(self):
        self.remote.collections["primary"] = {}
        enc, iv = sync_worker.encrypt("testuser-refresh-token", sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute("INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type,"
                     " access_token, expires_at) VALUES ('acc-google', ?, 'https://apidata.googleusercontent.com/caldav/v2/',"
                     " 'testuser@example.com', ?, ?, 'oauth2', ?, ?)",
                     (USER_ID, enc, iv, sync_worker.encrypt_token("testuser-access", sync_worker.KEY_BYTES),
                      int(time.time() * 1000) + 3600 * 1000))
        conn.commit()
        conn.close()
        return self.remote.collections["primary"]

    def run_sync(self):
        # A listing without a component set: the calendar takes every component.
        discovered = [{"id": "primary", "name": "Privat"}]
        with patch.object(sync_worker, "LOCAL_CALDAV_URL", self.local.base + "/"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker, "discover_google_collections", return_value=discovered), \
             patch("subprocess.run", side_effect=self.simulate_vdirsyncer):
            return sync_worker.sync_user(USER_ID)

    def restore(self, row):
        """What POST /api/trash/:id/restore does for an event or task: PUT the payload back."""
        coll, res = row["payload"]["href"].split("/")[2:4]
        self.local.collections[coll][res] = row["payload"]["ics"]

    def check_round_trip(self, remote):
        remote["evt597.ics"] = EVENT
        remote["task597.ics"] = TASK
        remote["kept597.ics"] = KEPT
        self.assertEqual(self.run_sync(), (True, ""))
        self.assertEqual(trash_rows(self.db_path), [], "nothing was deleted yet")

        # Deleted at the provider.
        del remote["evt597.ics"]
        del remote["task597.ics"]
        self.assertEqual(self.run_sync(), (True, ""))

        (mirror,) = [c for c, items in self.local.collections.items() if "kept597.ics" in items]
        self.assertEqual(set(self.local.collections[mirror]), {"kept597.ics"}, "the mirror dropped the deleted items")
        rows = trash_rows(self.db_path)
        self.assertEqual([(r["kind"], r["title"]) for r in rows],
                         [("event", "Planning with Test User"), ("task", "Write report")])
        for row, href, content in ((rows[0], "evt597.ics", EVENT), (rows[1], "task597.ics", TASK)):
            self.assertEqual(row["user_id"], USER_ID)
            self.assertEqual(row["calendar_id"], f"internal-caldav::/{USER_ID}/{mirror}/")
            self.assertEqual(row["payload"]["href"], f"/{USER_ID}/{mirror}/{href}")
            self.assertEqual(row["payload"]["ics"], content, "the last known version is kept")
            self.assertEqual(row["linked"], 1)
            self.assertEqual(row["origin"], "provider")
            self.assertNotIn("msgraph", row["payload"])

        # A further sync does not add them again.
        self.assertEqual(self.run_sync(), (True, ""))
        self.assertEqual(len(trash_rows(self.db_path)), 2)

        # Restored: the next sync writes them back to the provider.
        for row in rows:
            self.restore(row)
        self.assertEqual(self.run_sync(), (True, ""))
        self.assertEqual(remote.get("evt597.ics"), EVENT)
        self.assertEqual(remote.get("task597.ics"), TASK)

    def test_basic_caldav_pair_puts_a_provider_delete_into_the_trash_and_a_restore_reaches_the_provider(self):
        self.check_round_trip(self.link_basic())

    def test_google_pair_puts_a_provider_delete_into_the_trash_and_a_restore_reaches_the_provider(self):
        self.check_round_trip(self.link_google())

    def test_an_item_deleted_in_the_app_is_not_trashed_twice(self):
        remote = self.link_basic()
        remote["evt597.ics"] = EVENT
        self.assertEqual(self.run_sync(), (True, ""))
        (mirror,) = [c for c, items in self.local.collections.items() if "evt597.ics" in items]
        href = f"/{USER_ID}/{mirror}/evt597.ics"
        original = self.simulate_vdirsyncer

        def app_deletes_during_sync(cmd, *args, **kwargs):
            if cmd[3] == "sync":
                # The app's delete (#348) lands while vdirsyncer runs; vdirsyncer then deletes remotely.
                del self.local.collections[mirror]["evt597.ics"]
                conn = sqlite3.connect(self.db_path)
                conn.execute("INSERT INTO trash_items (id, user_id, kind, calendar_id, title, linked, payload, deleted_at)"
                             " VALUES ('app-1', ?, 'event', ?, 'Planning with Test User', 1, ?, ?)",
                             (USER_ID, f"internal-caldav::/{USER_ID}/{mirror}/",
                              json.dumps({"href": href, "ics": EVENT}), int(time.time() * 1000)))
                conn.commit()
                conn.close()
            return original(cmd, *args, **kwargs)

        self.simulate_vdirsyncer = app_deletes_during_sync
        self.assertEqual(self.run_sync(), (True, ""))
        self.assertEqual([r["id"] for r in trash_rows(self.db_path)], ["app-1"])


class _Response:
    def __init__(self, body):
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class MSGraphWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("""CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            account_email TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER,
            reconnect_required INTEGER NOT NULL DEFAULT 0, sync_lock_until INTEGER, created_at INTEGER, updated_at INTEGER)""")
        self.conn.execute("""CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT NOT NULL,
            account_id TEXT NOT NULL, last_synced_at INTEGER NOT NULL, e_tag TEXT, href TEXT, local_etag TEXT)""")
        self.conn.execute("""CREATE TABLE msgraph_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
            graph_calendar_id TEXT NOT NULL, local_collection TEXT NOT NULL, graph_name TEXT, graph_color TEXT,
            delta_link TEXT, delta_started_at INTEGER, created_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, graph_calendar_id))""")
        self.conn.execute(TRASH_SQL)
        self.conn.execute(RESTORES_SQL)
        self.conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at)"
            " VALUES ('acc1', ?, 'testuser@example.com', ?, ?, 4102444800000)",
            (USER_ID, msgraph_worker.encrypt_token("testuser-access"), msgraph_worker.encrypt_token("testuser-refresh")))
        # #613: the mirror of the account's Microsoft calendar cal1, mid delta round.
        self.conn.execute(
            "INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection,"
            " graph_name, graph_color, delta_link, delta_started_at, created_at)"
            " VALUES ('acc1', ?, 'cal1', 'msgraph-m1', 'Kalender', NULL, ?, ?, 0)",
            (USER_ID, f"{GRAPH}/me/calendars/cal1/calendarView/delta?$deltatoken=round1", int(time.time() * 1000)))
        self.conn.commit()
        self.local = MemCalDAV(f"/{USER_ID}/")
        self.local.collections["msgraph-m1"] = {}
        self.graph_pages = []
        self.graph_posts = []
        self.real_urlopen = urllib.request.urlopen

    def tearDown(self):
        self.local.stop()
        self.conn.close()
        shutil.rmtree(self.tmp)

    def fake_urlopen(self, req, context=None, timeout=None):
        url = req.full_url
        if url.startswith(f"{GRAPH}/me/calendars?"):
            return _Response(json.dumps({"value": [{"id": "cal1", "name": "Kalender", "hexColor": "", "canEdit": True}]}))
        if url.startswith(GRAPH + "/me/calendars/cal1/events"):
            self.graph_posts.append((req.get_method(), json.loads(req.data.decode("utf-8")), dict(req.header_items())))
            created = dict(json.loads(req.data.decode("utf-8")), id="g-new")
            return _Response(json.dumps(created))
        if url.startswith(GRAPH):
            page = self.graph_pages.pop(0) if self.graph_pages else {"value": []}
            return _Response(json.dumps(dict(page, **{"@odata.deltaLink": f"{GRAPH}/me/calendars/cal1/calendarView/delta?$deltatoken=n"})))
        return self.real_urlopen(req, timeout=timeout)

    def sync(self):
        with patch.object(msgraph_worker, "LOCAL_CALDAV_URL", self.local.base), \
             patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=self.fake_urlopen):
            return msgraph_worker.sync_msgraph_accounts(USER_ID, self.conn)

    def test_an_event_deleted_in_outlook_goes_to_the_trash_and_its_restore_is_created_at_graph(self):
        self.graph_pages.append({"value": [{
            "id": "g-old", "subject": "Planning with Test User", "body": {"content": "Agenda; room 2"},
            "location": {"displayName": "Room 2"},
            "start": {"dateTime": "2026-10-20T09:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-10-20T10:00:00.0000000", "timeZone": "UTC"}}]})
        self.assertEqual(self.sync(), (True, ""))
        imported = self.local.collections["msgraph-m1"]["msgraph-event-g-old.ics"]

        # Deleted in Outlook.
        self.graph_pages.append({"value": [{"id": "g-old", "@removed": {"reason": "deleted"}}]})
        self.assertEqual(self.sync(), (True, ""))

        self.assertEqual(self.local.collections["msgraph-m1"], {}, "the mirror dropped the event")
        (row,) = trash_rows(self.db_path)
        self.assertEqual((row["kind"], row["title"], row["linked"], row["origin"]),
                         ("event", "Planning with Test User", 1, "provider"))
        self.assertEqual(row["calendar_id"], f"internal-caldav::/{USER_ID}/msgraph-m1/")
        self.assertEqual(row["payload"], {"href": f"/{USER_ID}/msgraph-m1/msgraph-event-g-old.ics", "ics": imported,
                                          "msgraph": {"accountId": "acc1"}})

        # Restored: the trash route PUTs the payload back and queues the Graph restore.
        self.local.collections["msgraph-m1"]["msgraph-event-g-old.ics"] = row["payload"]["ics"]
        self.conn.execute("INSERT INTO msgraph_restores VALUES ('acc1', ?, 0)", (row["payload"]["href"],))
        self.conn.commit()
        self.assertEqual(self.sync(), (True, ""))

        (post,) = self.graph_posts
        self.assertEqual(post[0], "POST")
        self.assertEqual(post[1], {
            "subject": "Planning with Test User", "body": {"contentType": "text", "content": "Agenda; room 2"},
            "location": {"displayName": "Room 2"},
            "start": {"dateTime": "2026-10-20T09:00:00", "timeZone": "UTC"},
            "end": {"dateTime": "2026-10-20T10:00:00", "timeZone": "UTC"}, "isAllDay": False})
        self.assertEqual(post[2]["Authorization"], "Bearer testuser-access")
        # The local copy now carries Microsoft's new id; the old resource is gone.
        self.assertEqual(set(self.local.collections["msgraph-m1"]), {"msgraph-event-g-new.ics"})
        self.assertIn("SUMMARY:Planning with Test User", self.local.collections["msgraph-m1"]["msgraph-event-g-new.ics"])
        self.assertEqual(self.conn.execute("SELECT graph_id FROM msgraph_event_mappings").fetchall()[0][0], "g-new")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM msgraph_restores").fetchone()[0], 0)

        # Done once: the next sync creates nothing more.
        self.assertEqual(self.sync(), (True, ""))
        self.assertEqual(len(self.graph_posts), 1)

    def test_a_zoned_all_day_and_zoned_timed_restore_is_sent_in_utc(self):
        all_day = ics("VEVENT", "x1", "Holiday", "DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261225\r\n")
        zoned = ics("VEVENT", "x2", "Call", "DTSTART;TZID=Europe/Berlin:20260701T100000\r\n"
                    "DTEND;TZID=Europe/Berlin:20260701T110000\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\n"
                    "DESCRIPTION:Reminder\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\n")
        a = msgraph_worker.ics_to_graph_event(all_day)
        self.assertEqual((a["start"], a["end"], a["isAllDay"]),
                         ({"dateTime": "2026-12-24T00:00:00", "timeZone": "UTC"},
                          {"dateTime": "2026-12-25T00:00:00", "timeZone": "UTC"}, True))
        z = msgraph_worker.ics_to_graph_event(zoned)
        self.assertEqual((z["start"]["dateTime"], z["end"]["dateTime"], z["body"]["content"]),
                         ("2026-07-01T08:00:00", "2026-07-01T09:00:00", ""))

    def test_a_failed_graph_create_keeps_the_restore_queued_and_fails_the_job(self):
        self.local.collections["msgraph-m1"]["msgraph-event-g-old.ics"] = EVENT
        self.conn.execute("INSERT INTO msgraph_restores VALUES ('acc1', ?, 0)",
                          (f"/{USER_ID}/msgraph-m1/msgraph-event-g-old.ics",))
        self.conn.commit()

        def refuse(req, context=None, timeout=None):
            if req.full_url.startswith(GRAPH + "/me/calendars/cal1/events"):
                raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b"{}"))
            return self.fake_urlopen(req, context, timeout)

        with patch.object(msgraph_worker, "LOCAL_CALDAV_URL", self.local.base), \
             patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=refuse):
            ok, error = msgraph_worker.sync_msgraph_accounts(USER_ID, self.conn)

        self.assertFalse(ok)
        self.assertIn("re-creating a restored event failed", error)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM msgraph_restores").fetchone()[0], 1)
        self.assertIn("msgraph-event-g-old.ics", self.local.collections["msgraph-m1"])


if __name__ == "__main__":
    unittest.main()
