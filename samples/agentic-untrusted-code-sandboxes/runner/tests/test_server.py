# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Adoption order, refusals and the HTTP surface, with a fake executor (no root, no Linux limits)."""

import base64
import hashlib
import http.client
import io
import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

from runner import server, wire
from runner.job import ToolFailed

VECTORS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "protocol", "vectors.json")
with open(VECTORS, encoding="utf-8") as _f:
    V = json.load(_f)
CASE = V["cases"][0]
NONCE = bytes.fromhex(CASE["nonceHex"])
JOB = CASE["expected"]["job"]
OTHER_NONCE = bytes(range(100, 132))


def signed(nonce: bytes, run_id: str = JOB["runId"], tenant: str = JOB["tenantId"], **change) -> dict:
    job = dict(JOB, runId=run_id, tenantId=tenant, nonce=wire.b64url(nonce), **change)
    raw = base64.b64decode(job["input"]) if "input" in job else b""
    job["jobAuth"] = wire.job_auth(nonce, run_id, tenant, job["code"].encode(), raw)
    return job


class FakeExecutor:
    def __init__(self):
        self.jobs = []
        self.gate = None
        self.fail = False
        self.left_dirty = False
        self.unswept = False

    def run(self, job):
        self.jobs.append(job)
        if self.gate:
            self.gate.wait(5)
        if self.fail:
            raise ToolFailed()
        return {"exitCode": 3, "stdout": b"x" * 10, "stderr": b"e", "cut": False, "durationMs": 5,
                "timedOut": False, "memoryExceeded": False, "clean": not self.unswept}

    def dirty(self):
        return self.left_dirty


def make(backend, claimed=True):
    fake = FakeExecutor()
    sb = server.Sandbox(backend, lambda: fake,
                        nonce_hash=wire.nonce_hash(NONCE) if backend == "nitro" else None)
    if claimed and backend == "nitro":
        sb.claim()
    return sb, fake


def run(sb, job, session=None):
    return sb.run(json.dumps(job).encode(), session)


SESSION = wire.session_id(JOB["tenantId"])


class AgentcoreTest(unittest.TestCase):
    def test_forged_job_auth_pins_nothing(self):
        sb, fake = make("agentcore")
        forged = dict(signed(NONCE), jobAuth=V["negative"]["flipTenant"])
        self.assertEqual(run(sb, forged, SESSION)[1]["error"], "wrong_sandbox")
        self.assertIsNone(sb.nonce)
        self.assertIsNone(sb.boot_id)
        # A genuine job under another nonce is still adopted afterwards.
        status, body = run(sb, signed(OTHER_NONCE), SESSION)
        self.assertEqual(status, 200)
        self.assertEqual(body["proof"], wire.result_proof(OTHER_NONCE, JOB["runId"]))
        self.assertEqual(len(body["bootId"]), 32)
        self.assertEqual(sb.nonce, OTHER_NONCE)

    def test_session_must_match_tenant(self):
        sb, fake = make("agentcore")
        for session in (None, "", wire.session_id("tenant-b"), SESSION.upper()):
            self.assertEqual(run(sb, signed(NONCE), session)[1]["error"], "wrong_sandbox")
        self.assertEqual(fake.jobs, [])
        self.assertIsNone(sb.nonce)

    def test_holds_one_nonce(self):
        sb, fake = make("agentcore")
        self.assertEqual(run(sb, signed(NONCE), SESSION)[0], 200)
        boot = sb.boot_id
        self.assertEqual(run(sb, signed(NONCE, run_id="r2"), SESSION)[0], 200)  # idempotent adoption
        self.assertEqual(sb.boot_id, boot)
        status, body = run(sb, signed(OTHER_NONCE), SESSION)
        self.assertEqual((status, body["error"], body["bootId"]), (403, "wrong_sandbox", boot))
        self.assertEqual(len(fake.jobs), 2)

    def test_claim_failure_is_tool_failed_and_keeps_nothing(self):
        def broken():
            raise OSError("cgroup")
        sb = server.Sandbox("agentcore", broken)
        self.assertEqual(run(sb, signed(NONCE), SESSION), (500, {"v": 1, "error": "tool_failed"}))
        self.assertIsNone(sb.nonce)

    def test_microvm_claim_failure_ends_the_start(self):
        def broken():
            raise OSError("cgroup")
        sb = server.Sandbox("microvm", broken)
        hook = json.dumps({"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]}).encode()
        self.assertEqual(sb.hook(hook), (200, {}))
        self.assertTrue(sb.boot_failed.is_set())  # the runner exits and the MicroVM start fails at once
        self.assertEqual(run(sb, signed(NONCE))[1]["error"], "tool_failed")

    def test_dirty_after_a_job_that_did_not_drain(self):
        sb, fake = make("agentcore")
        fake.left_dirty = True
        self.assertEqual(run(sb, signed(NONCE), SESSION)[0], 200)
        self.assertEqual(run(sb, signed(NONCE), SESSION)[1]["error"], "dirty")
        self.assertEqual(len(fake.jobs), 1)


class HashBackendsTest(unittest.TestCase):
    def test_microvm_refuses_before_the_hook(self):
        sb, fake = make("microvm")
        self.assertEqual(run(sb, signed(NONCE))[1]["error"], "wrong_sandbox")
        self.assertNotIn("bootId", sb.ping())
        hook = json.dumps({"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]}).encode()
        self.assertEqual(sb.hook(b"{}"), (400, {}))
        self.assertEqual(sb.hook(hook), (200, {}))
        boot = sb.ping()["bootId"]
        self.assertEqual(sb.hook(json.dumps({"nonceHash": wire.nonce_hash(OTHER_NONCE), "tenant": "x"}).encode()), (200, {}))
        self.assertEqual(sb.nonce_hash, wire.nonce_hash(NONCE))  # later hooks change nothing
        self.assertEqual(sb.ping()["bootId"], boot)
        self.assertEqual(run(sb, signed(OTHER_NONCE))[1]["error"], "wrong_sandbox")
        self.assertEqual(run(sb, signed(NONCE, tenant="tenant-b"))[1]["error"], "wrong_sandbox")
        status, body = run(sb, signed(NONCE))
        self.assertEqual((status, body["exitCode"], body["bootId"]), (200, 3, boot))
        self.assertFalse(sb.boot_failed.is_set())

    def test_microvm_fail_at_boot_hook(self):
        hook = {"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]}
        for value in (False, "true", 1, None):
            sb, _ = make("microvm")
            self.assertEqual(sb.hook(json.dumps(dict(hook, failAtBoot=value)).encode()), (200, {}))
            self.assertFalse(sb.boot_failed.is_set(), value)
            self.assertEqual(sb.nonce_hash, hook["nonceHash"])
        for body in (dict(hook, failAtBoot=True), {"microvmId": "m", "runHookPayload": json.dumps(dict(hook, failAtBoot=True))}):
            sb, fake = make("microvm")
            self.assertEqual(sb.hook(json.dumps(body).encode()), (200, {}))
            self.assertTrue(sb.boot_failed.is_set())
            self.assertIsNone(sb.nonce_hash)
            self.assertEqual(sb.hook(json.dumps(hook).encode()), (200, {}))  # nothing claims it afterwards
            self.assertIsNone(sb.nonce_hash)
            self.assertNotIn("bootId", sb.ping())
            self.assertEqual(run(sb, signed(NONCE))[1]["error"], "wrong_sandbox")
            self.assertEqual(fake.jobs, [])

    def test_microvm_wrapped_hook_payload(self):
        payload = json.dumps({"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]})
        for bad in ({"runHookPayload": None}, {"runHookPayload": "not json"}, {"runHookPayload": "[]"},
                    {"runHookPayload": json.dumps({"tenant": "a"})}):
            sb, _ = make("microvm")
            self.assertEqual(sb.hook(json.dumps(bad).encode()), (400, {}), bad)
            self.assertIsNone(sb.nonce_hash)
        sb, _ = make("microvm")
        self.assertEqual(sb.hook(json.dumps({"microvmId": "m", "runHookPayload": payload}).encode()), (200, {}))
        self.assertEqual((sb.nonce_hash, sb.hook_tenant), (wire.nonce_hash(NONCE), JOB["tenantId"]))


    def test_nitro_hash_and_job_auth(self):
        sb, fake = make("nitro")
        self.assertEqual(run(sb, signed(OTHER_NONCE))[0], 403)
        bad = dict(signed(NONCE), jobAuth=V["negative"]["flipRunId"])
        self.assertEqual(run(sb, bad)[0], 403)
        self.assertIsNone(sb.nonce)
        for text in V["mustRefuseNonce"].values():
            if text != V["mustRefuseNonce"]["note"]:
                self.assertEqual(run(sb, dict(signed(NONCE), nonce=text))[0], 403)
        self.assertEqual(run(sb, signed(NONCE))[0], 200)
        self.assertEqual(fake.jobs[0].input, b"hello\n")

    def test_malformed_busy_tool_failed_and_unswept(self):
        sb, fake = make("nitro")
        self.assertEqual(sb.run(b"{nope"), (400, {"v": 1, "error": "tool_failed", "bootId": sb.boot_id}))
        fake.gate = threading.Event()
        first = threading.Thread(target=run, args=(sb, signed(NONCE)))
        first.start()
        deadline = time.monotonic() + 5
        while not fake.jobs and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertEqual(run(sb, signed(NONCE, run_id="r2"))[:1], (409,))
        fake.gate.set()
        first.join()
        fake.gate = None
        fake.fail = True
        self.assertEqual(run(sb, signed(NONCE))[1]["error"], "tool_failed")
        fake.fail = False
        fake.unswept = True
        self.assertEqual(run(sb, signed(NONCE))[0], 200)
        self.assertEqual(run(sb, signed(NONCE))[:1], (410,))

    def test_output_cut_in_result(self):
        sb, fake = make("nitro")
        _, body = run(sb, signed(NONCE, maxOutputBytes=4))
        self.assertEqual((body["stdout"], body["stderr"], body["truncated"]), ("xxx", "e", True))

    def test_hello(self):
        sb, _ = make("nitro")
        sb.fingerprint = bytes.fromhex(V["hello"]["certFingerprint"])
        req = {"v": 1, "nonce": V["hello"]["nonce"], "challenge": V["hello"]["challenge"]}
        status, body = sb.hello(json.dumps(req).encode())
        self.assertEqual((status, body["proof"], body["certFingerprint"]),
                         (200, V["hello"]["expected"]["proof"], V["hello"]["certFingerprint"]))
        for bad in (dict(req, challenge=V["mustRefuseChallenge"]["short"]), dict(req, nonce=wire.b64url(OTHER_NONCE))):
            self.assertEqual(sb.hello(json.dumps(bad).encode())[0], 403)
        self.assertEqual(sb.hello(b"[]")[0], 400)


class EntryTest(unittest.TestCase):
    """runner.py exits 1 at boot with RUNNER_FAIL_AT_BOOT=1 on nitro and agentcore, or without a known backend."""

    def start(self, env):
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return subprocess.run([sys.executable, "-I", os.path.join(root, "runner", "runner.py")], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=20)

    def test_fail_at_boot(self):
        for backend in ("nitro", "agentcore"):
            done = self.start({"RUNNER_BACKEND": backend, "RUNNER_FAIL_AT_BOOT": "1",
                               wire.NONCE_HASH_ENV: wire.nonce_hash(NONCE)})
            self.assertEqual(done.returncode, 1, backend)
            self.assertIn(b"fail_at_boot", done.stderr)

    def test_unknown_backend(self):
        for env in ({}, {"RUNNER_BACKEND": "lambda"}):
            done = self.start(env)
            self.assertEqual(done.returncode, 1)
            self.assertIn(b"bad_backend", done.stderr)


def stop(*servers):
    for srv in servers:
        srv.shutdown()
        srv.server_close()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HttpTest(unittest.TestCase):
    def post(self, port, path, body, headers=None, conn=None):
        own = conn is None
        conn = conn or http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", path, body=body, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
        resp = conn.getresponse()
        answer = resp.status, json.loads(resp.read() or b"{}")
        if own:
            conn.close()
        return answer

    def test_agentcore_invocations_always_200(self):
        sb, _ = make("agentcore")
        port = free_port()
        srv = server.serve(sb, port, "jobs", host="127.0.0.1")
        conn = None
        try:
            status, body = self.post(port, "/invocations", json.dumps(signed(NONCE)))
            self.assertEqual((status, body["error"]), (200, "wrong_sandbox"))
            status, body = self.post(port, "/invocations", "{bad")
            self.assertEqual((status, body["error"]), (200, "tool_failed"))
            status, body = self.post(port, "/invocations", json.dumps(signed(NONCE)), {wire.SESSION_HEADER: SESSION})
            self.assertEqual((status, body["exitCode"]), (200, 3))
            self.assertEqual(self.post(port, "/run", "{}")[0], 404)
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/ping")
            self.assertEqual(json.loads(conn.getresponse().read())["bootId"], sb.boot_id)
        finally:
            if conn is not None:
                conn.close()
            stop(srv)

    def test_microvm_ports_and_chunked(self):
        sb, _ = make("microvm")
        jobs, hooks = free_port(), free_port()
        srv = [server.serve(sb, jobs, "jobs", host="127.0.0.1"), server.serve(sb, hooks, "hooks", host="127.0.0.1")]
        conn = None
        try:
            self.assertEqual(self.post(jobs, "/run", json.dumps(signed(NONCE)))[0], 403)
            for prefix in ("/", server.HOOK_PREFIX):
                for name in ("ready", "suspend", "resume", "terminate"):
                    self.assertEqual(self.post(hooks, prefix + name, "{}"), (200, {}), prefix + name)
                self.assertEqual(self.post(hooks, prefix + "nope", "{}")[0], 404)
            self.assertIsNone(sb.nonce_hash)
            payload = json.dumps({"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]})
            wrapped = json.dumps({"microvmId": "mvm-1", "runHookPayload": payload})
            self.assertEqual(self.post(hooks, server.HOOK_PREFIX + "run", wrapped), (200, {}))
            self.assertEqual(sb.nonce_hash, wire.nonce_hash(NONCE))
            self.assertEqual(self.post(hooks, "/run", payload), (200, {}))  # later hooks change nothing
            self.assertEqual(self.post(hooks, "/invocations", "{}")[0], 404)
            self.assertEqual(self.post(hooks, "/aws/lambda-microvms/runtime/v2/run", "{}")[0], 404)
            self.assertEqual(self.post(jobs, "/hello", "{}")[0], 404)
            self.assertEqual(self.post(jobs, server.HOOK_PREFIX + "run", "{}")[0], 404)  # no hooks on the job port
            conn = http.client.HTTPConnection("127.0.0.1", jobs, timeout=5)
            raw = json.dumps(signed(NONCE)).encode()
            conn.request("POST", "/run", body=iter([raw[:7], raw[7:]]), encode_chunked=True,
                         headers={"Transfer-Encoding": "chunked"})
            resp = conn.getresponse()
            self.assertEqual((resp.status, json.loads(resp.read())["exitCode"]), (200, 3))
            status, body = self.post(jobs, "/run", "x" * 10, {"Content-Length": str(wire.MAX_BODY_BYTES + 1)})
            self.assertEqual((status, body["error"]), (400, "tool_failed"))
        finally:
            if conn is not None:
                conn.close()
            stop(*srv)

    @unittest.skipUnless(os.path.exists("/usr/bin/openssl") and hasattr(os, "memfd_create"), "no /usr/bin/openssl or no os.memfd_create")
    def test_nitro_tls_hello_then_job_on_one_connection(self):
        from runner.runner import tls_context
        sb, _ = make("nitro")
        context, sb.fingerprint = tls_context()
        port = free_port()
        srv = server.serve(sb, port, "jobs", host="127.0.0.1", tls=context)
        conn = None
        try:
            client = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            client.check_hostname = False
            client.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=client)
            challenge = os.urandom(32)
            status, body = self.post(port, "/hello", json.dumps(
                {"v": 1, "nonce": wire.b64url(NONCE), "challenge": wire.b64url(challenge)}), conn=conn)
            peer = hashlib.sha256(conn.sock.getpeercert(binary_form=True)).digest()
            self.assertEqual(status, 200)
            self.assertEqual(body["certFingerprint"], peer.hex())
            self.assertEqual(body["proof"], wire.hello_proof(NONCE, challenge, peer))
            sock = conn.sock
            status, body = self.post(port, "/run", json.dumps(signed(NONCE)), conn=conn)
            self.assertIs(conn.sock, sock)  # the job rode the checked connection
            self.assertEqual((status, body["proof"]), (200, wire.result_proof(NONCE, JOB["runId"])))
        finally:
            if conn is not None:
                conn.close()
            stop(srv)


class LimitsTest(unittest.TestCase):
    def raw(self, port, data, read=True):
        with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
            s.sendall(data)
            return s.recv(4096) if read else b""

    def test_chunk_sizes_and_bounds(self):
        sb, fake = make("nitro")
        port = free_port()
        srv = server.serve(sb, port, "jobs", host="127.0.0.1")
        try:
            head = b"POST /run HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n"
            for size in (b"-1", b"+5", b"0x5", b"5_0", b"FFFFFFFF", b"123456789", b""):
                answer = self.raw(port, head + size + b"\r\n" + b"x" * 64)
                self.assertIn(b" 400 ", answer.split(b"\r\n")[0], size)
            answer = self.raw(port, b"POST /run HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n")
            self.assertIn(b" 400 ", answer.split(b"\r\n")[0])
            answer = self.raw(port, b"POST /run HTTP/1.1\r\nHost: x\r\nContent-Length: \xb2\r\n\r\n")
            self.assertIn(b" 400 ", answer.split(b"\r\n")[0])  # a digit to isdigit(), not to int()
            self.assertEqual(fake.jobs, [])
        finally:
            stop(srv)

    def test_trickled_body_is_cut_at_the_deadline(self):
        sb, _ = make("microvm")
        port = free_port()
        srv = server.serve(sb, port, "hooks", host="127.0.0.1")
        try:
            with mock.patch.object(server, "BODY_DEADLINE_S", 0.5):
                for head in (b"POST /run HTTP/1.1\r\nHost: x\r\nContent-Length: 12\r\n\r\n",
                             b"POST /run HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nc\r\n"):
                    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                        started = time.monotonic()
                        s.sendall(head)
                        answer = b""
                        for _ in range(12):
                            try:
                                s.sendall(b"x")
                            except OSError:
                                break
                            time.sleep(0.2)
                            s.setblocking(False)
                            try:
                                answer += s.recv(4096)
                            except BlockingIOError:
                                pass
                            s.setblocking(True)
                            if answer:
                                break
                        self.assertIn(b" 400 ", answer.split(b"\r\n")[0], head)
                        self.assertLess(time.monotonic() - started, 1.5)
            self.assertIsNone(sb.nonce_hash)
        finally:
            stop(srv)

    def test_trickled_framing_and_headers_are_cut(self):
        sb, _ = make("microvm")
        port = free_port()
        srv = server.serve(sb, port, "hooks", host="127.0.0.1")
        head = b"POST /run HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n"
        cases = (head,  # then a chunk-size line, one byte at a time
                 head + b"2\r\n{}\r\n0\r\n",  # then a trailer line
                 b"POST /run HTTP/1.1\r\nX-Slow: ")  # a header line
        try:
            with mock.patch.object(server, "BODY_DEADLINE_S", 0.5), mock.patch.object(server, "HEADER_DEADLINE_S", 0.5):
                for start in cases:
                    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                        started = time.monotonic()
                        s.sendall(start)
                        ended = False
                        while time.monotonic() - started < 3:
                            try:
                                s.sendall(b"a")
                            except OSError:
                                ended = True
                                break
                            s.settimeout(0.2)
                            try:
                                s.recv(4096)
                                ended = True  # an answer, or the close (b"")
                                break
                            except socket.timeout:
                                pass
                            except OSError:
                                ended = True
                                break
                        self.assertTrue(ended, start)
                        self.assertLess(time.monotonic() - started, 1.5, start)
            self.assertIsNone(sb.nonce_hash)
        finally:
            stop(srv)

    def test_slow_body_outlives_the_header_clock(self):
        sb, _ = make("microvm")
        port = free_port()
        srv = server.serve(sb, port, "hooks", host="127.0.0.1")
        body = json.dumps({"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]}).encode()
        try:
            with mock.patch.object(server, "HEADER_DEADLINE_S", 0.3):
                with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                    s.sendall(b"POST /run HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(body))
                    time.sleep(0.8)  # past the header clock: the body has its own deadline
                    s.sendall(body)
                    self.assertTrue(s.recv(4096).startswith(b"HTTP/1.1 200"))
            self.assertEqual(sb.nonce_hash, wire.nonce_hash(NONCE))
        finally:
            stop(srv)

    def test_trickled_chunk_crlf_is_cut(self):
        sb, _ = make("microvm")
        port = free_port()
        srv = server.serve(sb, port, "hooks", host="127.0.0.1")
        try:
            with mock.patch.object(server, "BODY_DEADLINE_S", 0.3):
                with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                    s.sendall(b"POST /run HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}")
                    start = time.monotonic()
                    s.settimeout(0.2)
                    got = None
                    while time.monotonic() - start < 3 and got is None:
                        try:
                            s.sendall(b"\r")  # one byte per 0.2 s: four of them would outlast the deadline
                            got = s.recv(4096)
                        except socket.timeout:
                            pass
                        except OSError:
                            got = b""
                    self.assertIsNotNone(got)
                    self.assertLess(time.monotonic() - start, 0.45)  # one byte per read: 0.3 s; readline(4): 0.6 s
            self.assertIsNone(sb.nonce_hash)
        finally:
            stop(srv)

    def test_read_body_restores_the_handler_timeout(self):
        class Conn:
            def __init__(self):
                self.timeouts = []

            def settimeout(self, value):
                self.timeouts.append(value)

        class Fake:
            timeout = 10
            headers = {"Content-Length": "3"}

            def __init__(self):
                self.rfile = io.BufferedReader(io.BytesIO(b"abc"))
                self.connection = Conn()

        fake = Fake()
        self.assertEqual(server.read_body(fake), b"abc")
        self.assertLess(fake.connection.timeouts[0], server.BODY_DEADLINE_S + 0.01)
        self.assertEqual(fake.connection.timeouts[-1], 10)

    def test_bodiless_hooks_are_answered_and_the_job_port_refuses_an_empty_body(self):
        sb, _ = make("microvm")
        jobs, hooks = free_port(), free_port()
        srv = [server.serve(sb, jobs, "jobs", host="127.0.0.1"), server.serve(sb, hooks, "hooks", host="127.0.0.1")]
        try:
            for prefix in ("/", server.HOOK_PREFIX):
                for name in ("ready", "suspend", "resume", "terminate"):
                    bare = b"POST " + (prefix + name).encode() + b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
                    self.assertIn(b" 200 ", self.raw(hooks, bare).split(b"\r\n")[0], prefix + name)
            self.assertIn(b" 404 ", self.raw(hooks, b"POST /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").split(b"\r\n")[0])
            self.assertIn(b" 400 ", self.raw(hooks, b"POST /run HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").split(b"\r\n")[0])
            self.assertIsNone(sb.nonce_hash)
            for value in (b"identity", b"gzip, chunked", b"chunked, identity", b"bogus"):
                second = b"POST /terminate HTTP/1.1\r\nHost: x\r\n\r\n"
                answer = self.raw(hooks, b"POST /ready HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: " + value + b"\r\n\r\n" + second)
                self.assertIn(b" 400 ", answer.split(b"\r\n")[0], value)
                self.assertEqual(answer.count(b"HTTP/1.1 "), 1, value)
            with socket.create_connection(("127.0.0.1", hooks), timeout=5) as s:
                s.sendall(b"POST /suspend HTTP/1.1\r\nHost: x\r\n\r\nPOST /resume HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                answer = b""
                while answer.count(b"HTTP/1.1 200") < 2:
                    piece = s.recv(4096)
                    if not piece:
                        break
                    answer += piece
                self.assertEqual(answer.count(b"HTTP/1.1 200"), 2)
            for head in (b"", b"Content-Length: 0\r\n"):
                answer = self.raw(jobs, b"POST /run HTTP/1.1\r\nHost: x\r\nConnection: close\r\n" + head + b"\r\n")
                self.assertIn(b" 400 ", answer.split(b"\r\n")[0], head)
        finally:
            stop(*srv)

    def test_hook_body_cap(self):
        sb, _ = make("microvm")
        port = free_port()
        srv = server.serve(sb, port, "hooks", host="127.0.0.1")
        try:
            big = b"POST /run HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % (server.MAX_HOOK_BODY_BYTES + 1)
            self.assertIn(b" 400 ", self.raw(port, big).split(b"\r\n")[0])
        finally:
            stop(srv)

    def test_connections_past_the_cap_are_closed(self):
        sb, _ = make("agentcore")
        port = free_port()
        srv = server.serve(sb, port, "jobs", host="127.0.0.1")
        held = []
        try:
            for _ in range(server.MAX_CONNECTIONS):
                held.append(socket.create_connection(("127.0.0.1", port), timeout=5))
            time.sleep(0.2)
            with socket.create_connection(("127.0.0.1", port), timeout=5) as extra:
                extra.sendall(b"GET /ping HTTP/1.1\r\nHost: x\r\n\r\n")
                self.assertEqual(extra.recv(4096), b"")  # closed before a byte was read
            for s in held:
                s.close()
            held = []
            time.sleep(0.2)
            answer = self.raw(port, b"GET /ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            self.assertIn(b" 200 ", answer.split(b"\r\n")[0])
        finally:
            for s in held:
                s.close()
            stop(srv)

    def test_runner_fault_is_tool_failed_and_dirty(self):
        sb, fake = make("agentcore")
        port = free_port()
        fake.run = lambda job: (_ for _ in ()).throw(RuntimeError("can't start new thread"))
        srv = server.serve(sb, port, "jobs", host="127.0.0.1")
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("POST", "/invocations", json.dumps(signed(NONCE)), {wire.SESSION_HEADER: SESSION})
            resp = conn.getresponse()
            self.assertEqual((resp.status, json.loads(resp.read())["error"]), (200, "tool_failed"))
            conn.close()
            self.assertTrue(sb.dirty)
        finally:
            stop(srv)

    def test_tool_failed_carries_the_sweep(self):
        sb, fake = make("nitro")
        fake.run = lambda job: (_ for _ in ()).throw(ToolFailed(clean=False))
        self.assertEqual(run(sb, signed(NONCE))[1]["error"], "tool_failed")
        self.assertTrue(sb.dirty)
        sb, fake = make("nitro")
        fake.run = lambda job: (_ for _ in ()).throw(ToolFailed(clean=True))
        run(sb, signed(NONCE))
        self.assertFalse(sb.dirty)

    def test_version_type_and_deep_json(self):
        for v in (True, 1.0, "1"):
            with self.assertRaises(wire.Malformed):
                wire.parse_job(json.dumps(dict(JOB, v=v)).encode())
        deep = b"[" * 100000 + b"]" * 100000
        with self.assertRaises(wire.Malformed):
            wire.parse_job(deep)
        sb, _ = make("microvm")
        self.assertEqual(sb.hook(deep), (400, {}))


if __name__ == "__main__":
    unittest.main()
