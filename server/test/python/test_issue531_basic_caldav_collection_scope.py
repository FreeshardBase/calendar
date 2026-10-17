"""Issue #531 — the Basic-auth CalDAV pair must mirror only the provider's calendars, under names the
worker chose, and never let the provider name a status path.

Drives the real sync_user() against two mock CalDAV servers on 127.0.0.1 (the linked provider and
the local Radicale). vdirsyncer itself is replaced by simulate_vdirsyncer(), which applies what
vdirsyncer 0.19.3 does with the generated config:
  - "from a" / "from b" expand to every collection of that side, named by the unquoted last href
    segment; an explicit [name, a, b] triple is taken as is;
  - `discover` creates a collection missing on a side (MKCOL) only when stdin confirms the prompt
    with "y", and fails otherwise;
  - `sync` writes <status_path>/<pair>/<name>.items, joined and normpath'ed.
"""
import configparser
import http.server
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "testuser"
HOSTILE = "%2e%2e%2f%2e%2e%2fother%2fx"


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


class MockCalDAV:
    """A CalDAV server with one calendar home; records every request method and path."""

    def __init__(self, home):
        self.home = home
        self.collections = {}  # raw href segment -> displayname
        self.plain = set()  # listed collections that are not calendars (scheduling inbox, ...)
        self.requests = []
        mock = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(length) if length else b""

            def do_PROPFIND(self):
                self._body()
                mock.requests.append(("PROPFIND", self.path, self.headers.get("Accept-Encoding")))
                if self.path.rstrip("/") != mock.home.rstrip("/"):
                    self.send_response(404)
                    self.end_headers()
                    return
                parts = [f"<d:response><d:href>{mock.home}</d:href><d:propstat><d:prop>"
                         "<d:resourcetype><d:collection/></d:resourcetype></d:prop>"
                         "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"]
                for seg in mock.plain:
                    parts.append(
                        f"<d:response><d:href>{mock.home}{seg}/</d:href><d:propstat><d:prop>"
                        "<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype></d:prop>"
                        "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
                for seg, name in mock.collections.items():
                    parts.append(
                        f"<d:response><d:href>{mock.home}{seg}/</d:href><d:propstat><d:prop>"
                        "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
                        f"<d:displayname>{name}</d:displayname></d:prop>"
                        "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
                body = ('<?xml version="1.0" encoding="utf-8"?>'
                        '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                        + "".join(parts) + "</d:multistatus>").encode("utf-8")
                self.send_response(207)
                self.send_header("Content-Type", "application/xml; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _create(self):
                self._body()
                mock.requests.append((self.command, self.path, self.headers.get("Accept-Encoding")))
                seg = self.path.rstrip("/").split("/")[-1]
                mock.collections[seg] = seg
                self.send_response(201)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_MKCOL = _create
            do_MKCALENDAR = _create

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def url(self):
        return self.base + self.home

    def names(self):
        return [urllib.parse.unquote(seg) for seg in self.collections]

    def creations(self):
        return [(m, p) for m, p, _ in self.requests if m in ("MKCOL", "MKCALENDAR")]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class TestIssue531BasicCaldavCollectionScope(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "webcalendar.db")
        self.status_root = os.path.join(self.temp_dir, "status")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ["STATUS_ROOT"] = self.status_root
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE linked_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER
            )
        """)
        conn.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)")
        conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT)")
        # Same shape as server/db.js.
        conn.execute("""
            CREATE TABLE caldav_calendar_collections (
                account_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                remote_collection TEXT NOT NULL,
                local_collection TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, remote_collection),
                UNIQUE (user_id, local_collection),
                FOREIGN KEY (account_id) REFERENCES linked_accounts(id) ON DELETE CASCADE
            )
        """)
        conn.commit()
        conn.close()
        self.servers = []
        self.local = self.server(f"/{USER_ID}/")
        self.local.collections["personal"] = "Persönlich"
        self.remotes = {}
        self.vanished = set()

    def tearDown(self):
        for s in self.servers:
            s.stop()
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def server(self, home):
        s = MockCalDAV(home)
        self.servers.append(s)
        return s

    def add_basic_account(self, acc_id, collections):
        remote = self.server("/dav/calendars/testuser/")
        remote.collections.update(collections)
        self.remotes[acc_id] = remote
        enc, iv = sync_worker.encrypt("testpassword", sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
            " VALUES (?, ?, ?, 'testuser@example.com', ?, ?, 'basic')",
            (acc_id, USER_ID, remote.url, enc, iv),
        )
        conn.commit()
        conn.close()
        return remote

    def server_for(self, url):
        for s in self.servers:
            if url.rstrip("/") == s.url.rstrip("/"):
                return s
        raise AssertionError(f"no mock server for {url}")

    def simulate_vdirsyncer(self, cmd, *args, **kwargs):
        command = cmd[3]
        with open(cmd[2]) as f:
            config = parse_like_vdirsyncer(f.read())
        self.configs.append(config)
        status_path = config["general"]["status_path"]
        for section, pair in config.items():
            if not section.startswith("pair "):
                continue
            pair_name = section[len("pair "):]
            side_a = self.server_for(config[f"storage {pair['a']}"]["url"])
            side_b = self.server_for(config[f"storage {pair['b']}"]["url"])
            names_a = [n for n in side_a.names() if n not in self.vanished]
            names_b = side_b.names()
            triples = []
            for entry in pair["collections"]:
                if entry == "from a":
                    triples += [(n, n, n) for n in names_a]
                elif entry == "from b":
                    triples += [(n, n, n) for n in names_b]
                else:
                    triples.append(tuple(entry))
            if command == "discover":
                for _, a, b in triples:
                    for side, names, coll in ((side_a, names_a, a), (side_b, names_b, b)):
                        if coll in names:
                            continue
                        if "y" not in (kwargs.get("input") or ""):
                            return MagicMock(returncode=1, stdout="", stderr=f"Aborted: {coll} missing")
                        req = urllib.request.Request(side.url + urllib.parse.quote(coll) + "/", method="MKCOL")
                        urllib.request.urlopen(req).close()
            else:
                for name, _, _ in triples:
                    path = os.path.normpath(os.path.join(status_path, pair_name, name + ".items"))
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    open(path, "w").close()
        return MagicMock(returncode=0, stdout="", stderr="")

    def run_sync(self):
        self.configs = []
        with patch.object(sync_worker, "LOCAL_CALDAV_URL", self.local.base + "/"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch("subprocess.run", side_effect=self.simulate_vdirsyncer):
            return sync_worker.sync_user(USER_ID)

    def files_outside(self, allowed_dir):
        out = []
        for root, _, files in os.walk(self.temp_dir):
            for f in files:
                path = os.path.join(root, f)
                if path == self.db_path or path.startswith(self.db_path + "-"):
                    continue
                if not path.startswith(allowed_dir + os.sep):
                    out.append(os.path.relpath(path, self.temp_dir))
        return out

    def stored_mapping(self):
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT account_id, remote_collection, local_collection FROM caldav_calendar_collections").fetchall()
        conn.close()
        return {(acc, remote): local for acc, remote, local in rows}

    def test_traversing_remote_collection_name_fails_the_job_and_writes_nothing_outside(self):
        self.add_basic_account("acc-1", {"work": "Arbeit", HOSTILE: "x"})
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("../../other/x", err)
        self.assertEqual(self.files_outside(os.path.join(self.status_root, USER_ID + "_basic")), [])
        self.assertFalse(os.path.exists(os.path.join(self.status_root, "other")))

    def test_unsafe_remote_names_are_rejected(self):
        for i, seg in enumerate(("..", "%2e%2e", ".", "a%2fb", "a%5cb", "Arbeit%20Team", "%00", "work%0a")):
            with self.subTest(seg=seg):
                self.add_basic_account(f"acc-{i}", {"work": "Arbeit", seg: "x"})
                ok, err = self.run_sync()
                self.assertFalse(ok, seg)
                self.assertIn(repr(urllib.parse.unquote(seg)), err)
                # No vdirsyncer run and no local collection for any calendar of the account.
                self.assertEqual(self.configs, [])
                self.assertEqual(self.local.creations(), [])
                self.assertEqual(self.stored_mapping(), {})
                conn = sqlite3.connect(self.db_path)
                conn.execute("DELETE FROM linked_accounts")
                conn.commit()
                conn.close()

    def test_local_calendar_not_selected_is_never_created_on_the_provider(self):
        remote = self.add_basic_account("acc-1", {"work": "Arbeit"})
        remote.plain.add("inbox")
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        self.assertEqual(remote.creations(), [])
        self.assertEqual(sorted(remote.collections), ["work"])
        # The provider's calendar (not its scheduling inbox) is mirrored into a collection the
        # worker named and created.
        mapping = self.stored_mapping()
        self.assertEqual(list(mapping), [("acc-1", "work")])
        local = mapping[("acc-1", "work")]
        self.assertRegex(local, r"^caldav-[0-9a-f]{32}$")
        self.assertEqual(self.local.creations(), [("MKCALENDAR", f"/{USER_ID}/{local}/")])
        self.assertEqual(self.configs[0]["pair basic_0"]["collections"], [[local, "work", local]])

    def test_two_providers_do_not_receive_each_others_calendars(self):
        r1 = self.add_basic_account("acc-1", {"work": "Arbeit"})
        r2 = self.add_basic_account("acc-2", {"work": "Verein", "club": "Club"})
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        self.assertEqual(r1.creations(), [])
        self.assertEqual(r2.creations(), [])
        mapping = self.stored_mapping()
        self.assertEqual(set(mapping), {("acc-1", "work"), ("acc-2", "work"), ("acc-2", "club")})
        self.assertEqual(len(set(mapping.values())), 3)
        self.assertNotIn("personal", mapping.values())

    def test_mapping_is_stable_and_not_created_twice(self):
        self.add_basic_account("acc-1", {"work": "Arbeit"})
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        first = self.stored_mapping()
        self.local.requests.clear()
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        self.assertEqual(self.stored_mapping(), first)
        self.assertEqual(self.local.creations(), [])

    def test_empty_listing_for_an_account_with_synced_calendars_is_an_error(self):
        remote = self.add_basic_account("acc-1", {"work": "Arbeit"})
        ok, err = self.run_sync()
        self.assertTrue(ok, err)
        remote.collections.clear()
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("acc-1", err)
        self.assertEqual(self.configs, [])

    def test_oversized_listing_is_an_error(self):
        self.add_basic_account("acc-1", {"work": "A" * (6 * 1024 * 1024)})
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("exceeds", err)
        self.assertEqual(self.configs, [])

    def test_collection_gone_from_provider_before_vdirsyncer_runs_is_not_recreated(self):
        remote = self.add_basic_account("acc-1", {"work": "Arbeit"})
        self.vanished = {"work"}
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertEqual(remote.creations(), [])


if __name__ == "__main__":
    unittest.main()
