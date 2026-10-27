# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
import copy
import json
import unittest
from unittest.mock import Mock, patch
from pathlib import Path

from src.render_config import render
from src.validate_live import validate_config, assert_fence, assert_execution_role, create_probe_event, call_when_ready
from src.gateway_memory import GatewayDenied


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path("config/live-config.example.json").read_text())

    def test_accepts_three_scoped_identities(self):
        validate_config(self.config)

    def test_rejects_another_tenant_namespace_and_shared_session(self):
        for field, value in [("namespacePath", "/tenants/tenant-b/shared/"),
                             ("sessionId", "shopping-001")]:
            config = copy.deepcopy(self.config)
            config["identities"]["a-support"][field] = value
            with self.assertRaises(ValueError):
                validate_config(config)

    def test_rejects_resource_id_or_region_mismatch(self):
        for key, value in [("memoryId", "OtherMemory-1234567890"), ("region", "eu-west-1"),
                           ("gatewayRoleArn", "arn:aws:iam::111111111111:role/OtherRole")]:
            config = {**self.config, key: value}
            with self.assertRaises(ValueError):
                validate_config(config)

    def test_conditional_allow_alone_is_not_a_resource_fence(self):
        policy = render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                        "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                        "https://issuer.example.com/.well-known/openid-configuration", "example-client",
                        "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456"
                        )["memory-resource-policy.json"]
        assert_fence(policy, self.config)
        policy["Statement"] = [entry for entry in policy["Statement"] if entry["Effect"] == "Allow"]
        with self.assertRaises(AssertionError):
            assert_fence(policy, self.config)

    def test_role_must_bind_the_gateway_and_memory(self):
        engine = "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456"
        role_policy = render(
            self.config["region"], "000000000000", self.config["gatewayId"],
            self.config["memoryId"], self.config["gatewayRoleArn"],
            "https://issuer.example.com/.well-known/openid-configuration",
            "example-client", engine)["gateway-role-policy.json"]
        trust = {"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
            "Action": "sts:AssumeRole", "Condition": {
                "StringEquals": {"aws:SourceAccount": "000000000000"},
                "ArnEquals": {"aws:SourceArn": [self.config["gatewayArn"], engine]},
            },
        }]}
        assert_execution_role(role_policy, trust, self.config, engine)
        for mutate in ["memory_wildcard", "source_wildcard", "extra_allow"]:
            policy, assumption = copy.deepcopy(role_policy), copy.deepcopy(trust)
            if mutate == "memory_wildcard":
                policy["Statement"][0]["Resource"] = "*"
            elif mutate == "source_wildcard":
                assumption["Statement"][0]["Condition"]["ArnEquals"]["aws:SourceArn"] = "*"
            else:
                assumption["Statement"].append({
                    "Effect": "Allow", "Principal": "*", "Action": "sts:AssumeRole"})
            with self.subTest(mutate=mutate), self.assertRaises(AssertionError):
                assert_execution_role(policy, assumption, self.config, engine)

    def test_initial_write_retry_reuses_its_idempotency_token(self):
        client = Mock()
        client.call.side_effect = [GatewayDenied("fixture"), {"event": {"eventId": "fixture"}}]
        parameters = {"clientToken": "stable-fixture"}
        with patch("src.validate_live.time.sleep"), patch("builtins.print"):
            result = create_probe_event(client, parameters)
        self.assertEqual(result["event"]["eventId"], "fixture")
        self.assertEqual(client.call.call_count, 2)
        for call in client.call.call_args_list:
            self.assertEqual(call.args, ("CreateEvent", parameters))

    def test_persistent_denial_never_counts_as_an_authorized_write(self):
        client = Mock()
        client.call.side_effect = GatewayDenied("fixture")
        with patch("src.validate_live.time.monotonic", side_effect=[0, 301]):
            with self.assertRaises(GatewayDenied):
                create_probe_event(client, {"clientToken": "stable-fixture"})
        self.assertEqual(client.call.call_count, 1)

    def test_retry_requires_an_idempotency_token(self):
        client = Mock()
        with self.assertRaises(ValueError):
            create_probe_event(client, {})
        client.call.assert_not_called()

    def test_excluded_operations_cannot_use_positive_readiness_retries(self):
        client = Mock()
        with self.assertRaises(ValueError):
            call_when_ready(client, "ListEvents", {})
        client.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
