# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The parts of runner/job.py that need no root: the memory monitors, dirty, the timeout rule, the file walk."""

import os
import signal
import tempfile
import threading
import time
import unittest
from unittest import mock

from runner import job as jb
from runner import sizing as sz

MIB = sz.MIB


class FakeFilter:
    def install(self):
        pass


def write(path, text):
    with open(path, "w", encoding="ascii") as f:
        f.write(text)


class ConstantsTest(unittest.TestCase):
    def test_job_uid_is_1001(self):
        self.assertEqual(jb.UID, 1001)

    def test_cpu_seconds_round_up(self):
        self.assertEqual([jb.cpu_seconds(t) for t in (1, 1000, 1001, 30000, 60000)], [1, 1, 2, 30, 60])

    def test_cpu_limit_reads_as_timeout(self):
        kill, xcpu = -signal.SIGKILL, -signal.SIGXCPU
        self.assertTrue(jb.cpu_limit_hit(kill, False, 1000, 1000))
        self.assertTrue(jb.cpu_limit_hit(xcpu, False, 29950, 30000))
        self.assertFalse(jb.cpu_limit_hit(kill, True, 30000, 30000))  # a memory kill is not a timeout
        self.assertFalse(jb.cpu_limit_hit(kill, False, 200, 30000))  # killed early: not the CPU limit
        self.assertFalse(jb.cpu_limit_hit(0, False, 30000, 30000))
        self.assertFalse(jb.cpu_limit_hit(-signal.SIGTERM, False, 30000, 30000))


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.group = self.dir.name

    def executor(self, backend, **kw):
        size = sz.Sizing(backend, 1024 * MIB)
        f = None if backend == "agentcore" else FakeFilter()
        return jb.Executor(backend, size, f, uid=os.getuid() + 100000, **kw)

    def test_nitro_watchdog_counts_without_page_cache(self):
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(2000 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file %d\nshmem %d\n" % (1500 * MIB, 10 * MIB))
        self.assertFalse(ex._above_l())  # 510 MiB counted, L = 768 MiB
        write(os.path.join(self.group, "memory.stat"), "file %d\nshmem %d\n" % (1500 * MIB, 300 * MIB))
        self.assertTrue(ex._above_l())  # 800 MiB counted

    def test_microvm_floor(self):
        ex = self.executor("microvm")
        with mock.patch.object(jb, "read_text", return_value="MemAvailable: %d kB\n" % (511 * 1024)):
            self.assertTrue(ex._below_floor())
        with mock.patch.object(jb, "read_text", return_value="MemAvailable: %d kB\n" % (512 * 1024)):
            self.assertFalse(ex._below_floor())

    def test_monitor_marks_before_it_kills(self):
        for backend, kw, check in (("microvm", {}, "_below_floor"), ("nitro", {"task_group": self.group}, "_above_l")):
            ex = self.executor(backend, **kw)
            marked_at_kill = []
            with mock.patch.object(ex, check, return_value=True), \
                    mock.patch.object(ex, "_kill_group", side_effect=lambda _: marked_at_kill.append(ex._exceeded.is_set())), \
                    mock.patch.object(ex, "_kill_uid", return_value=[]):
                ex._monitor(12345, threading.Event())
            self.assertEqual(marked_at_kill, [True], backend)

    def test_agentcore_has_no_monitor(self):
        ex = self.executor("agentcore", job_group=self.group)
        started = time.monotonic()
        ex._monitor(12345, threading.Event())
        self.assertLess(time.monotonic() - started, 0.05)

    def test_agentcore_dirty_at_32_mib(self):
        ex = self.executor("agentcore", job_group=self.group)
        write(os.path.join(self.group, "memory.stat"), "file %d\nshmem 0\n" % (100 * MIB))
        write(os.path.join(self.group, "memory.current"), str(100 * MIB + 32 * MIB - 1))
        self.assertFalse(ex.dirty())
        write(os.path.join(self.group, "memory.current"), str(100 * MIB + 32 * MIB))
        self.assertTrue(ex.dirty())
        self.assertFalse(self.executor("nitro", task_group=self.group).dirty())

    def test_oom_kills_read_from_the_right_group(self):
        write(os.path.join(self.group, "memory.events"), "oom 1\noom_kill 3\n")
        self.assertEqual(self.executor("agentcore", job_group=self.group)._oom_kills(), 3)
        self.assertEqual(self.executor("nitro", task_group=self.group)._oom_kills(), 3)
        self.assertEqual(self.executor("microvm")._oom_kills(), 0)


class RemoveOwnedTest(unittest.TestCase):
    def test_links_are_removed_not_followed(self):
        with tempfile.TemporaryDirectory() as d:
            top, outside = os.path.join(d, "top"), os.path.join(d, "outside")
            os.makedirs(os.path.join(top, "sub"))
            os.makedirs(outside)
            write(os.path.join(outside, "keep"), "x")
            write(os.path.join(top, "sub", "f"), "x")
            os.symlink(outside, os.path.join(top, "dirlink"))
            os.symlink(os.path.join(outside, "keep"), os.path.join(top, "filelink"))
            count, done = jb.remove_owned(top, os.getuid(), time.monotonic() + 5)
            self.assertTrue(done)
            self.assertEqual(count, 4)
            self.assertEqual(os.listdir(top), [])
            self.assertTrue(os.path.exists(os.path.join(outside, "keep")))

    def test_other_owners_stay_and_the_deadline_stops_the_walk(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "f"), "x")
            self.assertEqual(jb.remove_owned(d, os.getuid() + 1, time.monotonic() + 5), (0, True))
            self.assertEqual(jb.remove_owned(d, os.getuid(), time.monotonic() - 1), (0, False))
            self.assertTrue(os.path.exists(os.path.join(d, "f")))


if __name__ == "__main__":
    unittest.main()
