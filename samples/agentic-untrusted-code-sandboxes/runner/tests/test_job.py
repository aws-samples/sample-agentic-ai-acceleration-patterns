# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The parts of runner/job.py that need no root: the memory monitors, dirty, the timeout rule, the file walk."""

import os
import signal
import subprocess
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

    def test_the_job_locks_no_memory(self):
        ex = jb.Executor("nitro", sz.Sizing("nitro", 1024 * MIB), FakeFilter())
        self.assertIn((jb.resource.RLIMIT_MEMLOCK, 0), ex._limits(1000))

    def test_lock_memory_locks_current_then_future_on_fault(self):
        calls = []

        class Libc:
            def mlockall(self, flags):
                calls.append(flags)
                return 0

        jb.lock_memory(Libc())
        self.assertEqual(calls, [jb.MCL_CURRENT, jb.MCL_FUTURE | jb.MCL_ONFAULT])

    def test_lock_memory_raises_when_refused(self):
        class Libc:
            def mlockall(self, flags):
                return -1

        with self.assertRaises(OSError):
            jb.lock_memory(Libc())

    def test_the_sysv_sweep_locks_no_memory(self):
        # The first statement after the imports, before libc or any SysV call.
        lines = [line for line in jb.SYSV_SWEEP.splitlines() if line.strip()]
        self.assertEqual(lines[1].split("#")[0].strip(), "resource.setrlimit(resource.RLIMIT_MEMLOCK, (0, 0))")
        self.assertEqual(lines[0], "import ctypes, resource")
        # Run those two lines: the limit they leave is 0, soft and hard. The rest of the sweep removes SysV objects,
        # so it is not run here.
        probe = "\n".join(lines[:2]) + "\nprint(resource.getrlimit(resource.RLIMIT_MEMLOCK))\n"
        out = subprocess.run([jb.sys.executable, "-I", "-c", probe], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), "(0, 0)")

    def test_nitro_claim_opens_the_watchdog(self):
        # become_tenants opens the watchdog's files at claim, before any job (ADR-0074).
        from runner import runner as rn

        made = []

        class FakeExecutor:
            def __init__(self, *a, **kw):
                self.opened = 0
                made.append(self)

            def open_watchdog(self):
                self.opened += 1

        size = sz.Sizing("nitro", 1024 * MIB)
        with mock.patch("builtins.open", mock.mock_open(read_data="0::/task\n")), \
                mock.patch.object(rn.job, "read_text", return_value=""), \
                mock.patch.object(rn.job, "prepare_work"), \
                mock.patch.object(rn.job, "task_memory_max", return_value=None), \
                mock.patch.object(rn.sizing, "memory_m", return_value=size.m), \
                mock.patch.object(rn.job, "Executor", FakeExecutor), \
                mock.patch.object(rn, "Filter"), mock.patch.object(rn.job, "log"):
            ex = rn.become_tenants("nitro")
        self.assertIs(ex, made[0])
        self.assertEqual(ex.opened, 1)

    def test_the_lock_comes_after_claim_and_tls(self):
        # Last, so the TLS libraries are mapped when MCL_CURRENT locks them (ADR-0074).
        from runner import runner as rn

        order = []

        class FakeSandbox:
            def __init__(self, *a, **kw):
                self.fingerprint = None
                self.boot_failed = threading.Event()
                self.executor = None

            def claim(self):
                order.append("claim")

        def stop_waiting(*a):
            raise SystemExit(0)

        env = {rn.BACKEND_ENV: "nitro", rn.wire.NONCE_HASH_ENV: "0" * 64}
        with mock.patch.dict(os.environ, env), mock.patch.object(rn, "own_process_setup"), \
                mock.patch.object(rn, "Sandbox", FakeSandbox), \
                mock.patch.object(rn, "tls_context", side_effect=lambda: (order.append("tls"), (None, b""))[1]), \
                mock.patch.object(rn.job, "lock_memory", side_effect=lambda: order.append("lock")), \
                mock.patch.object(rn.signal, "signal"), \
                mock.patch.object(rn, "serve", side_effect=lambda *a, **kw: order.append("serve")), \
                mock.patch.object(rn.job, "log"), mock.patch.object(rn.threading.Event, "wait", side_effect=stop_waiting):
            with self.assertRaises(SystemExit):
                rn.main()
        self.assertEqual(order, ["claim", "tls", "lock", "serve"])

    def test_a_refused_lock_ends_the_nitro_start(self):
        from runner import runner as rn

        class FakeSandbox:
            def __init__(self, *a, **kw):
                self.fingerprint = None

            def claim(self):
                pass

        env = {rn.BACKEND_ENV: "nitro", rn.wire.NONCE_HASH_ENV: "0" * 64}
        with mock.patch.dict(os.environ, env), mock.patch.object(rn, "own_process_setup"), \
                mock.patch.object(rn, "Sandbox", FakeSandbox), mock.patch.object(rn, "tls_context", return_value=(None, b"")), \
                mock.patch.object(rn.job, "lock_memory", side_effect=OSError(12, "mlockall")), \
                mock.patch.object(rn.signal, "signal"), \
                mock.patch.object(rn, "serve") as serve, mock.patch.object(rn.job, "log") as logged:
            self.assertEqual(rn.main(), 1)
        serve.assert_not_called()
        logged.assert_any_call("start_failed", error="OSError", errno=12)

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
        ex = jb.Executor(backend, size, f, uid=os.getuid() + 100000, **kw)
        self.addCleanup(lambda: [os.close(fd) for fd in ex._group_fds or ()])  # the watchdog's files, if it opened them
        return ex

    def test_nitro_watchdog_counts_without_page_cache(self):
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(2000 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file %d\nshmem %d\n" % (1500 * MIB, 10 * MIB))
        self.assertFalse(ex._above_l())  # 510 MiB counted, L = 768 MiB
        write(os.path.join(self.group, "memory.stat"), "file %d\nshmem %d\n" % (1500 * MIB, 300 * MIB))
        self.assertTrue(ex._above_l())  # 800 MiB counted

    def test_nitro_watchdog_opens_the_group_files_once(self):
        # Every poll reads the same open files (ADR-0074): no open, so no new allocation, while the group is full.
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file 0\nshmem 0\n")
        real_open = os.open
        with mock.patch.object(jb.os, "open", side_effect=real_open) as opened:
            self.assertFalse(ex._above_l())
            write(os.path.join(self.group, "memory.current"), str(800 * MIB))
            self.assertTrue(ex._above_l())  # the new value, read through the same descriptor
        self.assertEqual(opened.call_count, 2)

    def test_nitro_watchdog_files_open_at_claim_not_at_the_first_poll(self):
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file 0\nshmem 0\n")
        ex.open_watchdog()
        self.assertIsNotNone(ex._group_fds)
        with mock.patch.object(jb.os, "open") as opened:
            self.assertFalse(ex._above_l())
        opened.assert_not_called()

    def test_nitro_watchdog_open_failure_is_left_to_the_first_poll(self):
        ex = self.executor("nitro", task_group=os.path.join(self.group, "missing"))
        with mock.patch.object(jb, "log") as logged:
            ex.open_watchdog()  # no raise: the watchdog fails open, as before, and says so
        self.assertIsNone(ex._group_fds)
        logged.assert_called_once_with("watchdog_open_failed", error="FileNotFoundError")

    def test_nitro_watchdog_reopens_after_a_read_error(self):
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file 0\nshmem 0\n")
        ex.open_watchdog()
        with mock.patch.object(jb.os, "pread", side_effect=OSError(5, "EIO")):
            with self.assertRaises(OSError):
                ex._above_l()
        self.assertIsNone(ex._group_fds)
        self.assertFalse(ex._above_l())  # opened again

    def test_nitro_watchdog_closes_a_half_open_pair(self):
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))  # no memory.stat
        closed = []
        real_close = os.close
        with mock.patch.object(jb.os, "close", side_effect=lambda fd: (closed.append(fd), real_close(fd))):
            with self.assertRaises(FileNotFoundError):
                ex._above_l()
        self.assertEqual(len(closed), 1)
        self.assertIsNone(ex._group_fds)

    def test_nitro_watchdog_reads_a_long_memory_stat(self):
        # A memory.stat longer than one read is read whole, so shmem past the first chunk still counts.
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))
        padding = "".join("pad_%04d 0\n" % i for i in range(jb.GROUP_READ // 10 + 1))
        write(os.path.join(self.group, "memory.stat"), "file 0\n" + padding + "shmem %d\n" % (100 * MIB))
        self.assertGreater(os.path.getsize(os.path.join(self.group, "memory.stat")), jb.GROUP_READ)
        self.assertTrue(ex._above_l())  # 800 MiB counted, L = 768 MiB; one read would have counted 700

    def test_nitro_watchdog_serialises_its_files(self):
        # A monitor that outlives its job and the next one's take turns, so neither closes a pair the other reads.
        ex = self.executor("nitro", task_group=self.group)
        write(os.path.join(self.group, "memory.current"), str(700 * MIB))
        write(os.path.join(self.group, "memory.stat"), "file 0\nshmem 0\n")
        done = threading.Event()
        with ex._group_lock:
            t = threading.Thread(target=lambda: (ex._above_l(), done.set()))
            t.start()
            self.assertFalse(done.wait(0.2))  # waits for the lock
        t.join(2)
        self.assertTrue(done.is_set())

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


class SweepDeadlineTest(unittest.TestCase):
    def test_everything_after_a_job_shares_three_seconds(self):
        self.assertLessEqual(jb.POST_JOB_DEADLINE_S, 3.0)  # the tool waits timeoutMs + 5 s
        with tempfile.TemporaryDirectory() as d:
            ex = jb.Executor("microvm", sz.Sizing("microvm", 1024 * MIB), FakeFilter(), uid=os.getuid() + 100000, sweep_dirs=(d,))
            with mock.patch.object(jb.subprocess, "run") as run:
                self.assertFalse(ex.sweep(time.monotonic() - 1))  # nothing is left of the budget: no SysV sweep starts
                run.assert_not_called()
                run.return_value = mock.Mock(stdout=b"0")
                self.assertTrue(ex.sweep(time.monotonic() + 3))
                self.assertLessEqual(run.call_args.kwargs["timeout"], 3.0)


class PostJobBudgetTest(unittest.TestCase):
    """The kill, the sweep and the joins after a job share POST_JOB_DEADLINE_S (M-2)."""

    def executor(self):
        return jb.Executor("microvm", sz.Sizing("microvm", 1024 * MIB), FakeFilter(), uid=os.getuid() + 100000)

    def collect(self, ex, proc, readers, budget=0.3, timeout_ms=60000):
        job = mock.Mock(timeout_ms=timeout_ms, code=b"", input=b"")
        job.max_output = 10
        started = time.monotonic()
        threads = [mock.Mock(is_alive=mock.Mock(return_value=alive), data=b"", cut=False, join=mock.Mock()) for alive in readers]
        with mock.patch.object(jb, "POST_JOB_DEADLINE_S", budget), mock.patch.object(jb, "log"), \
                mock.patch.object(ex, "_oom_kills", return_value=0), mock.patch.object(ex, "_kill_group"):
            result = ex._collect(job, proc, started, 0, threads[0], threads[1], threads[2], threads[3], threading.Event())
        return result, threads

    def finished(self):
        proc = mock.Mock(returncode=0)
        proc.wait.return_value = 0
        return proc

    def test_the_sweep_gets_the_shared_deadline(self):
        ex = self.executor()
        with mock.patch.object(ex, "sweep", return_value=True) as sweep:
            before = time.monotonic()
            result, threads = self.collect(ex, self.finished(), [False] * 4)
        deadline = sweep.call_args.args[0]
        self.assertLessEqual(deadline - before, 0.4)
        self.assertTrue(result["clean"])
        self.assertFalse(result["dirty"])
        for t in threads:
            self.assertLessEqual(t.join.call_args.kwargs["timeout"], 0.3)  # what is left of the budget, not 5 s

    def test_a_reader_that_outlives_its_join_makes_the_sandbox_unclean(self):
        ex = self.executor()
        with mock.patch.object(ex, "sweep", return_value=True):
            result, _ = self.collect(ex, self.finished(), [False, True, False, False])
        self.assertFalse(result["clean"])

    def test_a_process_that_survives_the_kill_is_bounded_and_unclean(self):
        ex = self.executor()
        proc = mock.Mock(returncode=None)
        proc.wait.side_effect = [subprocess.TimeoutExpired("x", 1), subprocess.TimeoutExpired("x", 1)]
        with mock.patch.object(ex, "sweep", return_value=True):
            result, _ = self.collect(ex, proc, [False] * 4, timeout_ms=1000)
        self.assertEqual(proc.wait.call_args_list[1].kwargs["timeout"], 0.3)
        self.assertFalse(result["clean"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["exitCode"], -signal.SIGKILL)

    def test_the_kill_loop_ends_at_the_deadline(self):
        ex = self.executor()
        with mock.patch.object(ex, "_kill_uid", return_value=[4242]), mock.patch.object(jb, "reap"), mock.patch.object(jb, "log"):
            started = time.monotonic()
            self.assertFalse(ex.sweep(time.monotonic() + 0.1))
        self.assertLess(time.monotonic() - started, 1.0)


class SettledDirtyTest(unittest.TestCase):
    """agentcore: a group that drains a moment after the sweep is not dirty (spec 3.5 step 3)."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.ex = jb.Executor("agentcore", sz.Sizing("agentcore", 1024 * MIB), None, job_group=self.dir.name, uid=os.getuid() + 100000)
        write(os.path.join(self.dir.name, "memory.stat"), "file 0\nshmem 0\n")
        self.set_memory(100 * MIB)

    def set_memory(self, value):
        write(os.path.join(self.dir.name, "memory.current"), str(value))

    def drain_after(self, seconds):
        timer = threading.Timer(seconds, self.set_memory, args=(MIB,))
        timer.start()
        self.addCleanup(timer.cancel)

    def test_reclaimable_slab_alone_is_clean(self):
        # A disk fill's leftover: 215 MiB of reclaimable slab (dentries, inodes), no anon, no shmem.
        self.set_memory(215 * MIB)
        write(os.path.join(self.dir.name, "memory.stat"), "anon 0\nfile 0\nshmem 0\nslab %d\nslab_reclaimable %d\nslab_unreclaimable 0\n" % (215 * MIB, 215 * MIB))
        self.assertFalse(self.ex.dirty())

    def test_unreclaimable_slab_anon_or_shmem_of_32_mib_is_dirty(self):
        # SysV objects are charged as unreclaimable kernel memory (S-18); anon and shmem as themselves.
        for stat, current in (
            ("anon 0\nfile 0\nshmem 0\nslab %d\nslab_reclaimable 0\nslab_unreclaimable %d\n" % (32 * MIB, 32 * MIB), 32 * MIB),
            ("anon %d\nfile 0\nshmem 0\nslab 0\nslab_reclaimable 0\nslab_unreclaimable 0\n" % (32 * MIB), 32 * MIB),
            ("anon 0\nfile 0\nshmem %d\nslab 0\nslab_reclaimable 0\nslab_unreclaimable 0\n" % (32 * MIB), 0),
            ("anon 0\nfile 0\nshmem 0\nslab %d\nslab_reclaimable %d\nslab_unreclaimable %d\n" % (247 * MIB, 215 * MIB, 32 * MIB), 247 * MIB),
        ):
            with self.subTest(stat=stat):
                self.set_memory(current)
                write(os.path.join(self.dir.name, "memory.stat"), stat)
                self.assertTrue(self.ex.dirty())

    def test_a_group_clean_only_by_reclaimable_slab_logs_its_split(self):
        self.set_memory(215 * MIB)
        write(os.path.join(self.dir.name, "memory.stat"), "anon 0\nfile 0\nshmem 0\nslab %d\nslab_reclaimable %d\nslab_unreclaimable 0\n" % (215 * MIB, 215 * MIB))
        with mock.patch.object(jb, "log") as log:
            self.assertFalse(self.ex.settled_dirty(time.monotonic() + 3))
        log.assert_any_call("clean_by_reclaimable_slab", current_mib=215, counted_mib=0, anon_mib=0, file_mib=0, shmem_mib=0,
                            slab_mib=215, slab_reclaimable_mib=215, slab_unreclaimable_mib=0)

    def test_a_plainly_clean_group_logs_nothing(self):
        self.set_memory(MIB)
        with mock.patch.object(jb, "log") as log:
            self.assertFalse(self.ex.settled_dirty(time.monotonic() + 3))
        log.assert_not_called()

    def test_just_under_32_mib_after_reclaimable_slab_is_clean(self):
        self.set_memory(246 * MIB)
        write(os.path.join(self.dir.name, "memory.stat"), "anon 0\nfile 0\nshmem 0\nslab %d\nslab_reclaimable %d\nslab_unreclaimable %d\n" % (246 * MIB, 215 * MIB, 31 * MIB))
        self.assertFalse(self.ex.dirty())

    def test_a_dirty_group_logs_its_memory_split(self):
        write(os.path.join(self.dir.name, "memory.stat"), "anon 41943040\nfile 10485760\nshmem 2097152\nkernel 5242880\nslab 3145728\n")
        with mock.patch.object(jb, "DIRTY_POLL_S", 0.1), mock.patch.object(jb, "log") as log:
            self.assertTrue(self.ex.settled_dirty(time.monotonic() + 3))
        log.assert_any_call("dirty_group", current_mib=100, counted_mib=92, anon_mib=40, file_mib=10, shmem_mib=2, kernel_mib=5, slab_mib=3)

    def test_a_group_that_drains_after_a_delay_is_clean(self):
        self.assertTrue(self.ex.dirty())  # one read right after the sweep says dirty
        self.drain_after(0.3)
        started = time.monotonic()
        self.assertFalse(self.ex.settled_dirty(time.monotonic() + 3))
        self.assertGreaterEqual(time.monotonic() - started, 0.25)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_a_drain_slower_than_one_second_is_still_clean(self):
        # A group whose freed memory shows for more than 1 s is still clean, and the poll stops at the first clean read.
        # The budget is widened from 3 s to 6 s so a loaded build host that fires the timer late does not fail the
        # test; it failed once that way during a full build (2026-11-23).
        self.drain_after(1.3)
        started = time.monotonic()
        with mock.patch.object(jb, "DIRTY_POLL_S", 6.0):
            self.assertFalse(self.ex.settled_dirty(time.monotonic() + 6))
        self.assertGreaterEqual(time.monotonic() - started, 1.25)
        self.assertLess(time.monotonic() - started, 5.0)

    def test_a_group_that_stays_full_is_dirty_after_the_poll_time(self):
        with mock.patch.object(jb, "DIRTY_POLL_S", 0.2):
            started = time.monotonic()
            self.assertTrue(self.ex.settled_dirty(time.monotonic() + 3))
        self.assertGreaterEqual(time.monotonic() - started, 0.2)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_the_post_job_deadline_ends_the_poll(self):
        self.drain_after(0.5)
        started = time.monotonic()
        self.assertTrue(self.ex.settled_dirty(time.monotonic() + 0.1))
        self.assertLess(time.monotonic() - started, 0.4)

    def test_an_unreadable_group_is_dirty_at_once(self):
        os.unlink(os.path.join(self.dir.name, "memory.current"))
        with mock.patch.object(jb, "log"):
            started = time.monotonic()
            self.assertTrue(self.ex.settled_dirty(time.monotonic() + 3))
        self.assertLess(time.monotonic() - started, 0.3)

    def test_collect_polls_the_group_inside_the_post_job_budget(self):
        job = mock.Mock(timeout_ms=60000, code=b"", input=b"")
        job.max_output = 10
        proc = mock.Mock(returncode=0)
        proc.wait.return_value = 0
        threads = [mock.Mock(is_alive=mock.Mock(return_value=False), data=b"", cut=False, join=mock.Mock()) for _ in range(4)]
        seen = []
        real = self.ex.settled_dirty
        self.ex.settled_dirty = lambda deadline: (seen.append(deadline), real(deadline))[1]
        self.drain_after(0.3)
        with mock.patch.object(jb, "POST_JOB_DEADLINE_S", 2.0), mock.patch.object(jb, "log"), \
                mock.patch.object(self.ex, "_oom_kills", return_value=0), mock.patch.object(self.ex, "_kill_group"), \
                mock.patch.object(self.ex, "sweep", return_value=True):
            before = time.monotonic()
            result = self.ex._collect(job, proc, before, 0, *threads, threading.Event())
        self.assertIs(result["dirty"], False)  # the group drained during the poll
        self.assertLessEqual(seen[0] - before, 2.1)  # the deadline is the post-job one, not a later one
        self.assertGreaterEqual(seen[0] - before, 1.9)

    def test_another_backend_is_never_dirty_by_memory(self):
        ex = jb.Executor("microvm", sz.Sizing("microvm", 1024 * MIB), FakeFilter(), uid=os.getuid() + 100000)
        self.assertFalse(ex.settled_dirty(time.monotonic() + 3))


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

    def test_deadline_inside_one_flat_directory(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(2000):
                open(os.path.join(d, "f%d" % i), "w").close()
            clock = iter([0.0] * 3 + [100.0] * 10000)
            with mock.patch.object(jb.time, "monotonic", side_effect=lambda: next(clock)):
                count, done = jb.remove_owned(d, os.getuid(), 10.0)
            self.assertFalse(done)
            self.assertGreater(count, 0)
            self.assertLess(count, 2000)

    def test_empty_owned_directories_go_at_once(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(50):
                os.mkdir(os.path.join(d, "d%d" % i))
            self.assertEqual(jb.remove_owned(d, os.getuid(), time.monotonic() + 5), (50, True))


if __name__ == "__main__":
    unittest.main()
