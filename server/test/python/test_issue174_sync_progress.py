"""Issue #174 — the first sync of a large linked account takes minutes (Radicale's create cost grows
with the collection), so the running sync job reports how many events it has written so far in
sync_job_progress.items_done, which the web app shows as progress. The count is the worker's real state:

  - vdirsyncer: every "Copying (uploading|updating) item" line counts, while vdirsyncer still runs
    (a fake vdirsyncer executable on PATH blocks until the test has seen the live count);
  - Microsoft Graph: each delta page's written events count once the page is committed;
  - a job that is run again starts counting from zero.
"""
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402
import test_issue60_msgraph_sync_writes_events as graph_harness  # noqa: E402

USER_ID = "testuser"

FAKE_VDIRSYNCER = r'''#!/usr/bin/env python3
import os, sys, time
flag = os.environ["ISSUE174_RELEASE_FLAG"]
sys.stderr.write("Syncing sync_0/testuser-cal\n")
sys.stderr.write("Copying (uploading) item a1 to local_0/testuser-cal\n")
sys.stderr.write("Copying (updating) item a2 to google_0/testuser-cal\n")
sys.stderr.flush()
deadline = time.time() + 20
while not os.path.exists(flag) and time.time() < deadline:
    time.sleep(0.02)
sys.stderr.write("Copying (uploading) item a3 to local_0/testuser-cal\n")
if os.environ.get("ISSUE174_FAIL"):
    sys.stderr.write("error: Test User sync failed\n")
    sys.exit(1)
'''


def _items_done(db_path, job_id):
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT items_done FROM sync_job_progress WHERE job_id = ?", (job_id,)).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


class VdirsyncerProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE sync_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL)")
        conn.execute("CREATE TABLE sync_job_progress (job_id TEXT PRIMARY KEY, items_done INTEGER NOT NULL DEFAULT 0)")
        conn.execute("INSERT INTO sync_queue (id, user_id, status) VALUES ('job-174', ?, 'RUNNING')", (USER_ID,))
        conn.commit()
        conn.close()
        bin_dir = os.path.join(self.tmp, "bin")
        os.mkdir(bin_dir)
        exe = os.path.join(bin_dir, "vdirsyncer")
        with open(exe, "w") as f:
            f.write(FAKE_VDIRSYNCER)
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IXUSR)
        self.flag = os.path.join(self.tmp, "release")
        self.env = patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ["PATH"],
                                           "ISSUE174_RELEASE_FLAG": self.flag})
        self.env.start()
        sync_worker.active_job_id = "job-174"
        sync_worker.active_job_db_path = self.db_path

    def tearDown(self):
        sync_worker.active_job_id = None
        sync_worker.active_job_db_path = None
        self.env.stop()
        shutil.rmtree(self.tmp)

    def _run_in_thread(self):
        result = {}

        def run():
            result["res"] = sync_worker.run_vdirsyncer(os.path.join(self.tmp, "config.ini"), "sync")
        thread = threading.Thread(target=run)
        thread.start()
        return thread, result

    def test_copied_items_are_counted_while_vdirsyncer_still_runs(self):
        thread, result = self._run_in_thread()
        deadline = time.time() + 10
        while _items_done(self.db_path, "job-174") < 2 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(_items_done(self.db_path, "job-174"), 2,
                         "the two copied items are visible before vdirsyncer exits")
        self.assertTrue(thread.is_alive(), "vdirsyncer is still running")
        open(self.flag, "w").close()
        thread.join(15)

        self.assertEqual(result["res"].returncode, 0)
        self.assertEqual(_items_done(self.db_path, "job-174"), 3)

    def test_a_failing_run_keeps_its_stderr_for_the_job_error(self):
        os.environ["ISSUE174_FAIL"] = "1"
        open(self.flag, "w").close()
        thread, result = self._run_in_thread()
        thread.join(15)

        self.assertEqual(result["res"].returncode, 1)
        self.assertIn("Test User sync failed", result["res"].stderr)
        self.assertEqual(_items_done(self.db_path, "job-174"), 3)


class _PagedGraph(graph_harness.FakeGraphAndRadicale):
    """Serves delta pages in order; records items_done when the second page is fetched."""

    def __init__(self, pages, db_path):
        super().__init__(pages[0])
        self.pages = list(pages)
        self.db_path = db_path
        self.done_at_second_page = None

    def __call__(self, req, context=None, timeout=None):
        if req.full_url.startswith(graph_harness.DELTA) and req.full_url.endswith("page=2"):
            self.done_at_second_page = _items_done(self.db_path, "job-60")
            self.page = self.pages[1]
        return super().__call__(req, context, timeout)


def _graph_event(graph_id):
    return {"id": graph_id, "subject": "Test User review", "isAllDay": False,
            "start": {"dateTime": "2026-10-05T08:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-10-05T09:00:00.0000000", "timeZone": "UTC"}}


class MSGraphProgressTest(graph_harness.MSGraphSyncJobWritesEventsTest):
    # Reuses the #60 fixture; load_tests runs only this class's own test, not the inherited ones.
    def setUp(self):
        super().setUp()
        conn = sqlite3.connect(self.db_path)
        # Left over from an earlier attempt of the same job.
        conn.execute("INSERT INTO sync_job_progress (job_id, items_done) VALUES ('job-60', 7)")
        conn.commit()
        conn.close()

    def test_each_committed_page_counts_and_a_rerun_starts_from_zero(self):
        pages = [
            {"value": [_graph_event("g1"), _graph_event("g2")],
             "@odata.nextLink": f"{graph_harness.DELTA}?page=2"},
            {"value": [_graph_event("g3")], "@odata.deltaLink": graph_harness.NEXT_DELTA},
        ]
        fake = _PagedGraph(pages, self.db_path)

        with patch.object(urllib.request, "urlopen", side_effect=fake):
            self.assertTrue(sync_worker.process_next_job(self.db_path))

        self.assertEqual(self._job(), ("SUCCESS", None))
        self.assertEqual(fake.done_at_second_page, 2, "the first page's events count before the second is fetched")
        self.assertEqual(_items_done(self.db_path, "job-60"), 3)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(VdirsyncerProgressTest))
    suite.addTest(MSGraphProgressTest("test_each_committed_page_counts_and_a_rerun_starts_from_zero"))
    return suite


if __name__ == "__main__":
    unittest.main()
