# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The Memory resource fence covers every data-plane operation (ADR-0007)."""
import json
import unittest
from pathlib import Path

from src.render_config import ALLOWED, DATA_ACTIONS, render
from src.validate_live import assert_fence

# The operations reviewed against the Cedar policies and the fence. When the
# pinned SDK adds one, this test fails: decide whether agents need it (a Cedar
# permit plus a role grant) or not (fenced only), then add it here.
REVIEWED_DATA_ACTIONS = {
    "BatchCreateMemoryRecords", "BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords",
    "CreateEvent", "DeleteEvent", "DeleteMemoryRecord", "GetEvent", "GetMemoryRecord",
    "IngestData", "ListActors", "ListEvents", "ListMemoryExtractionJobs",
    "ListMemoryRecords", "ListSessions", "RetrieveMemoryRecords",
    "StartMemoryExtractionJob",
}


def fixture_plan():
    return render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                  "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                  "https://issuer.example.com/.well-known/openid-configuration", "example-client",
                  "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456")


class FenceTest(unittest.TestCase):
    def test_fence_covers_the_reviewed_operations(self):
        self.assertEqual(
            set(DATA_ACTIONS), REVIEWED_DATA_ACTIONS,
            "The Memory service model changed: review the new or removed operations")

    def test_ingest_data_is_fenced_and_never_granted(self):
        plan = fixture_plan()
        deny = plan["memory-resource-policy.json"]["Statement"][0]
        self.assertIn("bedrock-agentcore:IngestData", deny["Action"])
        granted = plan["gateway-role-policy.json"]["Statement"][0]["Action"]
        self.assertNotIn("bedrock-agentcore:IngestData", granted)

    def test_fence_denies_every_data_action(self):
        deny = fixture_plan()["memory-resource-policy.json"]["Statement"][0]
        self.assertEqual(set(deny["Action"]), {f"bedrock-agentcore:{name}" for name in DATA_ACTIONS})
        self.assertLessEqual(set(ALLOWED), set(DATA_ACTIONS))

    def test_live_check_rejects_a_fence_missing_one_operation(self):
        config = json.loads(Path("config/live-config.example.json").read_text())
        policy = fixture_plan()["memory-resource-policy.json"]
        assert_fence(policy, config)
        policy["Statement"][0]["Action"].remove("bedrock-agentcore:IngestData")
        with self.assertRaises(AssertionError):
            assert_fence(policy, config)


if __name__ == "__main__":
    unittest.main()
