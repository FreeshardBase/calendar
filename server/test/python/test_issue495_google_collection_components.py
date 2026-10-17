"""Issue #495 — the local mirror of a Google calendar is created for events only.

Google's CalDAV has no VTODO (Google Tasks is a separate API). The worker used to create the mirror
collection without a supported-calendar-component-set, so Radicale accepted tasks in it, the app
offered it as a task list, and a task stored there could never sync to Google.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker

USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
CALDAV = "{urn:ietf:params:xml:ns:caldav}"


class TestIssue495GoogleCollectionComponents(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("""
            CREATE TABLE google_calendar_collections (
                account_id TEXT NOT NULL, user_id TEXT NOT NULL, google_calendar_id TEXT NOT NULL,
                local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, google_calendar_id), UNIQUE (user_id, local_collection)
            )
        """)
        self.requests = []

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.temp_dir)

    def fake_urlopen(self, req, *args, **kwargs):
        self.requests.append(req)
        res = MagicMock(status=201)
        res.__enter__ = lambda s: s
        res.__exit__ = lambda s, *a: False
        return res

    def components_of(self, req):
        root = ET.fromstring(req.data.decode("utf-8"))
        comp_set = root.find(f".//{CALDAV}supported-calendar-component-set")
        self.assertIsNotNone(comp_set, "MKCALENDAR names no supported-calendar-component-set")
        return [c.get("name") for c in comp_set.findall(f"{CALDAV}comp")]

    def test_google_mirror_collection_accepts_events_only(self):
        with patch.object(sync_worker.urllib.request, "urlopen", side_effect=self.fake_urlopen):
            local = sync_worker.local_collection_for_google_calendar(
                self.conn, USER_ID, "acc-g0", {"id": "primary", "name": "Privat"}, self.temp_dir)
        self.assertEqual(len(self.requests), 1)
        req = self.requests[0]
        self.assertEqual(req.get_method(), "MKCALENDAR")
        self.assertTrue(req.full_url.endswith(f"/{USER_ID}/{local}/"), req.full_url)
        self.assertEqual(self.components_of(req), ["VEVENT"])


if __name__ == "__main__":
    unittest.main()
