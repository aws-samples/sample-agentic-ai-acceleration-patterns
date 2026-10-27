# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Tests for the synthetic issuer used only by the live validation deployment."""
import unittest

from src.test_identity import handler


class TestIdentityTest(unittest.TestCase):
    def test_issuer_assigns_shared_tenant_namespace_and_private_sessions(self):
        claims = {}
        for username in ["a-shopping", "a-support", "b-shopping"]:
            event = handler({"userName": username, "request": {}, "response": {}}, None)
            claims[username] = event["response"]["claimsAndScopeOverrideDetails"][
                "accessTokenGeneration"]["claimsToAddOrOverride"]
        self.assertEqual(claims["a-shopping"]["memory_namespace"],
                         claims["a-support"]["memory_namespace"])
        self.assertNotEqual(claims["a-shopping"]["memory_session"],
                            claims["a-support"]["memory_session"])
        self.assertNotEqual(claims["a-shopping"]["memory_namespace"],
                            claims["b-shopping"]["memory_namespace"])

    def test_caller_metadata_cannot_change_scope(self):
        event = handler({
            "userName": "a-shopping",
            "request": {"clientMetadata": {"memory_actor": "tenant-b"},
                        "userAttributes": {"custom:memory_actor": "tenant-b"}},
            "response": {},
        }, None)
        claims = event["response"]["claimsAndScopeOverrideDetails"][
            "accessTokenGeneration"]["claimsToAddOrOverride"]
        self.assertEqual(claims["memory_actor"], "tenant-a")

    def test_unknown_identity_has_no_entitlement(self):
        with self.assertRaises(ValueError):
            handler({"userName": "unknown", "request": {}, "response": {}}, None)


if __name__ == "__main__":
    unittest.main()
