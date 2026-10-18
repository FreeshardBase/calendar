"""Issue #572 — one item Google refuses must not stop the Google sync, and none passes silently.

A task left in the local mirror of a Google calendar was handed to Google, which answered 403, and
the whole pair failed. Now the pair syncs only the components Google's calendars report
(vdirsyncer item_types), the worker names each item that cannot sync (title and reason), and it
sets every mirror's component set to the remote's on each run.

vdirsyncer is replaced by a fake that behaves like it: it lists the local items of the types the
local storage takes, uploads them to a fake Google that refuses VTODO (and anything in `refuse`)
with 403, logs as vdirsyncer does and goes on with the other items, exiting 1 if one failed.
"""
import configparser
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
CALDAV = "{urn:ietf:params:xml:ns:caldav}"
ALL = ("VEVENT", "VTODO", "VJOURNAL")


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


def ics(comp, uid, summary):
    return (f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:{comp}\r\nUID:{uid}\r\n"
            f"DTSTAMP:20261001T000000Z\r\nSUMMARY:{summary}\r\nEND:{comp}\r\nEND:VCALENDAR\r\n")


def multistatus(items):
    out = ['<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">']
    for comp, uid, summary in items:
        out.append(f"<d:response><d:href>/{USER_ID}/x/{uid}.ics</d:href><d:propstat><d:prop>"
                   f"<c:calendar-data>{ics(comp, uid, summary)}</c:calendar-data></d:prop>"
                   "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
    out.append("</d:multistatus>")
    return "".join(out).encode("utf-8")


PROPPATCH_OK = (b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href>'
                b'<d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')


class Issue572Base(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = os.path.join(self.temp_dir, "status")
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("""
            CREATE TABLE cross_user_deletions (
                id TEXT PRIMARY KEY, owner_user_id TEXT, uid TEXT, calendar_id TEXT, deleted_by TEXT,
                href TEXT, ics TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE google_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, google_calendar_id TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection)
            )
        """)
        enc, iv = sync_worker.encrypt("refresh-token", sync_worker.KEY_BYTES)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type,"
            " access_token, expires_at) VALUES ('acc-g0', ?, 'https://g0.example.com/', 'testuser@example.com',"
            " ?, ?, 'oauth2', ?, ?)",
            (USER_ID, enc, iv, sync_worker.encrypt_token("tok", sync_worker.KEY_BYTES),
             int(time.time() * 1000) + 3600 * 1000),
        )
        # The mirror exists already (created before #495, without a component set).
        conn.execute(
            "INSERT INTO google_calendar_collections VALUES ('acc-g0', ?, 'primary', 'google-mirror0', 0)",
            (USER_ID,))
        conn.commit()
        conn.close()
        # The local mirror's items, and what reached Google.
        self.local = [("VEVENT", "ev-1", "Termin A"), ("VEVENT", "ev-2", "Termin B"), ("VTODO", "todo-1", "test1")]
        self.remote = []
        self.refuse = set()
        self.requests = []
        self.discovered = [{"id": "primary", "name": "Privat", "components": ("VEVENT",)}]

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def fake_vdirsyncer(self, cmd, *args, **kwargs):
        if cmd[3] != "sync":
            return MagicMock(returncode=0, stdout="", stderr="")
        with open(cmd[2]) as f:
            self.config = parse_like_vdirsyncer(f.read())
        local_types = self.config["storage local_0"].get("item_types") or list(ALL)
        log, failed = ["Syncing sync_0/google-mirror0"], False
        for comp, uid, _ in self.local:
            if comp not in local_types:
                continue
            log.append(f"Copying (uploading) item {uid} to google_0/primary")
            if comp == "VTODO" or uid in self.refuse:
                failed = True
                log.append("error: Unknown error occurred: 403, message='Forbidden', url='https://apidata."
                           f"googleusercontent.com/caldav/v2/testuser%40example.com/events/{uid}.ics'")
                continue
            self.remote.append(uid)
        if failed:
            log.append("error: Use `-vdebug` to see the full traceback.")
        return MagicMock(returncode=1 if failed else 0, stdout="", stderr="\n".join(log) + "\n")

    def fake_urlopen(self, req, *args, **kwargs):
        self.requests.append(req)
        body = req.data.decode("utf-8")
        if req.get_method() == "PROPPATCH":
            res = MagicMock(status=207)
            res.read.return_value = PROPPATCH_OK
        elif req.get_method() == "REPORT":
            comp = ET.fromstring(body).find(f".//{CALDAV}comp-filter/{CALDAV}comp-filter")
            wanted = comp.get("name") if comp is not None else None
            res = MagicMock(status=207)
            res.read.return_value = multistatus([i for i in self.local if wanted in (None, i[0])])
        else:
            res = MagicMock(status=201)
        res.__enter__ = lambda s: s
        res.__exit__ = lambda s, *a: False
        return res

    def run_sync(self):
        with patch.object(sync_worker, "discover_google_collections", return_value=self.discovered), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker.urllib.request, "urlopen", side_effect=self.fake_urlopen), \
             patch("subprocess.run", side_effect=self.fake_vdirsyncer):
            return sync_worker.sync_user(USER_ID)


class TestGooglePairSyncsWhatGoogleTakes(Issue572Base):
    def test_storages_get_item_types_from_the_remote_component_set(self):
        self.run_sync()
        self.assertEqual(self.config["storage google_0"]["item_types"], ["VEVENT"])
        self.assertEqual(self.config["storage local_0"]["item_types"], ["VEVENT"])

    def test_a_task_in_the_mirror_does_not_stop_the_events_and_is_named(self):
        ok, err = self.run_sync()
        self.assertEqual(sorted(self.remote), ["ev-1", "ev-2"])
        self.assertFalse(ok)
        self.assertIn("„test1“", err)
        self.assertIn("Google nimmt keine Aufgaben an, bitte in eine Aufgabenliste verschieben", err)
        self.assertNotIn("Termin A", err)

    def test_an_event_google_refuses_is_named_and_the_others_sync(self):
        self.refuse = {"ev-2"}
        ok, err = self.run_sync()
        self.assertEqual(self.remote, ["ev-1"])
        self.assertFalse(ok)
        self.assertIn("„Termin B“", err)
        self.assertIn("403 Forbidden", err)
        self.assertIn("„test1“", err)
        self.assertNotIn("Termin A", err)

    def test_a_clean_mirror_syncs_successfully(self):
        self.local = [("VEVENT", "ev-1", "Termin A")]
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        self.assertEqual(self.remote, ["ev-1"])


class TestMirrorComponentSetIsEnforced(Issue572Base):
    def test_every_run_sets_the_mirror_component_set_to_the_remote_one(self):
        for _ in range(2):
            self.requests = []
            self.run_sync()
            patches = [r for r in self.requests if r.get_method() == "PROPPATCH"]
            self.assertEqual(len(patches), 1)
            self.assertTrue(patches[0].full_url.endswith(f"/{USER_ID}/google-mirror0/"), patches[0].full_url)
            self.assertEqual(patches[0].headers.get("Accept-encoding"), "identity")
            comp_set = ET.fromstring(patches[0].data.decode("utf-8")).find(
                f".//{{DAV:}}set/{{DAV:}}prop/{CALDAV}supported-calendar-component-set")
            self.assertEqual([c.get("name") for c in comp_set.findall(f"{CALDAV}comp")], ["VEVENT"])

    def test_a_refused_proppatch_fails_the_run(self):
        def refusing(req, *args, **kwargs):
            res = self.fake_urlopen(req)
            if req.get_method() == "PROPPATCH":
                res.read.return_value = PROPPATCH_OK.replace(b"200 OK", b"403 Forbidden")
            return res
        with patch.object(sync_worker, "discover_google_collections", return_value=self.discovered), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker.urllib.request, "urlopen", side_effect=refusing), \
             patch("subprocess.run", side_effect=self.fake_vdirsyncer):
            ok, err = sync_worker.sync_user(USER_ID)
        self.assertFalse(ok)
        self.assertIn("google-mirror0", err)


class TestGoogleDiscoveryReadsTheComponentSet(unittest.TestCase):
    LISTING = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/caldav/v2/testuser%40example.com/events/</d:href><d:propstat><d:prop>
    <d:displayname>Privat</d:displayname>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/caldav/v2/other%40example.com/events/</d:href><d:propstat><d:prop>
    <d:displayname>Alles</d:displayname>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"""

    def test_each_collection_carries_the_components_the_server_names(self):
        sent = []

        class Opener:
            def open(opener_self, req, *a, **k):
                sent.append(req)
                res = MagicMock()
                res.read.return_value = self.LISTING.encode("utf-8")
                res.__enter__ = lambda s: s
                res.__exit__ = lambda s, *a: False
                return res

        with patch.object(sync_worker, "assert_public_url", return_value=[]), \
             patch.object(sync_worker, "pinned_opener", return_value=Opener()):
            cols = sync_worker.discover_google_collections("https://apidata.example.com/caldav/v2/", "tok")
        self.assertEqual({c["id"]: c["components"] for c in cols},
                         {"testuser@example.com": ("VEVENT",), "other@example.com": ALL})
        self.assertIn(f"{CALDAV}supported-calendar-component-set",
                      [el.tag for el in ET.fromstring(sent[0].data.decode("utf-8")).iter()])


if __name__ == "__main__":
    unittest.main()
