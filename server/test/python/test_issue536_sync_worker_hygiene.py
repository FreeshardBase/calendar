"""Issue #536: sync worker hygiene.

1. The worker writes vdirsyncer configs (external passwords, Google tokens, SYSTEM_SYNC_SECRET) to
   <tempdir>/vdirsyncer-cfg-*/. A hard kill leaves them behind, so the worker removes every such
   directory when it boots and when it shuts down.
2. The Microsoft 365 import builds Radicale paths from target_calendar_id and the Graph event id.
   Neither may leave its path segment.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import msgraph_worker  # noqa: E402
import sync_worker  # noqa: E402


class TestConfigDirPurge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved_tempdir = tempfile.tempdir
        tempfile.tempdir = self.tmp
        self.saved_shutdown = sync_worker.shutdown_requested
        self.stale = os.path.join(self.tmp, "vdirsyncer-cfg-xyz")
        os.mkdir(self.stale, 0o700)
        with open(os.path.join(self.stale, "config.ini"), "w") as fh:
            fh.write("password = testuser-secret\n")
        self.unrelated = os.path.join(self.tmp, "other-dir")
        os.mkdir(self.unrelated)
        self.unrelated_file = os.path.join(self.unrelated, "keep.txt")
        with open(self.unrelated_file, "w") as fh:
            fh.write("unrelated\n")
        # A symlink with the prefix is removed without touching its target.
        self.link = os.path.join(self.tmp, "vdirsyncer-cfg-link")
        os.symlink(self.unrelated, self.link)

    def tearDown(self):
        tempfile.tempdir = self.saved_tempdir
        sync_worker.shutdown_requested = self.saved_shutdown
        shutil.rmtree(self.tmp)

    def test_boot_removes_stale_config_dirs(self):
        # The database never appears: the worker stops in its wait loop, after booting.
        sync_worker.shutdown_requested = True
        with mock.patch.object(sync_worker, "DB_PATH", os.path.join(self.tmp, "missing.db")):
            sync_worker.main()
        self.assertFalse(os.path.exists(self.stale))
        self.assertFalse(os.path.lexists(self.link))
        self.assertTrue(os.path.isfile(self.unrelated_file))

    def test_shutdown_signal_removes_config_dirs(self):
        with mock.patch.object(sync_worker, "active_job_id", None):
            with self.assertRaises(SystemExit):
                sync_worker.handle_shutdown_signal(15, None)
        self.assertFalse(os.path.exists(self.stale))
        self.assertFalse(os.path.lexists(self.link))
        self.assertTrue(os.path.isfile(self.unrelated_file))


class TestShutdownDuringSync(unittest.TestCase):
    """SIGTERM while vdirsyncer runs: the purge removes the job's config dir, and the job's own
    cleanup must still let the SystemExit through (the handler has reset the job to PENDING)."""

    def setUp(self):
        test_dir = os.path.dirname(os.path.abspath(__file__))
        if test_dir not in sys.path:
            sys.path.insert(0, test_dir)
        from test_issue531_basic_caldav_collection_scope import TestIssue531BasicCaldavCollectionScope
        self.harness = TestIssue531BasicCaldavCollectionScope("run_sync")
        self.harness.setUp()
        self.saved_tempdir = tempfile.tempdir
        tempfile.tempdir = self.harness.temp_dir
        self.saved_shutdown = sync_worker.shutdown_requested

    def tearDown(self):
        tempfile.tempdir = self.saved_tempdir
        sync_worker.shutdown_requested = self.saved_shutdown
        self.harness.tearDown()

    def test_sigterm_mid_sync_exits_instead_of_failing_the_job(self):
        self.harness.add_basic_account("acc-1", {"work": "Arbeit"})
        simulate = self.harness.simulate_vdirsyncer
        config_dirs = []

        def sigterm_during_sync(cmd, *args, **kwargs):
            if cmd[3] == "sync":
                config_dirs.append(os.path.dirname(cmd[2]))
                sync_worker.handle_shutdown_signal(15, None)
            return simulate(cmd, *args, **kwargs)

        self.harness.simulate_vdirsyncer = sigterm_during_sync
        with mock.patch.object(sync_worker, "active_job_id", None):
            with self.assertRaises(SystemExit):
                self.harness.run_sync()
        self.assertEqual(len(config_dirs), 1)
        self.assertFalse(os.path.exists(config_dirs[0]))


GRAPH_ITEM = {
    "subject": "Test",
    "start": {"dateTime": "2026-10-20T10:00:00.0000000", "timeZone": "UTC"},
    "end": {"dateTime": "2026-10-20T11:00:00.0000000", "timeZone": "UTC"},
}


class TestGraphPathSegments(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            "CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT UNIQUE NOT NULL,"
            " account_id TEXT NOT NULL, last_synced_at INTEGER, e_tag TEXT)"
        )
        self.urlopen = mock.patch.object(msgraph_worker.urllib.request, "urlopen").start()
        self.addCleanup(mock.patch.stopall)

    def tearDown(self):
        self.conn.close()

    def apply(self, target_cal, item):
        return msgraph_worker._apply_graph_item("testuser", self.conn.cursor(), "acc-1", target_cal, item, 0)

    def requested_urls(self):
        return [call.args[0].full_url for call in self.urlopen.call_args_list]

    def test_unsafe_target_calendar_is_refused_before_any_request(self):
        for bad in ["../otheruser/persoenlich", "a/b", "..", ".", "", "cal%2F..", "cal?x=1"]:
            with self.assertRaises(ValueError, msg=bad):
                self.apply(bad, {**GRAPH_ITEM, "id": "AAMkAGI2"})
        self.assertEqual(self.requested_urls(), [])

    def test_unsafe_target_calendar_is_refused_for_removals(self):
        self.conn.execute(
            "INSERT INTO msgraph_event_mappings (local_uid, graph_id, account_id) VALUES (?, ?, ?)",
            ("msgraph-event-AAMkAGI2", "AAMkAGI2", "acc-1"),
        )
        with self.assertRaises(ValueError):
            self.apply("../otheruser/persoenlich", {"id": "AAMkAGI2", "@removed": {"reason": "deleted"}})
        self.assertEqual(self.requested_urls(), [])

    def test_unsafe_graph_id_is_refused_before_any_request(self):
        for bad in ["../../otheruser/persoenlich/x", "AAMk/AGI2", "AAMk\r\nATTENDEE:x", "AAMk?x", "AAMk#x"]:
            with self.assertRaises(ValueError, msg=bad):
                self.apply("persoenlich", {**GRAPH_ITEM, "id": bad})
        self.assertEqual(self.requested_urls(), [])

    def test_graph_id_is_percent_encoded_in_the_resource_path(self):
        self.assertTrue(self.apply("persoenlich", {**GRAPH_ITEM, "id": "AAMk+AGI2=="}))
        self.assertEqual(
            self.requested_urls(),
            [f"{msgraph_worker.LOCAL_CALDAV_URL.rstrip('/')}/testuser/persoenlich/msgraph-event-AAMk%2BAGI2%3D%3D.ics"],
        )
        body = self.urlopen.call_args.args[0].data.decode("utf-8")
        self.assertIn("\r\nUID:msgraph-event-AAMk+AGI2==\r\n", body)

    def test_removal_of_unsafe_mapped_uid_is_refused(self):
        self.conn.execute(
            "INSERT INTO msgraph_event_mappings (local_uid, graph_id, account_id) VALUES (?, ?, ?)",
            ("../../otheruser/persoenlich/x", "AAMkAGI2", "acc-1"),
        )
        with self.assertRaises(ValueError):
            self.apply("persoenlich", {"id": "AAMkAGI2", "@removed": {"reason": "deleted"}})
        self.assertEqual(self.requested_urls(), [])


if __name__ == "__main__":
    unittest.main()
