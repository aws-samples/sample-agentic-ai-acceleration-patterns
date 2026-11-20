# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""vectors.json matches its generator, and its cases cover the edges PROTOCOL.md names."""

import json
import os
import unittest

from runner.protocol import make_vectors


class VectorsTest(unittest.TestCase):
    def test_file_is_current(self):
        with open(make_vectors.VECTORS, encoding="utf-8") as f:
            self.assertEqual(f.read(), make_vectors.render())

    def test_absent_and_empty_input_sign_the_same(self):
        cases = {c["name"]: c for c in make_vectors.build()["cases"]}
        self.assertEqual(cases["absent-input"]["expected"]["jobAuth"], cases["empty-input"]["expected"]["jobAuth"])
        self.assertNotIn("input", cases["absent-input"]["expected"]["job"])
        self.assertEqual(cases["empty-input"]["expected"]["job"]["input"], "")

    def test_negative_cases_differ(self):
        v = make_vectors.build()
        basic = v["cases"][0]["expected"]["jobAuth"]
        for name in ("flipRunId", "flipTenant", "moveByteFromCodeToInput"):
            self.assertNotEqual(v["negative"][name], basic, name)

    def test_encodings(self):
        for c in make_vectors.build()["cases"]:
            e = c["expected"]
            self.assertEqual(len(c["nonce"]), 43)
            self.assertNotIn("=", e["jobAuth"])
            self.assertEqual(len(e["jobAuth"]), 43)
            self.assertEqual(len(e["nonceHash"]), 64)
            self.assertEqual(len(e["startToken"]), 32)
            self.assertEqual(len(e["sessionId"]), 67)
            self.assertRegex(c["tenantId"], r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

    def test_json_is_ascii(self):
        with open(make_vectors.VECTORS, "rb") as f:
            raw = f.read()
        raw.decode("ascii")
        json.loads(raw)
        self.assertTrue(os.path.getsize(make_vectors.VECTORS) > 0)


if __name__ == "__main__":
    unittest.main()
