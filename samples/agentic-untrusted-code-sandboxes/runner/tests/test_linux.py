# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The Linux parts of the runner, run as root in a privileged container on x86_64.

scripts/test-runner-docker.sh runs one class per fresh container, because
the agentcore class moves the test process into a /runner cgroup and the
microvm class locks /dev/shm. Without RUNNER_LINUX_TESTS=1 and root these
tests are skipped, and unittest reports them as skipped.
"""

import hashlib
import http.client
import json
import os
import platform
import socket
import ssl
import subprocess
import sys
import time
import unittest
import urllib.request

from runner import job as jb
from runner import seccomp, wire
from runner import sizing as sz
from runner.job import Executor, ToolFailed
from runner.seccomp import Filter

MIB = sz.MIB
ENABLED = os.environ.get("RUNNER_LINUX_TESTS") == "1" and hasattr(os, "geteuid") and os.geteuid() == 0
skip = unittest.skipUnless(ENABLED, "needs root in a privileged container: scripts/test-runner-docker.sh")
MACHINE = platform.machine()
# The job uid. RLIMIT_NPROC counts every task of a uid on the Docker host,
# not only in the container, so the script picks a uid nothing else uses;
# the runner entry tests still run jobs as the real 1001.
TEST_UID = int(os.environ.get("RUNNER_TEST_UID", str(jb.UID)))


def make_job(code, input_bytes=b"", timeout_ms=10000, max_output=262144):
    return wire.Job("run-1", "tenant-a", "", code.encode(), input_bytes, timeout_ms, max_output, "")


def run_json(executor, code, **kw):
    result = executor.run(make_job(code, **kw))
    if result["exitCode"] != 0:
        raise AssertionError("exit %s: %s" % (result["exitCode"], result["stderr"].decode()[-2000:]))
    return json.loads(result["stdout"].decode())


PROBE = r"""
import json, os, resource
limits = {n: resource.getrlimit(getattr(resource, "RLIMIT_" + n)) for n in ("CPU", "AS", "NPROC", "FSIZE", "NOFILE")}
status = dict(l.split(":", 1) for l in open("/proc/self/status").read().splitlines() if ":" in l)
print(json.dumps({"uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups(), "pgid": os.getpgid(0),
                  "pid": os.getpid(), "sid": os.getsid(0), "limits": limits, "cwd": os.getcwd(),
                  "seccomp": status["Seccomp"].strip(), "nnp": status["NoNewPrivs"].strip(),
                  "oom": open("/proc/self/oom_score_adj").read().strip(), "env": dict(os.environ),
                  "input": open("/work/input", "rb").read().hex(), "input_uid": os.stat("/work/input").st_uid}))
"""

CALLS = r"""
import ctypes, errno, json, os, socket, subprocess, threading
libc = ctypes.CDLL(None, use_errno=True)
out = {}
def check(name, fn):
    try:
        fn()
        out[name] = "ok"
    except OSError as e:
        out[name] = errno.errorcode.get(e.errno, str(e.errno))
def sysv(nr_name, *args):
    rc = libc.syscall(NR[nr_name], *args)
    if rc < 0:
        raise OSError(ctypes.get_errno(), nr_name)
NR = %s
check("memfd_create", lambda: os.close(os.memfd_create("x")))
check("socket_unix", lambda: socket.socket(socket.AF_UNIX).close())
check("socket_inet", lambda: socket.socket(socket.AF_INET).close())
check("socketpair", lambda: [s.close() for s in socket.socketpair()])
def listen(n):
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(n); s.close()
check("listen_5", lambda: listen(5))
check("listen_9", lambda: listen(9))
check("sndbuf", lambda: socket.socket().setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20))
check("reuseaddr", lambda: socket.socket().setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1))
check("semget", lambda: sysv("semget", 0, 1, 0o600))
check("shmget", lambda: sysv("shmget", 0, 4096, 0o600))
check("unshare_user", lambda: sysv("unshare", 0x10000000))
def thread():
    t = threading.Thread(target=lambda: None); t.start(); t.join()
check("thread", thread)
check("subprocess", lambda: subprocess.run(["/bin/true"], check=True))
def fork():
    p = os.fork()
    if p == 0:
        os._exit(0)
    os.waitpid(p, 0)
check("fork", fork)
print(json.dumps(out))
"""


def calls_code():
    return CALLS % json.dumps(seccomp.SYSCALLS[MACHINE])


class Base(unittest.TestCase):
    backend = "agentcore"

    def setUp(self):
        jb.prepare_work(uid=TEST_UID)
        self.addCleanup(lambda: self.assertFalse(jb.uid_pids(TEST_UID) + jb.uid_pids(jb.UID), "a job process outlived the job"))


@skip
class MicrovmLinux(Base):
    backend = "microvm"

    def executor(self, m=4000 * MIB):
        return Executor("microvm", sz.Sizing("microvm", m), Filter("microvm", MACHINE), uid=TEST_UID)

    def test_identity_limits_and_filter(self):
        p = run_json(self.executor(), PROBE, input_bytes=b"\x00in\xff", timeout_ms=2500)
        self.assertEqual((p["uid"], p["gid"], p["groups"]), (TEST_UID, TEST_UID, []))
        self.assertEqual((p["pgid"], p["sid"]), (p["pid"], p["pid"]))
        self.assertEqual(p["limits"], {"CPU": [3, 3], "AS": [256 * MIB] * 2, "NPROC": [9, 9],
                                       "FSIZE": [100 * MIB] * 2, "NOFILE": [64, 64]})
        self.assertEqual((p["cwd"], p["seccomp"], p["nnp"], p["oom"]), ("/work", "2", "1", "1000"))
        self.assertEqual(p["env"], {"PATH": jb.JOB_PATH, "HOME": "/work", "TMPDIR": "/work/tmp",
                                    "LANG": "C.UTF-8", "MALLOC_ARENA_MAX": "2"})
        self.assertEqual((p["input"], p["input_uid"]), ("00696eff", TEST_UID))

    def test_blocked_and_allowed_calls(self):
        jb.lock_dev_shm()
        try:
            out = run_json(self.executor(), calls_code())
        finally:
            os.chmod("/dev/shm", 0o1777)
        for name in ("memfd_create", "socket_unix", "listen_9", "sndbuf", "semget", "shmget", "unshare_user"):
            self.assertEqual(out[name], "EPERM", name)
        for name in ("socket_inet", "socketpair", "listen_5", "reuseaddr", "thread", "subprocess", "fork"):
            self.assertEqual(out[name], "ok", name)

    def test_dev_shm_locked(self):
        jb.lock_dev_shm()
        try:
            r = self.executor().run(make_job("import multiprocessing; multiprocessing.Lock()"))
        finally:
            os.chmod("/dev/shm", 0o1777)
        self.assertNotEqual(r["exitCode"], 0)
        self.assertIn(b"PermissionError", r["stderr"])

    def test_allow_all_filter_fails_closed(self):
        real = seccomp.program
        seccomp.program = lambda backend, machine: [seccomp._ret(seccomp.RET_ALLOW)]
        try:
            fake = Filter("microvm", MACHINE)
        finally:
            seccomp.program = real
        marker = "/work/ran"
        if os.path.exists(marker):
            os.unlink(marker)
        with self.assertRaises(ToolFailed):
            Executor("microvm", sz.Sizing("microvm", 4000 * MIB), fake, uid=TEST_UID).run(make_job("open('/work/ran','w')"))
        self.assertFalse(os.path.exists(marker))

    def test_zombies_are_reaped_and_the_next_job_forks(self):
        ex = self.executor()
        leave = "import os, time\nfor _ in range(8):\n    if os.fork() == 0:\n        os._exit(0)\ntime.sleep(0.3)\n"
        self.assertEqual(ex.run(make_job(leave))["exitCode"], 0)
        again = "import os\nkids=[]\nfor _ in range(8):\n    p = os.fork()\n    if p == 0:\n        os._exit(0)\n    kids.append(p)\nfor p in kids:\n    os.waitpid(p, 0)\nprint(len(kids))\n"
        r = ex.run(make_job(again))
        self.assertEqual((r["exitCode"], r["stdout"].strip()), (0, b"8"), r["stderr"])


@skip
class NitroLinux(Base):
    backend = "nitro"

    def executor(self, m=2048 * MIB, group=None):
        return Executor("nitro", sz.Sizing("nitro", m), Filter("nitro", MACHINE), task_group=group, uid=TEST_UID)

    def test_sysv_filtered_others_open(self):
        out = run_json(self.executor(), calls_code())
        for name in ("semget", "shmget"):
            self.assertEqual(out[name], "EPERM", name)
        for name in ("memfd_create", "socket_unix", "listen_9", "sndbuf", "thread", "subprocess"):
            self.assertEqual(out[name], "ok", name)

    def test_limits(self):
        p = run_json(self.executor(), PROBE)
        self.assertEqual(p["limits"]["AS"], [(2048 - 256 - 64) * MIB] * 2)
        self.assertEqual((p["limits"]["NPROC"], p["limits"]["NOFILE"]), ([64, 64], [256, 256]))
        self.assertNotIn("MALLOC_ARENA_MAX", p["env"])

    def test_watchdog_marks_then_kills(self):
        with open("/proc/self/cgroup", encoding="ascii") as f:
            group = jb.own_cgroup_dir(f.read())
        used = sz.counted(jb.read_text(os.path.join(group, "memory.current")),
                          jb.read_text(os.path.join(group, "memory.stat")))
        m = used + 256 * MIB + 150 * MIB  # L = what the group holds now + 150 MiB
        fill = ("import os, time\nfor _ in range(4):\n    if os.fork() == 0:\n        b = []\n"
                "        for _ in range(12):\n            b.append(bytearray(5 << 20)); time.sleep(0.05)\n"
                "        time.sleep(30)\n        os._exit(0)\ntime.sleep(30)\n")
        r = self.executor(m, group).run(make_job(fill, timeout_ms=20000))
        self.assertTrue(r["memoryExceeded"])
        self.assertFalse(r["timedOut"])
        self.assertEqual(r["exitCode"], -9)

    def test_runner_entry_tls_hello_and_job(self):
        nonce = os.urandom(32)
        env = {"PATH": jb.JOB_PATH, wire.NONCE_HASH_ENV: wire.nonce_hash(nonce), "RUNNER_BACKEND": "nitro"}
        proc = subprocess.Popen([sys.executable, "-I", os.environ.get("RUNNER_ENTRY", "/opt/runner/runner.py")],
                                env=env, stderr=subprocess.PIPE)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        client = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client.check_hostname = False
        client.verify_mode = ssl.CERT_NONE
        deadline = time.monotonic() + 15
        while True:
            try:
                socket.create_connection(("127.0.0.1", 8443), timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        conn = http.client.HTTPSConnection("127.0.0.1", 8443, timeout=20, context=client)
        challenge = os.urandom(32)
        conn.request("POST", "/hello", json.dumps({"v": 1, "nonce": wire.b64url(nonce), "challenge": wire.b64url(challenge)}),
                     {"Content-Type": "application/json"})
        hello = json.loads(conn.getresponse().read())
        peer = hashlib.sha256(conn.sock.getpeercert(binary_form=True)).digest()
        self.assertEqual(hello["certFingerprint"], peer.hex())
        self.assertEqual(hello["proof"], wire.hello_proof(nonce, challenge, peer))
        self.assertEqual(conn.sock.version(), "TLSv1.3")
        code = "import os, json; print(json.dumps(sorted(os.environ)))"
        body = {"v": 1, "runId": "r1", "tenantId": "tenant-a", "nonce": wire.b64url(nonce), "code": code,
                "timeoutMs": 5000, "maxOutputBytes": 4096,
                "jobAuth": wire.job_auth(nonce, "r1", "tenant-a", code.encode(), b"")}
        conn.request("POST", "/run", json.dumps(body), {"Content-Type": "application/json"})
        result = json.loads(conn.getresponse().read())
        self.assertEqual(result["exitCode"], 0, result)
        self.assertNotIn(wire.NONCE_HASH_ENV, json.loads(result["stdout"]))
        self.assertNotIn("RUNNER_BACKEND", json.loads(result["stdout"]))
        self.assertEqual(result["proof"], wire.result_proof(nonce, "r1"))
        self.assertEqual(result["bootId"], hello["bootId"])
        conn.close()


@skip
class AgentcoreLinux(Base):
    """No filter; the job group bounds memory. Moves this test process into /runner."""

    def executor(self, l_bytes=None):
        self.job_group = getattr(AgentcoreLinux, "job_group", None)
        if l_bytes is not None or self.job_group is None:
            with open("/proc/self/cgroup", encoding="ascii") as f:
                root = jb.own_cgroup_dir(f.read())
            AgentcoreLinux.job_group = self.job_group = jb.prepare_agentcore_groups(root, l_bytes or 300 * MIB)
        size = sz.Sizing("agentcore", 300 * MIB + sz.RUNNER_MARGIN)
        return Executor("agentcore", size, None, job_group=self.job_group, uid=TEST_UID)

    def test_group_setup(self):
        ex = self.executor(300 * MIB)
        root = os.path.dirname(self.job_group)
        self.assertIn(str(os.getpid()), jb.read_text(os.path.join(root, "runner", "cgroup.procs")).split())
        self.assertEqual(jb.read_text(os.path.join(root, "memory.oom.group")).strip(), "0")
        self.assertEqual(jb.read_text(os.path.join(self.job_group, "memory.oom.group")).strip(), "1")
        self.assertEqual(int(jb.read_text(os.path.join(self.job_group, "memory.max"))), 300 * MIB)
        code = "print(open('/proc/self/cgroup').read().strip())"
        r = ex.run(make_job(code))
        self.assertTrue(r["stdout"].decode().strip().endswith("/job"), r["stdout"])
        self.assertFalse(ex.dirty())

    def test_kernel_kill_in_the_job_group_is_marked_and_the_runner_lives(self):
        ex = self.executor()
        fill = ("import os, time\nfor _ in range(3):\n    if os.fork() == 0:\n        b = []\n"
                "        for _ in range(40):\n            b.append(bytearray(5 << 20))\n        time.sleep(30)\n"
                "time.sleep(30)\n")
        r = ex.run(make_job(fill, timeout_ms=20000))
        self.assertTrue(r["memoryExceeded"])
        self.assertFalse(r["timedOut"])
        self.assertFalse(ex.dirty())
        self.assertEqual(ex.run(make_job("print(1)"))["stdout"], b"1\n")

    def test_sysv_tmp_and_shm_swept_work_kept(self):
        ex = self.executor()
        nr = seccomp.SYSCALLS[MACHINE]
        code = ("import ctypes, os\nlibc = ctypes.CDLL(None)\n"
                "for _ in range(50):\n    libc.syscall(%d, 0, 1, 0o600)\n    libc.syscall(%d, 0, 4096, 0o600)\n"
                "    libc.syscall(%d, 0, 0o600)\n"
                "open('/tmp/left', 'w').write('x')\nos.mkdir('/tmp/d')\nopen('/tmp/d/f', 'w').write('x')\n"
                "open('/dev/shm/left', 'wb').write(b'x' * (8 << 20))\nopen('/work/kept', 'w').write('x')\n"
                "os.symlink('/etc/passwd', '/work/input.link')\n"
                % (nr["semget"], nr["shmget"], nr["msgget"]))
        self.assertEqual(ex.run(make_job(code))["exitCode"], 0)
        for name in ("msg", "sem", "shm"):
            with open("/proc/sysvipc/" + name, encoding="ascii") as f:
                lines = f.read().splitlines()
            uid = lines[0].split().index("uid")
            self.assertEqual([l for l in lines[1:] if l.split()[uid] == str(TEST_UID)], [], name)
        for gone in ("/tmp/left", "/tmp/d", "/dev/shm/left"):
            self.assertFalse(os.path.lexists(gone), gone)
        self.assertTrue(os.path.exists("/work/kept"))
        self.assertFalse(ex.dirty())

    def test_input_link_cannot_redirect_the_write(self):
        ex = self.executor()
        if os.path.lexists("/work/input"):
            os.unlink("/work/input")
        os.symlink("/etc/hostname", "/work/input")
        os.lchown("/work/input", TEST_UID, TEST_UID)
        before = open("/etc/hostname", "rb").read()
        r = ex.run(make_job("print(open('/work/input','rb').read())", input_bytes=b"new"))
        self.assertEqual(r["stdout"], b"b'new'\n")
        self.assertEqual(open("/etc/hostname", "rb").read(), before)
        self.assertFalse(os.path.islink("/work/input"))

    def test_timeout_survivors_output_and_exit_codes(self):
        ex = self.executor()
        r = ex.run(make_job("while True: pass", timeout_ms=1500))
        self.assertEqual((r["timedOut"], r["exitCode"]), (True, -9))
        self.assertGreaterEqual(r["durationMs"], 1500)
        self.assertLess(r["durationMs"], 4000)
        bg = "import os, time\nif os.fork() == 0:\n    os.setsid()\n    if os.fork() == 0:\n        time.sleep(100)\n    os._exit(0)\nprint('done')\n"
        r = ex.run(make_job(bg))
        self.assertEqual((r["exitCode"], r["stdout"]), (0, b"done\n"))
        self.assertEqual(jb.uid_pids(TEST_UID), [])
        r = ex.run(make_job("import sys; sys.stdout.write('o' * (1 << 20)); sys.stderr.write('e' * 10)", max_output=1000))
        self.assertTrue(r["cut"])
        self.assertEqual((len(r["stdout"]), r["stderr"]), (1000, b"e" * 10))
        self.assertEqual(ex.run(make_job("import sys; sys.exit(7)"))["exitCode"], 7)
        self.assertEqual(ex.run(make_job("import os; os.kill(os.getpid(), 15)"))["exitCode"], -15)
        self.assertEqual(ex.run(make_job("import os; os.write(1, b'\\0x')"))["stdout"], b"\x00x")  # NUL in output
        r = ex.run(make_job("x = 1\0"))
        self.assertNotEqual(r["exitCode"], 0)  # NUL in code is the code's own SyntaxError, not a runner fault

@skip
class AgentcoreEntryLinux(Base):
    """The runner entry in agentcore mode, in a fresh container.

    The test process leaves the root cgroup first, as on AgentCore, where
    the runner is the only process when it moves itself into /runner.
    """

    def setUp(self):
        super().setUp()
        with open("/proc/self/cgroup", encoding="ascii") as f:
            root = jb.own_cgroup_dir(f.read())
        self.root = root
        os.makedirs(os.path.join(root, "test"), exist_ok=True)
        jb.write_text(os.path.join(root, "test", "cgroup.procs"), str(os.getpid()))

    def test_session_job(self):
        nonce = os.urandom(32)
        env = {"PATH": jb.JOB_PATH, "RUNNER_BACKEND": "agentcore"}
        procs = os.path.join(self.root, "cgroup.procs")
        proc = subprocess.Popen([sys.executable, "-I", os.environ.get("RUNNER_ENTRY", "/opt/runner/runner.py")], env=env,
                                preexec_fn=lambda: jb.write_text(procs, "0"))  # the runner starts in the root group
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        deadline = time.monotonic() + 15
        while True:
            try:
                ping = json.loads(urllib.request.urlopen("http://127.0.0.1:8080/ping", timeout=1).read())
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        self.assertEqual(ping, {"status": "Healthy"})
        code = "print('hi')"
        body = {"v": 1, "runId": "r1", "tenantId": "tenant-a", "nonce": wire.b64url(nonce), "code": code,
                "timeoutMs": 5000, "maxOutputBytes": 4096,
                "jobAuth": wire.job_auth(nonce, "r1", "tenant-a", code.encode(), b"")}
        req = urllib.request.Request("http://127.0.0.1:8080/invocations", json.dumps(body).encode(),
                                     {"Content-Type": "application/json", wire.SESSION_HEADER: wire.session_id("tenant-a")})
        result = json.loads(urllib.request.urlopen(req, timeout=20).read())
        self.assertEqual((result["exitCode"], result["stdout"]), (0, "hi\n"), result)
        self.assertEqual(result["proof"], wire.result_proof(nonce, "r1"))


@skip
class MicrovmEntryLinux(Base):
    """The runner entry in microvm mode. It is not PID 1 here; it is a child subreaper, so orphans still come to it."""

    def test_hook_then_job(self):
        nonce = os.urandom(32)
        env = {"PATH": jb.JOB_PATH, "RUNNER_BACKEND": "microvm"}
        proc = subprocess.Popen([sys.executable, "-I", os.environ.get("RUNNER_ENTRY", "/opt/runner/runner.py")], env=env)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        deadline = time.monotonic() + 15
        while True:
            try:
                ping = json.loads(urllib.request.urlopen("http://127.0.0.1:8080/ping", timeout=1).read())
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        self.assertEqual(ping, {"status": "Healthy"})
        hook = json.dumps({"nonceHash": wire.nonce_hash(nonce), "tenant": "tenant-a"}).encode()
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9000/run", hook), timeout=10).read()
        self.assertIn("bootId", json.loads(urllib.request.urlopen("http://127.0.0.1:8080/ping", timeout=5).read()))
        code = "import os; print(oct(os.stat('/dev/shm').st_mode & 0o777), open('/proc/self/status').read().count('Seccomp:\\t2'))"
        body = {"v": 1, "runId": "r1", "tenantId": "tenant-a", "nonce": wire.b64url(nonce), "code": code,
                "timeoutMs": 5000, "maxOutputBytes": 4096,
                "jobAuth": wire.job_auth(nonce, "r1", "tenant-a", code.encode(), b"")}
        req = urllib.request.Request("http://127.0.0.1:8080/run", json.dumps(body).encode(), {"Content-Type": "application/json"})
        result = json.loads(urllib.request.urlopen(req, timeout=20).read())
        self.assertEqual((result["exitCode"], result["stdout"]), (0, "0o755 1\n"), result)


if __name__ == "__main__":
    unittest.main()

