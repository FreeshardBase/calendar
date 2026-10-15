"""Issue #193 — a synced Google calendar must never be paired with an existing local collection.

Drives the real sync_user() with Google discovery and token refresh stubbed and subprocess.run
replaced by a recorder, then reads the vdirsyncer config it generated. The third element of each
`collections` triple is the collection on side b (the user's Radicale principal).
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
import urllib.parse
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"


def parse_like_vdirsyncer(text):
    parser = configparser.RawConfigParser()
    parser.read_string(text)
    return {s: {k: json.loads(v) for k, v in parser.items(s)} for s in parser.sections()}


def slug(name):
    import re
    import unicodedata
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


class TestIssue193GoogleCollectionMapping(unittest.TestCase):
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
        # Same shape as server/db.js.
        conn.execute("""
            CREATE TABLE google_calendar_collections (
                account_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                google_calendar_id TEXT NOT NULL,
                local_collection TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, google_calendar_id),
                UNIQUE (user_id, local_collection),
                FOREIGN KEY (account_id) REFERENCES linked_accounts(id) ON DELETE CASCADE
            )
        """)
        conn.commit()
        conn.close()
        self.discovered = {}

    def tearDown(self):
        shutil.rmtree(self.temp_dir)
        os.environ.pop("DATABASE_PATH", None)
        os.environ.pop("STATUS_ROOT", None)

    def add_google_account(self, acc_id, url):
        enc, iv = sync_worker.encrypt("refresh-token", sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type,"
            " access_token, expires_at) VALUES (?, ?, ?, 'testuser@example.com', ?, ?, 'oauth2', 'tok', ?)",
            (acc_id, USER_ID, url, enc, iv, int(time.time() * 1000) + 3600 * 1000),
        )
        conn.commit()
        conn.close()

    def run_sync(self, expect_ok=True):
        captured = []
        self.commands = []
        self.created = []

        def fake_run(cmd, *args, **kwargs):
            self.commands.append(cmd[3])
            with open(cmd[2]) as f:
                captured.append(f.read())
            return MagicMock(returncode=0, stdout="", stderr="")

        def fake_discover(url, token):
            return self.discovered[url]

        def fake_urlopen(req, *args, **kwargs):
            self.created.append(req)
            res = MagicMock(status=getattr(self, "mkcalendar_status", 201))
            res.__enter__ = lambda s: s
            res.__exit__ = lambda s, *a: False
            return res

        with patch.object(sync_worker, "discover_google_collections", side_effect=fake_discover), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker.urllib.request, "urlopen", side_effect=fake_urlopen), \
             patch("subprocess.run", side_effect=fake_run):
            ok, err = sync_worker.sync_user(USER_ID)
        if not expect_ok:
            self.assertFalse(ok)
            return err
        self.assertTrue(ok, err)
        return parse_like_vdirsyncer(captured[0]), self.commands

    def write_legacy_status(self, collection, pair="sync_0"):
        """vdirsyncer status of a collection an earlier worker version synced (<status>/<pair>/<coll>.items)."""
        pair_dir = os.path.join(os.environ["STATUS_ROOT"], USER_ID, pair)
        os.makedirs(pair_dir, exist_ok=True)
        open(os.path.join(pair_dir, f"{collection}.items"), "w").close()

    def created_collections(self):
        """{collection name: (displayname in body, request)} for every MKCALENDAR the worker sent."""
        import re
        out = {}
        for req in self.created:
            self.assertEqual(req.get_method(), "MKCALENDAR")
            path = urllib.parse.urlsplit(req.full_url).path
            m = re.fullmatch(rf"/{USER_ID}/([^/]+)/", path)
            self.assertIsNotNone(m, path)
            name = re.search(r"<d:displayname>(.*?)</d:displayname>", req.data.decode("utf-8")).group(1)
            out[m.group(1)] = (name, req)
        return out

    def local_collections(self, config, pair):
        """{google calendar id: local collection} for one pair."""
        return {a: b for _, a, b in config[f"pair {pair}"]["collections"]}

    def stored_mapping(self):
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT account_id, google_calendar_id, local_collection FROM google_calendar_collections"
        ).fetchall()
        conn.close()
        return {(a, g): c for a, g, c in rows}

    def test_local_collection_is_not_derived_from_google_display_name(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        names = ["Privat", "Familie", "Büro", "Work / Arbeit", "Google Privat"]
        self.discovered["https://g0.example.com/"] = [
            {"id": f"cal{i}@group.calendar.google.com", "name": n} for i, n in enumerate(names)
        ]
        config, _ = self.run_sync()
        mapping = self.local_collections(config, "sync_0")
        self.assertEqual(len(mapping), len(names))
        # Every name an app calendar could get from the create route, with or without prefix.
        name_slugs = {slug(n) for n in names} | {f"google-{slug(n)}" for n in names}
        for google_id, local in mapping.items():
            self.assertNotIn(local, name_slugs)
            self.assertRegex(local, r"^google-[0-9a-f]{32}$")
        self.assertEqual(len(set(mapping.values())), len(names))

    def test_same_name_in_two_accounts_gets_two_collections(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.add_google_account("acc-g1", "https://g1.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "primary", "name": "Familie"}]
        self.discovered["https://g1.example.com/"] = [{"id": "primary", "name": "Familie"}]
        config, _ = self.run_sync()
        pairs = sorted(s[len("pair "):] for s in config if s.startswith("pair "))
        self.assertEqual(pairs, ["sync_0", "sync_1"])
        targets = [self.local_collections(config, p)["primary"] for p in pairs]
        self.assertNotEqual(targets[0], targets[1])
        # Both pairs point at the same principal, so distinct collection names are the isolation.
        self.assertEqual(config["storage local_0"]["url"], config["storage local_1"]["url"])

    def test_mapping_is_persisted_and_survives_a_rename(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "fam@group.calendar.google.com", "name": "Familie"}]
        first, _ = self.run_sync()
        before = self.local_collections(first, "sync_0")["fam@group.calendar.google.com"]
        self.assertEqual(self.stored_mapping(), {("acc-g0", "fam@group.calendar.google.com"): before})

        self.discovered["https://g0.example.com/"] = [{"id": "fam@group.calendar.google.com", "name": "Familie neu"}]
        second, _ = self.run_sync()
        after = self.local_collections(second, "sync_0")["fam@group.calendar.google.com"]
        self.assertEqual(after, before)
        self.assertEqual(len(self.stored_mapping()), 1)

    def test_new_collection_is_created_with_the_google_name_as_displayname(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "primary", "name": "Privat & <Co>"}]
        config, commands = self.run_sync()
        local = self.local_collections(config, "sync_0")["primary"]
        created = self.created_collections()
        self.assertEqual(list(created), [local])
        name, req = created[local]
        self.assertEqual(name, "Privat &amp; &lt;Co&gt;")
        self.assertEqual(req.get_header("Accept-encoding"), "identity")
        # Names only travel Google -> local: no metasync, which would push app renames to Google.
        self.assertNotIn("metadata", config["pair sync_0"])
        self.assertEqual(commands, ["discover", "sync"])

        # Second run: the collection exists and is not created again.
        self.run_sync()
        self.assertEqual(self.created, [])

    def test_collection_synced_by_the_previous_worker_is_adopted_not_duplicated(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.add_google_account("acc-g1", "https://g1.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "fam0@group.calendar.google.com", "name": "Familie"}]
        self.discovered["https://g1.example.com/"] = [{"id": "fam1@group.calendar.google.com", "name": "Familie"}]
        self.write_legacy_status("google-familie")
        config, _ = self.run_sync()
        first = self.local_collections(config, "sync_0")["fam0@group.calendar.google.com"]
        second = self.local_collections(config, "sync_1")["fam1@group.calendar.google.com"]
        self.assertEqual(first, "google-familie")
        # Only one Google calendar can own it; the other account gets its own collection.
        self.assertRegex(second, r"^google-[0-9a-f]{32}$")
        self.assertEqual(list(self.created_collections()), [second])

    def test_only_the_account_whose_pair_synced_the_legacy_collection_adopts_it(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.add_google_account("acc-g1", "https://g1.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "fam0@group.calendar.google.com", "name": "Familie"}]
        self.discovered["https://g1.example.com/"] = [{"id": "fam1@group.calendar.google.com", "name": "Familie"}]
        self.write_legacy_status("google-familie", pair="sync_1")
        self.write_legacy_status("google-other", pair="sync_0")
        config, _ = self.run_sync()
        self.assertRegex(self.local_collections(config, "sync_0")["fam0@group.calendar.google.com"],
                         r"^google-[0-9a-f]{32}$")
        self.assertEqual(self.local_collections(config, "sync_1")["fam1@group.calendar.google.com"],
                         "google-familie")

    def test_failed_collection_creation_fails_the_job(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "primary", "name": "Privat"}]
        self.mkcalendar_status = 207
        err = self.run_sync(expect_ok=False)
        self.assertIn("primary", err)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.stored_mapping(), {})

    def test_collection_without_worker_status_is_never_adopted(self):
        # An app calendar the user once named "Google Privat" sits at google-privat; no vdirsyncer
        # status exists for it because the worker never synced it.
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "primary", "name": "Privat"}]
        config, _ = self.run_sync()
        self.assertNotEqual(self.local_collections(config, "sync_0")["primary"], "google-privat")

    def test_empty_discovery_for_a_mapped_account_is_an_error(self):
        self.add_google_account("acc-g0", "https://g0.example.com/")
        self.discovered["https://g0.example.com/"] = [{"id": "primary", "name": "Privat"}]
        self.run_sync()
        self.discovered["https://g0.example.com/"] = []
        err = self.run_sync(expect_ok=False)
        self.assertIn("acc-g0", err)
        self.assertEqual(self.commands, [])


if __name__ == "__main__":
    unittest.main()
