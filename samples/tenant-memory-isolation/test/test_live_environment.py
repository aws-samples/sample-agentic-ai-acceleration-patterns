# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Exercise the dry-run guarantee and failure cleanup without AWS calls."""
import contextlib
import base64
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError

from src.live_environment import LiveEnvironment, assert_token_scope, gateway_role_is_propagating, main


class LiveEnvironmentTest(unittest.TestCase):
    def token(self, **updates):
        claims = {
            "memory_actor": "tenant-a", "memory_session": "shopping-001",
            "memory_namespace": "/tenants/tenant-a/shared/",
            "client_id": "fixture-client", "token_use": "access",
        }
        claims.update(updates)
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return "fixture." + payload + ".signature"

    def test_fixture_token_has_the_expected_issued_scope(self):
        assert_token_scope(self.token(), "a-shopping", "fixture-client")

    def test_fixture_rejects_wrong_scope_or_client(self):
        for updates in [
            {"memory_actor": "tenant-b"}, {"memory_session": "support-001"},
            {"memory_namespace": "/tenants/tenant-b/shared/"},
            {"client_id": "other-client"}, {"token_use": "id"},
        ]:
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                assert_token_scope(self.token(**updates), "a-shopping", "fixture-client")

    def test_fixture_rejects_missing_claims_and_malformed_tokens(self):
        for token in ["fixture.e30.signature", "malformed"]:
            with self.subTest(token=token), self.assertRaises(ValueError):
                assert_token_scope(token, "a-shopping", "fixture-client")

    def test_gateway_retry_recognises_specific_iam_propagation_checks(self):
        for code, message in [
            ("ValidationException", "Role is not authorized to perform AssumeRole"),
            ("AccessDeniedException", "GenesisPolicyEngineCheck failed"),
            ("ValidationException", "Access denied while calling GetPolicyEngine on Policy Engine"),
        ]:
            error = ClientError({"Error": {"Code": code, "Message": message}}, "CreateGateway")
            with self.subTest(message=message):
                self.assertTrue(gateway_role_is_propagating(error))

    def test_gateway_retry_does_not_hide_unrelated_configuration_errors(self):
        for code, message in [
            ("ValidationException", "Invalid connector configuration"),
            ("AccessDeniedException", "Not allowed to create Gateway"),
            ("ThrottlingException", "AssumeRole request limit"),
        ]:
            error = ClientError({"Error": {"Code": code, "Message": message}}, "CreateGateway")
            with self.subTest(message=message):
                self.assertFalse(gateway_role_is_propagating(error))

    def test_plan_never_creates_an_aws_session(self):
        output = io.StringIO()
        with patch("sys.argv", ["live_environment", "--region", "ap-southeast-2"]), \
                patch("src.live_environment.boto3.Session") as session, \
                contextlib.redirect_stdout(output):
            main()
        session.assert_not_called()
        self.assertIn("No AWS calls made", output.getvalue())

    def test_reused_empty_role_is_recorded_for_retention(self):
        env = object.__new__(LiveEnvironment)
        env.state = {}
        env.save = lambda **updates: env.state.update(updates)
        exists = ClientError(
            {"Error": {"Code": "EntityAlreadyExists", "Message": "fixture"}},
            "CreateRole")
        env.iam = SimpleNamespace(
            create_role=Mock(side_effect=exists),
            list_role_policies=Mock(return_value={"PolicyNames": []}),
            list_attached_role_policies=Mock(return_value={"AttachedPolicies": []}),
            update_assume_role_policy=Mock(),
            get_role=Mock(return_value={"Role": {"RoleName": "fixture-role"}}),
        )
        role = env.create_or_reuse_role(
            "fixture-role", {"Version": "2012-10-17", "Statement": []})
        self.assertEqual(role["RoleName"], "fixture-role")
        self.assertEqual(env.state["retainedRoles"], ["fixture-role"])

    def test_cleanup_continues_after_a_resource_wait_fails(self):
        env = object.__new__(LiveEnvironment)
        env.state = {"targetId": "fixture", "gatewayId": "fixture", "policies": []}
        env.control = SimpleNamespace(
            delete_gateway_target=Mock(), get_gateway_target=Mock(),
            delete_gateway=Mock(), get_gateway=Mock())
        env.cognito = SimpleNamespace(delete_user_pool=Mock())
        env.functions = SimpleNamespace(delete_function=Mock())
        env.logs = SimpleNamespace(delete_log_group=Mock())
        env.save = Mock()
        env.wait_absent = Mock(side_effect=[TimeoutError("fixture"), None])
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            env.cleanup()
        env.control.delete_gateway_target.assert_called_once()
        env.control.delete_gateway.assert_called_once()
        self.assertFalse(env.save.call_args.kwargs["cleanedUp"])
        self.assertEqual(env.save.call_args.kwargs["cleanupErrors"][0]["resource"], "targetId")


if __name__ == "__main__":
    unittest.main()
