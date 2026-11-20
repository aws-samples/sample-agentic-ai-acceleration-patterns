# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The runner's wire code against runner/protocol/vectors.json (never against the generator)."""

import base64
import json
import os
import unittest

from runner import wire

VECTORS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "protocol", "vectors.json")
with open(VECTORS, encoding="utf-8") as _f:
    V = json.load(_f)


def body(job: dict) -> bytes:
    return json.dumps(job).encode("utf-8")


class VectorsTest(unittest.TestCase):
    def test_every_case(self):
        for c in V["cases"]:
            with self.subTest(c["name"]):
                nonce = bytes.fromhex(c["nonceHex"])
                e = c["expected"]
                self.assertEqual(wire.decode_32(c["nonce"]), nonce)
                self.assertEqual(wire.b64url(nonce), c["nonce"])
                self.assertEqual(wire.nonce_hash(nonce), e["nonceHash"])
                self.assertEqual(wire.session_id(c["tenantId"]), e["sessionId"])
                self.assertEqual(wire.result_proof(nonce, c["runId"]), e["resultProof"])
                job = wire.parse_job(body(e["job"]))
                self.assertEqual(job.input, bytes.fromhex(c["inputHex"]) if c["inputHex"] is not None else b"")
                self.assertEqual(wire.job_auth(nonce, job.run_id, job.tenant_id, job.code, job.input), e["jobAuth"])
                self.assertTrue(job.auth_ok(nonce))

    def test_negative_job_auth(self):
        basic = V["cases"][0]
        nonce = bytes.fromhex(basic["nonceHex"])
        for name in ("flipRunId", "flipTenant", "moveByteFromCodeToInput"):
            job = wire.parse_job(body(dict(basic["expected"]["job"], jobAuth=V["negative"][name])))
            self.assertFalse(job.auth_ok(nonce), name)
        other = bytes(32)
        self.assertFalse(wire.parse_job(body(basic["expected"]["job"])).auth_ok(other))

    def test_hello_proof(self):
        h = V["hello"]
        self.assertEqual(wire.hello_proof(wire.decode_32(h["nonce"]), wire.decode_32(h["challenge"]),
                                          bytes.fromhex(h["certFingerprint"])), h["expected"]["proof"])

    def test_refused_nonces_and_challenges(self):
        for name, text in V["mustRefuseNonce"].items():
            if name != "note":
                self.assertIsNone(wire.decode_32(text), name)
        self.assertIsNone(wire.decode_32(V["mustRefuseChallenge"]["short"]))
        for bad in (None, 7, "", "a", "a" * 43 + "=", "+" * 43):
            self.assertIsNone(wire.decode_32(bad))

    def test_refusal_status_table(self):
        r = V["refusalStatus"]
        for code in ("wrong_sandbox", "busy", "dirty", "tool_failed"):
            self.assertEqual(wire.REFUSAL_STATUS[code], r[code])
        self.assertEqual(wire.MALFORMED_JOB_STATUS, r["malformedJob"])


class ParseTest(unittest.TestCase):
    base = V["cases"][0]["expected"]["job"]

    def bad(self, **change):
        job = dict(self.base, **change)
        for key, value in list(job.items()):
            if value is ...:
                del job[key]
        with self.assertRaises(wire.Malformed):
            wire.parse_job(body(job))

    def test_malformed(self):
        for raw in (b"", b"[]", b"{", b"\xff", b'{"v":2}'):
            with self.assertRaises(wire.Malformed):
                wire.parse_job(raw)
        self.bad(v=...)
        self.bad(runId="")
        self.bad(runId="r" * 129)
        self.bad(runId="\ud800")
        self.bad(tenantId="-a")
        self.bad(tenantId="a" * 65)
        self.bad(tenantId="a\n")
        self.bad(nonce=...)
        self.bad(jobAuth=7)
        self.bad(code=None)
        self.bad(code="x" * 65537)
        self.bad(code="\udc00")
        self.bad(input="not base64!")
        self.bad(input=7)
        self.bad(input=base64.b64encode(b"x" * (wire.MAX_INPUT_BYTES + 1)).decode())
        self.bad(timeoutMs="30000")
        self.bad(timeoutMs=True)
        self.bad(timeoutMs=...)
        self.bad(maxOutputBytes=-1)
        self.bad(maxOutputBytes=wire.MAX_OUTPUT_BYTES + 1)

    def test_limits_at_the_edge(self):
        job = wire.parse_job(body(dict(self.base, runId="r" * 128, code="é" * 32768, timeoutMs=1, maxOutputBytes=0)))
        self.assertEqual(len(job.code), 65536)
        self.assertEqual(job.timeout_ms, wire.TIMEOUT_MIN_MS)
        self.assertEqual(wire.parse_job(body(dict(self.base, timeoutMs=10 ** 9))).timeout_ms, wire.TIMEOUT_MAX_MS)
        self.assertEqual(wire.parse_job(body(dict(self.base, unknown=1))).run_id, self.base["runId"])


class OutputTest(unittest.TestCase):
    def test_fits(self):
        self.assertEqual(wire.cut_output(b"ab", b"cd", 4), ("ab", "cd", False))

    def test_stdout_cut_first(self):
        self.assertEqual(wire.cut_output(b"abcdef", b"xy", 5), ("abc", "xy", True))
        self.assertEqual(wire.cut_output(b"abc", b"wxyz", 3), ("", "wxy", True))
        self.assertEqual(wire.cut_output(b"", b"", 0), ("", "", False))

    def test_cut_by_bytes_then_replaced(self):
        out, _, cut = wire.cut_output("é".encode() * 2, b"", 3)
        self.assertEqual(out, "é\ufffd")
        self.assertTrue(cut)
        self.assertEqual(wire.cut_output(b"\xff", b"", 10)[0], "\ufffd")

    def test_cut_while_read(self):
        self.assertTrue(wire.cut_output(b"a", b"", 10, cut_before=True)[2])


if __name__ == "__main__":
    unittest.main()
