# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
import json
import unittest
from datetime import datetime, timezone

import httpx

from src.gateway_memory import GatewayMemory, GatewayDenied
from src.render_config import render


class GatewayClientTest(unittest.TestCase):
    def make_client(self, handler):
        return GatewayMemory(
            "https://example.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
            "tenant-memory", "synthetic-local-token",
            transport=httpx.MockTransport(handler),
        )

    def test_native_http_serialization(self):
        def inspect(request):
            self.assertEqual(request.url.path, "/tenant-memory/memories/ExampleMemory-1234567890/events")
            self.assertEqual(request.headers["Authorization"], "Bearer synthetic-local-token")
            body = json.loads(request.content)
            self.assertEqual(body["actorId"], "tenant-a")
            self.assertIsInstance(body["eventTimestamp"], (float, int))
            return httpx.Response(201, json={"event": {"eventId": "fixture"}})
        client = self.make_client(inspect)
        self.assertEqual(client.call("CreateEvent", {
            "memoryId": "ExampleMemory-1234567890", "actorId": "tenant-a",
            "sessionId": "shopping-001", "eventTimestamp": datetime.now(timezone.utc),
            "payload": [{"conversational": {"role": "USER", "content": {"text": "Synthetic fact"}}}],
        })["event"]["eventId"], "fixture")

    def test_denial_is_distinct_from_backend_failure(self):
        for status, expected in [(403, GatewayDenied), (500, httpx.HTTPStatusError), (400, httpx.HTTPStatusError)]:
            with self.subTest(status=status):
                client = self.make_client(lambda request: httpx.Response(status, json={}))
                with self.assertRaises(expected):
                    client.call("RetrieveMemoryRecords", {
                        "memoryId": "ExampleMemory-1234567890",
                        "namespacePath": "/tenants/tenant-b/shared/",
                        "searchCriteria": {"searchQuery": "synthetic"},
                    })

    def test_denial_diagnostics_never_include_the_bearer_token(self):
        token = "synthetic-local-token"
        client = self.make_client(lambda request: httpx.Response(
            403, headers={"x-amzn-requestid": "fixture"},
            json={"message": f"Denied request containing {token}"}))
        with self.assertRaises(GatewayDenied) as denied:
            client.call("ListActors", {"memoryId": "ExampleMemory-1234567890"})
        self.assertNotIn(token, json.dumps(denied.exception.diagnostic))
        self.assertEqual(denied.exception.diagnostic["requestId"], "fixture")

    def test_backend_error_diagnostics_never_include_the_bearer_token(self):
        token = "synthetic-local-token"
        client = self.make_client(lambda request: httpx.Response(
            400, headers={"x-amzn-requestid": "fixture"},
            json={"message": f"Bad request containing {token}"}))
        with self.assertRaises(httpx.HTTPStatusError) as failed:
            client.call("ListActors", {"memoryId": "ExampleMemory-1234567890"})
        self.assertNotIn(token, json.dumps(failed.exception.diagnostic))
        self.assertEqual(failed.exception.diagnostic["statusCode"], 400)

    def test_token_never_crosses_redirect(self):
        client = self.make_client(lambda request: httpx.Response(307, headers={"Location": "https://other.example.com/"}))
        with self.assertRaises(httpx.HTTPStatusError):
            client.call("ListActors", {"memoryId": "ExampleMemory-1234567890"})

    def test_rejects_non_https_endpoint(self):
        with self.assertRaises(ValueError):
            GatewayMemory("http://localhost", "tenant-memory", "fixture")

    def test_rejects_route_injection(self):
        with self.assertRaises(ValueError):
            GatewayMemory("https://example.com", "../other", "fixture")

    def test_default_plan_never_submits_or_contains_tokens(self):
        plan = render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                      "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                      "https://issuer.example.com/.well-known/openid-configuration", "example-client",
                      "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456")
        self.assertEqual(plan["create-gateway.json"]["policyEngineConfiguration"]["mode"], "ENFORCE")
        self.assertNotIn("protocolType", plan["create-gateway.json"],
                         "Memory HTTP targets require the protocol-neutral Gateway setup")
        deny = plan["memory-resource-policy.json"]["Statement"][0]
        self.assertEqual(deny["Effect"], "Deny")
        self.assertEqual(deny["Condition"]["ArnNotEquals"]["aws:PrincipalArn"],
                         "arn:aws:iam::000000000000:role/ExampleGatewayRole")
        self.assertNotIn("bedrock-agentcore:BatchCreateMemoryRecords",
                         plan["gateway-role-policy.json"]["Statement"][0]["Action"])

    def test_policy_names_meet_control_api_contract(self):
        plan = render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                      "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                      "https://issuer.example.com/.well-known/openid-configuration", "example-client",
                      "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456")
        for filename in ["event-write-policy.json", "shared-recall-policy.json"]:
            self.assertRegex(plan[filename]["name"], r"^[A-Za-z][A-Za-z0-9_]*$")

    def test_gateway_role_can_evaluate_only_its_policy_engine_and_gateway(self):
        engine = "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456"
        gateway = "arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/example"
        plan = render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                      "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                      "https://issuer.example.com/.well-known/openid-configuration",
                      "example-client", engine)
        statements = plan["gateway-role-policy.json"]["Statement"]
        evaluate = next(s for s in statements if "bedrock-agentcore:AuthorizeAction" in s["Action"])
        self.assertEqual(set(evaluate["Resource"]), {engine, gateway})
        self.assertIn("bedrock-agentcore:PartiallyAuthorizeActions", evaluate["Action"])
        read = next(s for s in statements if "bedrock-agentcore:GetPolicyEngine" in s["Action"])
        self.assertEqual(read["Resource"], engine)

    def test_bootstrap_policy_does_not_guess_an_uncreated_gateway_id(self):
        engine = "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456"
        plan = render("us-west-2", "000000000000", "pending", "ExampleMemory-1234567890",
                      "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                      "https://issuer.example.com/.well-known/openid-configuration",
                      "example-client", engine)
        statements = plan["gateway-role-policy.json"]["Statement"]
        evaluate = next(s for s in statements if "bedrock-agentcore:AuthorizeAction" in s["Action"])
        self.assertEqual(set(evaluate["Resource"]), {
            engine, "arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/*"})
        self.assertEqual(statements[0]["Resource"],
                         "arn:aws:bedrock-agentcore:us-west-2:000000000000:memory/ExampleMemory-1234567890")

    def test_gateway_can_validate_only_its_memory_metadata(self):
        plan = render("us-west-2", "000000000000", "example", "ExampleMemory-1234567890",
                      "arn:aws:iam::000000000000:role/ExampleGatewayRole",
                      "https://issuer.example.com/.well-known/openid-configuration",
                      "example-client",
                      "arn:aws:bedrock-agentcore:us-west-2:000000000000:policy-engine/example123456")
        metadata = next(s for s in plan["gateway-role-policy.json"]["Statement"]
                        if s["Action"] == ["bedrock-agentcore:GetMemory"])
        self.assertEqual(metadata["Resource"],
                         "arn:aws:bedrock-agentcore:us-west-2:000000000000:memory/ExampleMemory-1234567890")
        self.assertNotIn("bedrock-agentcore:GetMemory",
                         plan["gateway-role-policy.json"]["Statement"][0]["Action"])


if __name__ == "__main__":
    unittest.main()
