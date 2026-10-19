"""Issue #613 — every Microsoft calendar of a linked account has its own mirror collection.

Microsoft Graph and the local Radicale are replaced by in-process fakes (urlopen is routed to them)
that keep state, so a sync's writes are seen by the next one:
  - two Microsoft calendars become two opaque, VEVENT-only mirrors with the provider's name and
    colour, persisted per account and calendar id; nothing goes into "persoenlich";
  - each calendar's events land in its own mirror;
  - what is created, edited or deleted in a mirror is written back to that Microsoft calendar, and
    the following sync is quiet.
"""
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest.mock import patch
from xml.sax.saxutils import escape

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import msgraph_worker  # noqa: E402

GRAPH = "https://graph.microsoft.com/v1.0"
LOCAL = msgraph_worker.LOCAL_CALDAV_URL.rstrip("/")
USER = "testuser"


class _Response:
    def __init__(self, body="", status=200, headers=None):
        self._body = body.encode("utf-8")
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _http_error(url, code):
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(b"{}"))


def graph_event(graph_id, subject, day="05"):
    return {"id": graph_id, "subject": subject, "@odata.etag": f"W/\"{graph_id}\"",
            "start": {"dateTime": f"2026-10-{day}T12:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": f"2026-10-{day}T13:00:00.0000000", "timeZone": "UTC"}}


class FakeGraph:
    """Calendars with events and a change log per calendar, so delta links report what changed since."""

    def __init__(self, calendars):
        # {calendar id: {"name", "hexColor", "events": {id: event}, "log": [event id]}}
        self.calendars = {cid: {**meta, "events": {e["id"]: e for e in events}, "log": [e["id"] for e in events],
                                "removed": set()}
                          for cid, (meta, events) in calendars.items()}
        self.writes = []
        self.next_id = 0

    def handle(self, method, url, body):
        parts = urllib.parse.urlsplit(url)
        path = parts.path[len("/v1.0"):]
        query = urllib.parse.parse_qs(parts.query)
        if method == "GET" and path == "/me/calendars":
            return {"value": [{"id": cid, "name": c["name"], "hexColor": c["hexColor"], "canEdit": True}
                              for cid, c in self.calendars.items()]}
        m = re.fullmatch(r"/me/calendars/([^/]+)/calendarView/delta", path)
        if method == "GET" and m:
            cal = self.calendars[urllib.parse.unquote(m.group(1))]
            since = int(query["$deltatoken"][0]) if "$deltatoken" in query else 0
            changed = list(dict.fromkeys(cal["log"][since:]))
            value = [{"id": gid, "@removed": {"reason": "deleted"}} if gid in cal["removed"] else cal["events"][gid]
                     for gid in changed]
            return {"value": value,
                    "@odata.deltaLink": f"{GRAPH}/me/calendars/{m.group(1)}/calendarView/delta?$deltatoken={len(cal['log'])}"}
        m = re.fullmatch(r"/me/calendars/([^/]+)/events", path)
        if method == "POST" and m:
            cid = urllib.parse.unquote(m.group(1))
            self.next_id += 1
            created = {**body, "id": f"created{self.next_id}", "@odata.etag": f"W/\"created{self.next_id}\""}
            self.calendars[cid]["events"][created["id"]] = created
            self.calendars[cid]["log"].append(created["id"])
            self.writes.append(("POST", cid, body["subject"]))
            return created
        m = re.fullmatch(r"/me/events/([^/]+)", path)
        if m and method in ("PATCH", "DELETE"):
            gid = urllib.parse.unquote(m.group(1))
            cid = next(cid for cid, c in self.calendars.items() if gid in c["events"])
            cal = self.calendars[cid]
            if method == "PATCH":
                cal["events"][gid] = {**cal["events"][gid], **body}
                self.writes.append(("PATCH", cid, body["subject"]))
                cal["log"].append(gid)
                return cal["events"][gid]
            cal["removed"].add(gid)
            cal["log"].append(gid)
            self.writes.append(("DELETE", cid, cal["events"][gid]["subject"]))
            return None
        raise AssertionError(f"unexpected Graph request {method} {url}")

    def change(self, cid, event):
        self.calendars[cid]["events"][event["id"]] = event
        self.calendars[cid]["log"].append(event["id"])


class FakeRadicale:
    """Collections with properties and items; ETags change on every PUT."""

    def __init__(self):
        self.collections = {}  # name -> {"props": {...}, "items": {resource: (etag, ics)}}
        self.version = 0
        self.requests = []

    def handle(self, req):
        method = req.get_method()
        path = urllib.parse.unquote(urllib.parse.urlsplit(req.full_url).path)
        body = req.data.decode("utf-8") if req.data else ""
        assert req.get_header("Authorization"), "every local request authenticates"
        self.requests.append((method, path))
        segments = path.strip("/").split("/")
        assert segments[0] == USER, path
        collection = segments[1]
        if method == "MKCALENDAR":
            props = {"displayname": re.search(r"<d:displayname>(.*?)</d:displayname>", body).group(1),
                     "components": re.findall(r'<c:comp name="(\w+)"/>', body),
                     "color": (re.search(r"<ical:calendar-color>(.*?)</ical:calendar-color>", body) or [None, None])[1]}
            self.collections[collection] = {"props": props, "items": {}}
            return _Response(status=201)
        col = self.collections.get(collection)
        if col is None:
            raise _http_error(req.full_url, 404 if method in ("GET", "DELETE") else 409)
        if method == "PROPPATCH":
            name = re.search(r"<d:displayname>(.*?)</d:displayname>", body)
            color = re.search(r"<ical:calendar-color>(.*?)</ical:calendar-color>", body)
            col["props"]["displayname"] = name.group(1)
            col["props"]["color"] = color.group(1) if color else None
            return _Response('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat>'
                             '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>', 207)
        if method == "REPORT":
            responses = "".join(
                f"<d:response><d:href>{urllib.parse.quote(f'/{USER}/{collection}/{res}')}</d:href><d:propstat><d:prop>"
                f"<d:getetag>{escape(etag)}</d:getetag><c:calendar-data>{escape(ics)}</c:calendar-data>"
                "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                for res, (etag, ics) in col["items"].items())
            return _Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                             f"{responses}</d:multistatus>", 207)
        resource = segments[2]
        if method == "PUT":
            self.version += 1
            etag = f'"v{self.version}"'
            col["items"][resource] = (etag, body)
            return _Response(status=201, headers={"ETag": etag})
        if method == "GET":
            if resource not in col["items"]:
                raise _http_error(req.full_url, 404)
            return _Response(col["items"][resource][1])
        if method == "DELETE":
            if col["items"].pop(resource, None) is None:
                raise _http_error(req.full_url, 404)
            return _Response(status=204)
        raise AssertionError(f"unexpected local request {method} {path}")

    def local_put(self, collection, resource, ics):
        """A change made in the shard (app or native client)."""
        self.version += 1
        self.collections[collection]["items"][resource] = (f'"v{self.version}"', ics)

    def summaries(self, collection):
        return sorted(re.search(r"^SUMMARY:(.*?)\r?$", ics, re.M).group(1)
                      for _, ics in self.collections[collection]["items"].values())


def local_event(uid, summary, rrule=None):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\n"
            f"UID:{uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:{summary}\r\n"
            "DTSTART:20261007T090000Z\r\nDTEND:20261007T100000Z\r\n"
            + (f"RRULE:{rrule}\r\n" if rrule else "") +
            "END:VEVENT\r\nEND:VCALENDAR\r\n")


class MSGraphCalendarMirrorsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.conn = sqlite3.connect(os.path.join(self.tmp, "webcalendar.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_email TEXT NOT NULL,
              access_token TEXT, refresh_token TEXT, expires_at INTEGER, reconnect_required INTEGER NOT NULL DEFAULT 0,
              sync_lock_until INTEGER, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT NOT NULL,
              account_id TEXT NOT NULL, last_synced_at INTEGER NOT NULL, e_tag TEXT, href TEXT, local_etag TEXT);
            CREATE TABLE msgraph_restores (account_id TEXT NOT NULL, href TEXT NOT NULL, created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, href));
            CREATE TABLE msgraph_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
              graph_calendar_id TEXT NOT NULL, local_collection TEXT NOT NULL, graph_name TEXT, graph_color TEXT,
              delta_link TEXT, delta_started_at INTEGER, created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, graph_calendar_id), UNIQUE (user_id, local_collection));
            CREATE TABLE trash_items (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, calendar_id TEXT, title TEXT,
              linked INTEGER, origin TEXT, payload TEXT, deleted_at INTEGER);
        """)
        self.conn.execute(
            "INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at)"
            " VALUES ('acc1', ?, 'testuser@example.com', ?, ?, 4102444800000)",
            (USER, msgraph_worker.encrypt_token("testuser-access-token"),
             msgraph_worker.encrypt_token("testuser-refresh-token")))
        self.conn.commit()
        self.graph = FakeGraph({
            "AAMkWork=": ({"name": "Arbeit", "hexColor": "#a1b2c3"},
                          [graph_event("w1", "Planung"), graph_event("w2", "Review", day="06")]),
            "AAMkFamily=": ({"name": "Familie", "hexColor": ""}, [graph_event("f1", "Geburtstag")]),
        })
        self.radicale = FakeRadicale()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp)

    def _route(self, req, context=None, timeout=None):
        assert timeout, "every request carries a timeout"
        url = req.full_url
        if url.startswith(GRAPH):
            assert req.get_header("Authorization") == "Bearer testuser-access-token"
            body = json.loads(req.data.decode("utf-8")) if req.data else None
            answer = self.graph.handle(req.get_method(), url, body)
            return _Response("", 204) if answer is None else _Response(json.dumps(answer))
        assert url.startswith(LOCAL), url
        return self.radicale.handle(req)

    def _sync(self):
        with patch.object(msgraph_worker.urllib.request, "urlopen", side_effect=self._route):
            return msgraph_worker.sync_msgraph_accounts(USER, self.conn)

    def _mirror(self, graph_calendar_id):
        row = self.conn.execute("SELECT local_collection FROM msgraph_calendar_collections"
                                " WHERE account_id = 'acc1' AND graph_calendar_id = ?", (graph_calendar_id,)).fetchone()
        self.assertIsNotNone(row, f"no mirror persisted for {graph_calendar_id}")
        return row["local_collection"]

    def test_two_calendars_get_two_mirrors_and_their_events_land_in_the_right_one(self):
        self.assertEqual(self._sync(), (True, ""))

        work, family = self._mirror("AAMkWork="), self._mirror("AAMkFamily=")
        self.assertNotEqual(work, family)
        for name in (work, family):
            self.assertRegex(name, r"^msgraph-[0-9a-f]{32}$")
        self.assertEqual(sorted(self.radicale.collections), sorted([work, family]))
        self.assertEqual(self.radicale.collections[work]["props"],
                         {"displayname": "Arbeit", "components": ["VEVENT"], "color": "#a1b2c3"})
        self.assertEqual(self.radicale.collections[family]["props"],
                         {"displayname": "Familie", "components": ["VEVENT"], "color": None})
        self.assertEqual(self.radicale.summaries(work), ["Planung", "Review"])
        self.assertEqual(self.radicale.summaries(family), ["Geburtstag"])
        self.assertFalse([p for _, p in self.radicale.requests if "/persoenlich/" in p])
        # Reading Microsoft wrote nothing back.
        self.assertEqual(self.graph.writes, [])

        # The next sync keeps the pairing and only applies what changed at Microsoft.
        self.graph.change("AAMkFamily=", graph_event("f2", "Elternabend", day="09"))
        self.graph.change("AAMkWork=", {**graph_event("w1", "Planung (verschoben)")})
        self.assertEqual(self._sync(), (True, ""))
        self.assertEqual((self._mirror("AAMkWork="), self._mirror("AAMkFamily=")), (work, family))
        self.assertEqual([m for m, _ in self.radicale.requests].count("MKCALENDAR"), 2)
        self.assertEqual(self.radicale.summaries(work), ["Planung (verschoben)", "Review"])
        self.assertEqual(self.radicale.summaries(family), ["Elternabend", "Geburtstag"])

    def test_a_calendar_renamed_or_recoloured_at_microsoft_is_relabelled(self):
        self._sync()
        work = self._mirror("AAMkWork=")
        self.graph.calendars["AAMkWork="].update(name="Büro", hexColor="#00ff00")
        self.assertEqual(self._sync(), (True, ""))
        self.assertEqual(self.radicale.collections[work]["props"]["displayname"], "Büro")
        self.assertEqual(self.radicale.collections[work]["props"]["color"], "#00ff00")

    def test_changes_in_a_mirror_are_written_to_its_microsoft_calendar(self):
        self._sync()
        work, family = self._mirror("AAMkWork="), self._mirror("AAMkFamily=")
        items = self.radicale.collections[work]["items"]

        # Created, edited and deleted in the shard.
        self.radicale.local_put(family, "local-1.ics", local_event("local-1", "Zahnarzt"))
        edited = items["msgraph-event-w1.ics"][1].replace("SUMMARY:Planung", "SUMMARY:Planung neu")
        self.radicale.local_put(work, "msgraph-event-w1.ics", edited)
        del items["msgraph-event-w2.ics"]

        self.assertEqual(self._sync(), (True, ""))
        self.assertEqual(sorted(self.graph.writes), sorted([
            ("POST", "AAMkFamily=", "Zahnarzt"),
            ("PATCH", "AAMkWork=", "Planung neu"),
            ("DELETE", "AAMkWork=", "Review"),
        ]))
        self.assertEqual(self.graph.calendars["AAMkWork="]["events"]["w1"]["subject"], "Planung neu")
        # The event created in the shard is not mirrored a second time when Microsoft reports it back.
        self.assertEqual(self.radicale.summaries(family), ["Geburtstag", "Zahnarzt"])
        self.assertEqual(sorted(self.radicale.collections[family]["items"]), ["local-1.ics", "msgraph-event-f1.ics"])
        self.assertIn("UID:local-1", self.radicale.collections[family]["items"]["local-1.ics"][1])
        self.assertEqual(self.radicale.summaries(work), ["Planung neu"])

        # What came back from Microsoft is not written to it again.
        self.graph.writes.clear()
        self.assertEqual(self._sync(), (True, ""))
        self.assertEqual(self.graph.writes, [])

    def test_a_series_created_in_the_shard_is_named_not_flattened_into_one_event(self):
        self._sync()
        work = self._mirror("AAMkWork=")
        self.radicale.local_put(work, "weekly.ics", local_event("weekly", "Jour fixe", rrule="FREQ=WEEKLY"))
        ok, error = self._sync()
        self.assertFalse(ok)
        self.assertIn("'Jour fixe'", error)
        self.assertEqual(self.graph.writes, [])
        self.assertIn("weekly.ics", self.radicale.collections[work]["items"])

    def test_a_resource_name_the_sync_cannot_map_is_named_and_does_not_stop_the_account(self):
        # A native client (or a member with a write share) may PUT any resource name into a mirror.
        self._sync()
        work = self._mirror("AAMkWork=")
        self.radicale.local_put(work, "a@b c.ics", local_event("odd-name", "Kundentermin"))
        ok, error = self._sync()
        self.assertFalse(ok)
        self.assertIn("'Kundentermin'", error)
        self.assertEqual(self.graph.writes, [])
        self.assertIn("a@b c.ics", self.radicale.collections[work]["items"])

        # Later syncs of the account keep working.
        self.graph.change("AAMkWork=", graph_event("w3", "Retro", day="08"))
        self._sync()
        self.assertIn("Retro", self.radicale.summaries(work))
        self.assertEqual(self.graph.writes, [])


if __name__ == "__main__":
    unittest.main()
