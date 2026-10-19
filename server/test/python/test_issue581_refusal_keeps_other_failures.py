"""Issue #581 — a refused item must not hide the other pairs' failures in the reported sync error.

Once vdirsyncer's log named an item Google refused, the worker reported only the refusals and
dropped the rest of the log, so a second pair failing for another reason passed silently. Now every
other failure is reported next to the refusals with its pair and reason, shortened only by a cap
that says how much was cut.

Reuses the fake vdirsyncer of #572 and appends a second pair's log to its run.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_issue572_google_item_types import Issue572Base, sync_worker  # noqa: E402


class RefusalWithOtherPairFailing(Issue572Base):
    other_log = []

    def setUp(self):
        super().setUp()
        self.refuse = {"ev-2"}

    def fake_vdirsyncer(self, cmd, *args, **kwargs):
        res = super().fake_vdirsyncer(cmd, *args, **kwargs)
        if cmd[3] == "sync":
            res.stderr += "\n".join(self.other_log) + "\n"
            res.returncode = 1
        return res


class TestOtherPairFailureIsReported(RefusalWithOtherPairFailing):
    other_log = [
        "Syncing sync_1/google-mirror1",
        "error: Unknown error occurred for sync_1/google-mirror1: Cannot connect to host "
        "apidata.googleusercontent.com:443 ssl:default [Connection reset by peer]",
        "error: Use `-vdebug` to see the full traceback.",
    ]

    def test_refused_item_and_other_pair_failure_both_appear(self):
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("„Termin B“", err)
        self.assertIn("403 Forbidden", err)
        line = next(ln for ln in err.splitlines() if "Connection reset by peer" in ln)
        self.assertIn("sync_1/google-mirror1", line)
        self.assertEqual(err.count("Connection reset by peer"), 1)
        # The refused item is reported once, as the named refusal, not again as a raw log line.
        self.assertNotIn("events/ev-2.ics", err)


class TestFailureWithoutPairInLineGetsItsPair(RefusalWithOtherPairFailing):
    # A failure line that does not name its pair is attributed to the pair being synced.
    other_log = [
        "Syncing sync_2/google-mirror2",
        "error: 500, message='Internal Server Error', url='https://apidata.googleusercontent.com/caldav/v2/x/events/'",
    ]

    def test_collection_level_5xx_is_not_a_refusal_and_names_its_pair(self):
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("„Termin B“", err)
        line = next(ln for ln in err.splitlines() if "Internal Server Error" in ln)
        self.assertIn("sync_2/google-mirror2", line)


class TestOtherFailuresAreCappedVisibly(RefusalWithOtherPairFailing):
    other_log = ["Syncing sync_1/google-mirror1"] + [
        f"error: Unknown error occurred for sync_1/google-mirror1: failure number {i:04d} " + "x" * 80
        for i in range(500)
    ]

    def test_cap_says_how_much_was_cut(self):
        ok, err = self.run_sync()
        self.assertFalse(ok)
        self.assertIn("„Termin B“", err)
        self.assertIn("failure number 0000", err)
        self.assertNotIn("failure number 0499", err)
        self.assertLessEqual(len(err), sync_worker.OTHER_FAILURES_CAP + 1000)
        full = "\n".join(sync_worker.other_sync_failures("\n".join(self.other_log)))
        self.assertGreater(len(full), sync_worker.OTHER_FAILURES_CAP)
        self.assertIn(f"{len(full) - sync_worker.OTHER_FAILURES_CAP} weitere Zeichen gekürzt", err)


if __name__ == "__main__":
    unittest.main()
