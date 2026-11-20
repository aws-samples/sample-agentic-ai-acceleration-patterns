# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Adoption order, refusals and the HTTP surface, with a fake executor (no root, no Linux limits)."""

import base64
import hashlib
import http.client
import json
import os
import shutil
import socket
import ssl
import threading
import unittest

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
        while not fake.jobs:
            pass
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
            conn.close()
            stop(srv)

    def test_microvm_ports_and_chunked(self):
        sb, _ = make("microvm")
        jobs, hooks = free_port(), free_port()
        srv = [server.serve(sb, jobs, "jobs", host="127.0.0.1"), server.serve(sb, hooks, "hooks", host="127.0.0.1")]
        try:
            self.assertEqual(self.post(jobs, "/run", json.dumps(signed(NONCE)))[0], 403)
            self.assertEqual(self.post(hooks, "/suspend", "{}"), (200, {}))
            hook = {"nonceHash": wire.nonce_hash(NONCE), "tenant": JOB["tenantId"]}
            self.assertEqual(self.post(hooks, "/run", json.dumps(hook)), (200, {}))
            self.assertEqual(self.post(hooks, "/invocations", "{}")[0], 404)
            self.assertEqual(self.post(jobs, "/hello", "{}")[0], 404)
            conn = http.client.HTTPConnection("127.0.0.1", jobs, timeout=5)
            raw = json.dumps(signed(NONCE)).encode()
            conn.request("POST", "/run", body=iter([raw[:7], raw[7:]]), encode_chunked=True,
                         headers={"Transfer-Encoding": "chunked"})
            resp = conn.getresponse()
            self.assertEqual((resp.status, json.loads(resp.read())["exitCode"]), (200, 3))
            status, body = self.post(jobs, "/run", "x" * 10, {"Content-Length": str(wire.MAX_BODY_BYTES + 1)})
            self.assertEqual((status, body["error"]), (400, "tool_failed"))
        finally:
            conn.close()
            stop(*srv)

    @unittest.skipUnless(shutil.which("openssl"), "no openssl on this host")
    def test_nitro_tls_hello_then_job_on_one_connection(self):
        from runner.runner import tls_context
        sb, _ = make("nitro")
        context, sb.fingerprint = tls_context()
        port = free_port()
        srv = server.serve(sb, port, "jobs", host="127.0.0.1", tls=context)
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
            conn.close()
            stop(srv)


if __name__ == "__main__":
    unittest.main()
