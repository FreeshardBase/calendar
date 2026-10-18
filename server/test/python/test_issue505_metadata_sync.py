"""Issue #505 — calendar colour and name are synced with linked accounts, both ways.

Drives the real sync_user() against stub CalDAV servers on 127.0.0.1: the local Radicale, a linked
Basic-auth CalDAV provider and a Google CalDAV stand-in. vdirsyncer itself is replaced by
simulate_vdirsyncer(), which applies what vdirsyncer 0.19.3 does with the generated config:
  - `metasync` handles every pair that declares `metadata`; for each key it reads the property on
    both sides (`color` = apple:calendar-color, `displayname` = DAV:displayname) and compares them
    with the value stored at the last metasync in <status_path>/<pair>/<collection>.metadata;
  - a side that changed since then is copied to the other side (PROPPATCH); if both changed to
    different values the pair's `conflict_resolution` decides ("a wins" / "b wins");
  - a pair without `metadata`, or a run without the `metasync` command, touches no property.
"""
import configparser
import http.server
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "testuser"
GOOGLE_CAL_ID = "testuser@example.com"
PROPS = {"color": ("http://apple.com/ns/ical/", "calendar-color"), "displayname": ("DAV:", "displayname")}


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


class StubCalDAV:
    """CalDAV server holding calendar collections under one home, each with displayname and colour."""

    def __init__(self, home):
        self.home = home
        self.collections = {}  # collection path -> {"displayname": str, "color": str}
        self.proppatches = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(length).decode("utf-8") if length else ""

            def _reply(self, status, body=b""):
                self.send_response(status)
                self.send_header("Content-Type", "application/xml; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_PROPFIND(self):
                self._body()
                if self.path.rstrip("/") != stub.home.rstrip("/"):
                    self._reply(404)
                    return
                parts = []
                for path, props in stub.collections.items():
                    parts.append(
                        f"<d:response><d:href>{path}</d:href><d:propstat><d:prop>"
                        "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
                        f"<d:displayname>{props['displayname']}</d:displayname></d:prop>"
                        "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
                self._reply(207, ('<?xml version="1.0" encoding="utf-8"?>'
                                  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                                  + "".join(parts) + "</d:multistatus>").encode("utf-8"))

            def do_MKCALENDAR(self):
                body = self._body()
                m = re.search(r"<d:displayname>([^<]*)</d:displayname>", body)
                stub.collections[self.path] = {"displayname": m.group(1) if m else "", "color": ""}
                self._reply(201)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def url(self):
        return self.base + self.home

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class TestIssue505MetadataSync(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        self.status_root = os.path.join(self.temp_dir, "status")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = self.status_root
        # The stub providers on 127.0.0.1 count as public through the operator allow-list (#532).
        os.environ["OUTBOUND_FETCH_ALLOW_HOSTS"] = "127.0.0.1"
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT)")
        conn.execute("""
            CREATE TABLE caldav_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, remote_collection TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection)
            )
        """)
        conn.execute("""
            CREATE TABLE google_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, google_calendar_id TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection)
            )
        """)
        conn.commit()
        conn.close()
        self.local = StubCalDAV(f"/{USER_ID}/")
        self.remote = StubCalDAV("/dav/calendars/testuser/")
        self.google = StubCalDAV("/caldav/v2/")
        self.servers = [self.local, self.remote, self.google]
        self.commands = []

    def tearDown(self):
        for s in self.servers:
            s.stop()
        shutil.rmtree(self.temp_dir)
        for key in ("DATABASE_PATH", "STATUS_ROOT", "OUTBOUND_FETCH_ALLOW_HOSTS"):
            os.environ.pop(key, None)

    # --- fixtures -------------------------------------------------------------------------------

    def add_basic_account(self, color="#0000ff"):
        self.remote.collections[self.remote.home + "work/"] = {"displayname": "Arbeit", "color": color}
        enc, iv = sync_worker.encrypt("testpassword", sync_worker.KEY_BYTES)
        self._insert("acc-basic", self.remote.url, enc, iv, "basic", None, None)

    def add_google_account(self, color="#00ff00"):
        self.google.collections[f"/caldav/v2/{urllib.parse.quote(GOOGLE_CAL_ID)}/events/"] = {
            "displayname": "Privat", "color": color}
        enc, iv = sync_worker.encrypt("testrefreshtoken", sync_worker.KEY_BYTES)
        self._insert("acc-google", self.google.url, enc, iv, "oauth2",
                     sync_worker.encrypt_token("testaccesstoken", sync_worker.KEY_BYTES),
                     int(time.time() * 1000) + 3600 * 1000)

    def _insert(self, acc_id, url, enc, iv, auth_type, access_token, expires_at):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type,"
            " access_token, expires_at) VALUES (?, ?, ?, 'testuser@example.com', ?, ?, ?, ?, ?)",
            (acc_id, USER_ID, url, enc, iv, auth_type, access_token, expires_at))
        conn.commit()
        conn.close()

    def local_props(self, table):
        conn = sqlite3.connect(self.db_path)
        (name,) = conn.execute(f"SELECT local_collection FROM {table}").fetchone()
        conn.close()
        return self.local.collections[f"/{USER_ID}/{name}/"]

    # --- vdirsyncer 0.19.3 stand-in ---------------------------------------------------------------

    def collection_props(self, storage, coll):
        if storage["type"] == "google_calendar":
            return self.google.collections[f"/caldav/v2/{urllib.parse.quote(coll)}/events/"]
        for s in self.servers:
            if storage["url"].rstrip("/") == s.url.rstrip("/"):
                return s.collections[s.home + coll + "/"]
        raise AssertionError(f"no stub server for {storage['url']}")

    def simulate_vdirsyncer(self, cmd, *args, **kwargs):
        command = cmd[3]
        with open(cmd[2]) as f:
            config = parse_like_vdirsyncer(f.read())
        self.commands.append(command)
        if command != "metasync":
            return MagicMock(returncode=0, stdout="", stderr="")
        status_path = config["general"]["status_path"]
        for section, pair in config.items():
            if not section.startswith("pair ") or "metadata" not in pair:
                continue
            pair_name = section[len("pair "):]
            storage_a = config[f"storage {pair['a']}"]
            storage_b = config[f"storage {pair['b']}"]
            for name, coll_a, coll_b in pair["collections"]:
                a = self.collection_props(storage_a, coll_a)
                b = self.collection_props(storage_b, coll_b)
                status_file = os.path.join(status_path, pair_name, name + ".metadata")
                status = {}
                if os.path.exists(status_file):
                    with open(status_file) as f:
                        status = json.load(f)
                for key in pair["metadata"]:
                    self.assertIn(key, PROPS)
                    va, vb, s = a[key], b[key], status.get(key, "")
                    if va != s and vb != s and va != vb:
                        winner = {"a wins": va, "b wins": vb}[pair["conflict_resolution"]]
                    elif va != s:
                        winner = va
                    else:
                        winner = vb
                    for side, props in (("a", a), ("b", b)):
                        if props[key] != winner:
                            props[key] = winner
                            self.proppatches.append((side, key, winner))
                    status[key] = winner
                os.makedirs(os.path.dirname(status_file), exist_ok=True)
                with open(status_file, "w") as f:
                    json.dump(status, f)
        return MagicMock(returncode=0, stdout="", stderr="")

    def run_sync(self):
        self.proppatches = []
        with patch.object(sync_worker, "LOCAL_CALDAV_URL", self.local.base + "/"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch("subprocess.run", side_effect=self.simulate_vdirsyncer):
            ok, err = sync_worker.sync_user(USER_ID)
        self.assertTrue(ok, err)

    # --- behaviour ------------------------------------------------------------------------------

    def test_basic_caldav_colour_set_in_the_shard_reaches_the_provider(self):
        self.add_basic_account(color="#0000ff")
        self.run_sync()
        local = self.local_props("caldav_calendar_collections")
        self.assertEqual(local["color"], "#0000ff", "first sync takes the provider's colour")
        self.assertIn("metasync", self.commands)

        # The web app PROPPATCHes calendar-color into the Radicale collection (PATCH /api/calendars/:id).
        local["color"] = "#ab12cd"
        self.run_sync()
        self.assertEqual(self.remote.collections[self.remote.home + "work/"]["color"], "#ab12cd")

    def test_basic_caldav_colour_and_name_changed_at_the_provider_reach_the_shard(self):
        self.add_basic_account(color="#0000ff")
        self.run_sync()
        remote = self.remote.collections[self.remote.home + "work/"]
        remote["color"] = "#00aa00"
        remote["displayname"] = "Büro"
        self.run_sync()
        local = self.local_props("caldav_calendar_collections")
        self.assertEqual((local["color"], local["displayname"]), ("#00aa00", "Büro"))
        self.assertEqual(remote["color"], "#00aa00")

    def test_basic_caldav_name_set_in_the_shard_reaches_the_provider(self):
        self.add_basic_account()
        self.run_sync()
        self.local_props("caldav_calendar_collections")["displayname"] = "Projekte"
        self.run_sync()
        self.assertEqual(self.remote.collections[self.remote.home + "work/"]["displayname"], "Projekte")

    def test_google_colour_round_trip(self):
        self.add_google_account(color="#00ff00")
        with patch.object(sync_worker, "discover_google_collections",
                          return_value=[{"id": GOOGLE_CAL_ID, "name": "Privat"}]):
            self.run_sync()
            local = self.local_props("google_calendar_collections")
            self.assertEqual(local["color"], "#00ff00")
            self.assertIn("metasync", self.commands)

            local["color"] = "#ab12cd"
            self.run_sync()
            google = self.google.collections[f"/caldav/v2/{urllib.parse.quote(GOOGLE_CAL_ID)}/events/"]
            self.assertEqual(google["color"], "#ab12cd")

            google["displayname"] = "Familie"
            self.run_sync()
            self.assertEqual(local["displayname"], "Familie")

    def test_only_the_changed_side_wins_an_unchanged_side_never_overwrites_it(self):
        # Three-way merge against the last synced value: the newer change propagates in both
        # directions; neither side wins merely by being the shard.
        self.add_basic_account(color="#0000ff")
        self.run_sync()
        remote = self.remote.collections[self.remote.home + "work/"]
        local = self.local_props("caldav_calendar_collections")
        remote["color"] = "#111111"
        self.run_sync()
        self.assertEqual(local["color"], "#111111")
        local["color"] = "#222222"
        self.run_sync()
        self.assertEqual(remote["color"], "#222222")


if __name__ == "__main__":
    unittest.main()
