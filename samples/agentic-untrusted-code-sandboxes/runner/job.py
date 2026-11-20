# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Run one job as uid 1001 and sweep after it (spec §3.5 steps 1 to 4, ADR-0010, ADR-0019 to ADR-0022).

Needs root and Linux; the Docker test (scripts/test-runner-docker.sh)
exercises it. Python 3.9 compatible.
"""

from __future__ import annotations

import ctypes
import errno
import os
import resource
import secrets
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Callable, List, Optional, Tuple

from runner import sizing as sz
from runner.seccomp import Filter

UID = 1001
WORK = "/work"
SWEEP_DIRS = ("/tmp", "/dev/shm")  # nosec B108 - the sweep deletes uid 1001 files here (spec 3.5 step 3)
CGROUP_ROOT = "/sys/fs/cgroup"
SWEEP_DEADLINE_S = 5.0
# One budget for everything after a job ends: the kill, the sweep and the thread joins (M-2).
# The tool waits timeoutMs + 5 s, so the answer comes with 2 s to spare.
POST_JOB_DEADLINE_S = 3.0
READ_CHUNK = 65536
CPU_LIMIT_SLACK_MS = 100
PR_SET_NO_NEW_PRIVS = 38
JOB_PATH = "/usr/local/bin:/usr/bin:/bin"

# Runs as uid 1001 with no filter: removes every SysV object uid 1001 owns
# or created. The root runner on microvm may not (no CAP_SYS_ADMIN, S-17).
SYSV_SWEEP = r"""
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
removed = 0
for name, ctl in (("msg", libc.msgctl), ("sem", libc.semctl), ("shm", libc.shmctl)):
    try:
        with open("/proc/sysvipc/" + name) as f:
            lines = f.read().splitlines()
    except OSError:
        continue
    head = lines[0].split()
    uid, cuid = head.index("uid"), head.index("cuid")
    for line in lines[1:]:
        cols = line.split()
        if int(cols[uid]) == %d or int(cols[cuid]) == %d:
            rc = ctl(int(cols[1]), 0, 0) if name == "sem" else ctl(int(cols[1]), 0, None)
            removed += rc == 0
print(removed)
"""


class ToolFailed(Exception):
    """A runner fault: the job answer is tool_failed, never an exit code.

    clean is the result of the sweep after the fault; False marks the sandbox dirty.
    """

    def __init__(self, clean: bool = True):
        super().__init__("tool_failed")
        self.clean = clean


def cpu_seconds(timeout_ms: int) -> int:
    """RLIMIT_CPU = runTimeout, rounded up to whole seconds."""
    return max(1, -(-timeout_ms // 1000))


def cpu_limit_hit(returncode: int, memory_exceeded: bool, duration_ms: int, timeout_ms: int) -> bool:
    """RLIMIT_CPU ended the job at about runTimeout: report it as timedOut (ADR-0038).

    CPU time starts at fork, before the wall timer, so for a CPU-bound job
    the kernel's SIGKILL at the hard limit often comes first.
    """
    return (returncode in (-signal.SIGKILL, -signal.SIGXCPU) and not memory_exceeded
            and duration_ms >= timeout_ms - CPU_LIMIT_SLACK_MS)


def log(event: str, **sizes: object) -> None:
    """The runner logs only events, sizes, exit codes and durations, never code, input or output."""
    parts = " ".join("%s=%s" % (k, v) for k, v in sorted(sizes.items()))
    sys.stderr.write("runner %s %s\n" % (event, parts))
    sys.stderr.flush()


def read_text(path: str) -> str:
    with open(path, encoding="ascii") as f:
        return f.read()


def write_text(path: str, text: str) -> None:
    with open(path, "w", encoding="ascii") as f:
        f.write(text)


def uid_pids(uid: int = UID) -> List[int]:
    """Every process of uid (real id), zombies included."""
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/status" % name, encoding="ascii", errors="replace") as f:
                for line in f:
                    if line.startswith("Uid:"):
                        if int(line.split()[1]) == uid:
                            pids.append(int(name))
                        break
        except (OSError, ValueError):
            continue
    return pids


def reap() -> None:
    """waitpid(-1, WNOHANG) until no exited child is left (the runner is PID 1 or a subreaper)."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def remove_owned(top: str, uid: int, deadline: float) -> Tuple[int, bool]:
    """Delete every entry uid owns under top, never following links, streaming each directory.

    Returns the count and whether the walk finished before deadline.
    shortcut: a path-based walk, safe only because no uid process is alive
    while it runs; use dir_fd-relative calls if that ever changes.
    """
    removed, seen = 0, 0
    stack = [(top, False)]
    while stack:
        if time.monotonic() > deadline:
            return removed, False
        path, children_done = stack.pop()
        if children_done:
            if path != top:
                try:
                    if os.lstat(path).st_uid == uid:
                        os.rmdir(path)
                        removed += 1
                except OSError:
                    pass
            continue
        stack.append((path, True))
        try:
            entries = os.scandir(path)
        except OSError:
            continue
        with entries:
            for entry in entries:
                seen += 1
                if seen % 256 == 0 and time.monotonic() > deadline:
                    return removed, False
                try:
                    st = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(st.st_mode):
                        if st.st_uid == uid:
                            try:
                                os.rmdir(entry.path)  # an empty one goes at once, so none is held in memory
                                removed += 1
                                continue
                            except OSError:
                                pass
                        stack.append((entry.path, False))
                    elif st.st_uid == uid:
                        os.unlink(entry.path)
                        removed += 1
                except OSError:
                    continue
    return removed, True


class Collector(threading.Thread):
    """Reads one pipe, keeps the first limit bytes and counts the rest."""

    def __init__(self, pipe, limit: int):
        super().__init__(daemon=True)
        self.pipe, self.limit = pipe, limit
        self.data = bytearray()
        self.cut = False

    def run(self) -> None:
        fd = self.pipe.fileno()
        while True:
            try:
                chunk = os.read(fd, READ_CHUNK)
            except OSError:
                return
            if not chunk:
                return
            room = self.limit - len(self.data)
            if len(chunk) > room:
                self.cut = True
            if room > 0:
                self.data += chunk[:room]


class Executor:
    """Runs jobs for one sandbox. backend: microvm, nitro or agentcore."""

    def __init__(self, backend: str, sizing: sz.Sizing, job_filter: Optional[Filter],
                 task_group: Optional[str] = None, job_group: Optional[str] = None,
                 work: str = WORK, sweep_dirs=SWEEP_DIRS, uid: int = UID, python: str = sys.executable):
        if backend in ("microvm", "nitro") and job_filter is None:
            raise ValueError("a filter is required on " + backend)
        self.backend = backend
        self.sizing = sizing
        self.filter = job_filter
        self.task_group = task_group  # nitro: the task's cgroup directory
        self.job_group = job_group  # agentcore: the job cgroup directory
        self.work = work
        self.sweep_dirs = sweep_dirs
        self.uid = uid
        self.python = python
        self._exceeded = threading.Event()
        self._libc = ctypes.CDLL(None, use_errno=True)

    # Step 1 and 2: the job child.

    def _limits(self, timeout_ms: int):
        """The limits the child sets before the drop; RLIMIT_NOFILE and RLIMIT_AS come last (ADR-0038)."""
        s = self.sizing
        return ((resource.RLIMIT_CPU, cpu_seconds(timeout_ms)), (resource.RLIMIT_NPROC, s.n),
                (resource.RLIMIT_FSIZE, sz.FSIZE))

    def _preexec(self, input_bytes: bytes, timeout_ms: int) -> Callable[[], None]:
        limits = self._limits(timeout_ms)
        last = ((resource.RLIMIT_NOFILE, (self.sizing.nofile, self.sizing.nofile)),
                (resource.RLIMIT_AS, (self.sizing.a, self.sizing.a)))
        uid = self.uid
        procs = os.path.join(self.job_group, "cgroup.procs") if self.job_group else None
        job_filter = self.filter
        prctl = self._libc.prctl
        input_path = os.path.join(self.work, "input")
        aside = input_path + ".old-" + secrets.token_hex(4)
        tmp = os.path.join(self.work, "tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW

        def child() -> None:
            # Runs between fork and exec in a threaded process: system calls
            # and objects prepared above only, no imports, no logging, no locks.
            # shortcut: Python code in preexec_fn; a single-threaded root helper
            # that execs the job would remove the fork hazard, if one ever shows.
            fd = os.open("/proc/self/oom_score_adj", os.O_WRONLY)
            os.write(fd, b"1000")
            os.close(fd)
            if procs:
                fd = os.open(procs, os.O_WRONLY)
                os.write(fd, b"0")
                os.close(fd)
            for res, value in limits:
                resource.setrlimit(res, (value, value))
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            os.umask(0o077)
            # No setuid binary of the image can give the job root back, on every backend.
            if prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
                raise OSError(errno.EPERM, "no_new_privs")
            # The input is written as uid 1001, so a link the code left in
            # /work cannot point a root write elsewhere.
            try:
                os.unlink(input_path)
            except FileNotFoundError:
                pass
            except IsADirectoryError:
                os.rename(input_path, aside)
            fd = os.open(input_path, flags, 0o600)
            view = memoryview(input_bytes)
            while view:
                view = view[os.write(fd, view):]
            os.close(fd)
            try:
                os.mkdir(tmp, 0o700)
            except FileExistsError:
                pass
            if job_filter is not None:
                job_filter.install()
            # RLIMIT_NOFILE and RLIMIT_AS come last (ADR-0038): this child is a
            # fork of the runner, which can hold more descriptors and more
            # address space than the job may, until exec. soft = hard, so code
            # cannot raise them.
            for res, value in last:
                resource.setrlimit(res, value)

        return child

    def _env(self) -> dict:
        env = {"PATH": JOB_PATH, "HOME": self.work, "TMPDIR": os.path.join(self.work, "tmp"), "LANG": "C.UTF-8"}
        if self.backend == "microvm":
            env["MALLOC_ARENA_MAX"] = "2"
        return env

    def _oom_kills(self) -> int:
        group = self.job_group if self.backend == "agentcore" else self.task_group if self.backend == "nitro" else None
        if not group:
            return 0
        try:
            return sz.flat_keyed(read_text(os.path.join(group, "memory.events"))).get("oom_kill", 0)
        except OSError:
            return 0

    def run(self, job) -> dict:
        """Steps 1 to 4. Returns the result fields; raises ToolFailed for a runner fault."""
        self._exceeded.clear()
        oom_before = self._oom_kills()
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                [self.python, "-I", "-S", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=self.work, env=self._env(), start_new_session=True,
                preexec_fn=self._preexec(job.input, job.timeout_ms), close_fds=True)
        except (OSError, subprocess.SubprocessError) as e:
            # The filter self-test and every other child failure land here,
            # before any tenant code ran.
            log("job_start_failed", error=type(e).__name__)
            raise ToolFailed(self.sweep()) from e
        try:
            return self._finish(job, proc, started, oom_before)
        except ToolFailed:
            raise
        except BaseException as e:  # a thread that would not start, or any other runner fault
            log("job_failed", error=type(e).__name__)
            self._kill_group(proc.pid)
            clean = self.sweep()
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except OSError:
                    pass
            raise ToolFailed(clean) from e

    def _finish(self, job, proc, started: float, oom_before: int) -> dict:
        out = Collector(proc.stdout, job.max_output)
        err = Collector(proc.stderr, job.max_output)
        writer = threading.Thread(target=self._feed, args=(proc, job.code), daemon=True)
        done = threading.Event()
        monitor = threading.Thread(target=self._monitor, args=(proc.pid, done), daemon=True)
        for t in (out, err, writer, monitor):
            t.start()
        try:
            return self._collect(job, proc, started, oom_before, out, err, writer, monitor, done)
        finally:
            done.set()  # the monitor never outlives this job

    def _collect(self, job, proc, started, oom_before, out, err, writer, monitor, done) -> dict:
        timed_out = False
        stuck = False
        try:
            proc.wait(timeout=job.timeout_ms / 1000.0)
            deadline = time.monotonic() + POST_JOB_DEADLINE_S
        except subprocess.TimeoutExpired:
            timed_out = True
            deadline = time.monotonic() + POST_JOB_DEADLINE_S
            self._kill_group(proc.pid)
            try:
                proc.wait(timeout=POST_JOB_DEADLINE_S)
            except subprocess.TimeoutExpired:
                stuck = True  # a process that survives SIGKILL (uninterruptible sleep): the sandbox is not clean
        duration_ms = int((time.monotonic() - started) * 1000)
        done.set()
        self._kill_group(proc.pid)
        clean = self.sweep(deadline) and not stuck
        for t in (out, err, writer, monitor):
            t.join(timeout=max(0.0, deadline - time.monotonic()))
        # A reader still running after its join was cut short: the sandbox is not clean, and the pipes stay open for it.
        alive = any(t.is_alive() for t in (out, err, writer, monitor))
        clean = clean and not alive
        if not alive:  # shortcut: a live reader keeps its pipe open (a leaked fd), because the sandbox is replaced as dirty
            for pipe in (proc.stdout, proc.stderr):
                pipe.close()
        returncode = proc.returncode if proc.returncode is not None else -signal.SIGKILL
        exceeded = self._exceeded.is_set() or self._oom_kills() > oom_before
        timed_out = timed_out or cpu_limit_hit(returncode, exceeded, duration_ms, job.timeout_ms)
        log("job_done", code_bytes=len(job.code), input_bytes=len(job.input), stdout_bytes=len(out.data),
            stderr_bytes=len(err.data), exit_code=returncode, duration_ms=duration_ms,
            timed_out=timed_out, memory_exceeded=exceeded, clean=clean)
        return {"exitCode": returncode, "stdout": bytes(out.data), "stderr": bytes(err.data),
                "cut": out.cut or err.cut, "durationMs": duration_ms, "timedOut": timed_out,
                "memoryExceeded": exceeded, "clean": clean}

    @staticmethod
    def _feed(proc, code: bytes) -> None:
        try:
            proc.stdin.write(code)
        except OSError:
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    # Memory: the microvm floor and the nitro watchdog.

    def _monitor(self, pgid: int, done: threading.Event) -> None:
        if self.backend == "microvm":
            poll, over = sz.MICROVM_FLOOR_POLL_S, self._below_floor
        elif self.backend == "nitro" and self.task_group:
            poll, over = sz.NITRO_WATCHDOG_POLL_S, self._above_l
        else:
            return
        while not done.wait(poll):
            try:
                hit = over()
            except (OSError, ValueError, KeyError):
                continue
            if hit:
                # Record first, then kill: a job killed here is always marked (S-20).
                self._exceeded.set()
                self._kill_group(pgid)
                self._kill_uid()
                return

    def _below_floor(self) -> bool:
        return sz.meminfo(read_text("/proc/meminfo"))["MemAvailable"] < sz.MICROVM_FLOOR

    def _above_l(self) -> bool:
        group = self.task_group or ""
        used = sz.counted(read_text(os.path.join(group, "memory.current")), read_text(os.path.join(group, "memory.stat")))
        return used > self.sizing.l

    # Step 3: kill, sweep and reap.

    @staticmethod
    def _kill_group(pgid: int) -> None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def _kill_uid(self) -> List[int]:
        if self.job_group:
            try:
                write_text(os.path.join(self.job_group, "cgroup.kill"), "1")
            except OSError:
                pass
        pids = uid_pids(self.uid)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        return pids

    def sweep(self, deadline: Optional[float] = None) -> bool:
        """Kill every uid 1001 process, delete its files in /tmp and /dev/shm, remove its SysV objects, reap.

        With deadline (a monotonic time) all three steps share it; without, each step has its own
        SWEEP_DEADLINE_S. Returns False when uid 1001 processes outlived the deadline or a step
        did not finish.
        """
        kill_deadline = deadline if deadline is not None else time.monotonic() + SWEEP_DEADLINE_S
        # With the budget spent, the kill loop may exit on no pids; the walk and the SysV step then give
        # False, so a cut sweep is never clean.
        while True:
            pids = self._kill_uid()
            reap()
            if not pids:
                break
            if time.monotonic() > kill_deadline:
                log("sweep_incomplete", processes=len(pids))
                return False
            time.sleep(0.005)
        files, walked = 0, True
        walk_deadline = deadline if deadline is not None else time.monotonic() + SWEEP_DEADLINE_S  # one budget for every directory
        for top in self.sweep_dirs:
            if os.path.isdir(top):
                count, done = remove_owned(top, self.uid, walk_deadline)
                files, walked = files + count, walked and done
        sysv = self._sweep_sysv(deadline)
        reap()
        log("sweep", files=files, sysv=sysv, walked=walked)
        return walked and sysv >= 0 and not uid_pids(self.uid)

    def _sweep_sysv(self, deadline: Optional[float] = None) -> int:
        timeout = SWEEP_DEADLINE_S if deadline is None else deadline - time.monotonic()
        if timeout <= 0:
            log("sysv_sweep_failed")
            return -1
        try:
            done = subprocess.run([self.python, "-I", "-S", "-c", SYSV_SWEEP % (self.uid, self.uid)], user=self.uid, group=self.uid,
                                  extra_groups=[], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env={"PATH": JOB_PATH}, cwd="/",
                                  timeout=timeout, check=True)
            return int(done.stdout.decode("ascii").strip() or "0")
        except (OSError, subprocess.SubprocessError, ValueError):
            log("sysv_sweep_failed")
            return -1

    def dirty(self) -> bool:
        """agentcore: the job group still holds 32 MiB or more after the sweep (spec §3.5 step 3)."""
        if self.backend != "agentcore" or not self.job_group:
            return False
        g = self.job_group
        return sz.counted(read_text(os.path.join(g, "memory.current")),
                          read_text(os.path.join(g, "memory.stat"))) >= sz.AGENTCORE_DIRTY

    def kill_all(self) -> None:
        """On SIGTERM: end any job. No reap here: a job thread may still be in Popen.wait()."""
        self._kill_uid()


def prepare_work(work: str = WORK, uid: int = UID) -> None:
    """/work owned by uid 1001, made when the sandbox becomes one tenant's, before any uid 1001 process exists."""
    try:
        st = os.lstat(work)
    except FileNotFoundError:
        os.mkdir(work, 0o700)
        st = os.lstat(work)
    if not stat.S_ISDIR(st.st_mode):
        raise OSError(errno.ENOTDIR, work)
    os.chown(work, uid, uid)
    os.chmod(work, 0o700)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions - owner only


def lock_dev_shm(path: str = "/dev/shm") -> None:  # nosec B108
    """microvm: /dev/shm not writable by uid 1001, so the 60 % budget holds without counting tmpfs (spec §3.5 mounts)."""
    if not os.path.isdir(path):
        return
    st = os.stat(path)
    if st.st_uid != 0:
        os.chown(path, 0, 0)
    # Removes write for everyone but root; read and search stay, as for any system directory.
    os.chmod(path, 0o755)  # nosec B103  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions


def own_cgroup_dir(proc_self_cgroup: str, root: str = CGROUP_ROOT) -> str:
    path = sz.cgroup_path(proc_self_cgroup)
    return os.path.normpath(root + path) if path != "/" else root


def task_memory_max(group: str, root: str = CGROUP_ROOT) -> Optional[int]:
    """The nearest memory.max that is not 'max', from the task group up to the visible root."""
    path = group
    while True:
        try:
            value = sz.memory_max(read_text(os.path.join(path, "memory.max")))
            if value is not None:
                return value
        except OSError:
            pass
        if os.path.normpath(path) == os.path.normpath(root):
            return None
        path = os.path.dirname(path)


def prepare_agentcore_groups(root: str, l_bytes: int) -> str:
    """Move the runner into /runner, enable memory, root memory.oom.group 0, a job group with memory.max L.

    Returns the job group directory. Run once, at the session's first job.
    """
    runner_group = os.path.join(root, "runner")
    job_group = os.path.join(root, "job")
    for path in (runner_group, job_group):
        try:
            os.mkdir(path)
        except FileExistsError:
            pass
    write_text(os.path.join(runner_group, "cgroup.procs"), str(os.getpid()))
    write_text(os.path.join(root, "cgroup.subtree_control"), "+memory")
    write_text(os.path.join(root, "memory.oom.group"), "0")
    write_text(os.path.join(job_group, "memory.max"), str(l_bytes))
    write_text(os.path.join(job_group, "memory.oom.group"), "1")
    return job_group
