# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Validate real Gateway isolation using three issuer-signed synthetic identities."""
import argparse
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3
import httpx
from botocore.exceptions import ClientError

from .gateway_memory import GatewayMemory, GatewayDenied
from .render_config import ALLOWED, DATA_ACTIONS


def validate_config(config):
    """Require canonical synthetic scopes before any request can be submitted."""
    required = {"region", "memoryId", "memoryArn", "gatewayId", "gatewayArn",
                "gatewayUrl", "gatewayRoleArn", "targetName", "targetId", "identities"}
    if not required <= config.keys():
        raise ValueError("Missing live configuration fields")
    if config["targetName"] != "tenant-memory":
        raise ValueError("Use the tenant-memory target that matches the supplied policies")
    if not config["memoryArn"].endswith(f':memory/{config["memoryId"]}'):
        raise ValueError("Memory ID and ARN must match")
    if not config["gatewayArn"].endswith(f':gateway/{config["gatewayId"]}'):
        raise ValueError("Gateway ID and ARN must match")
    identities = config["identities"]
    if set(identities) != {"a-shopping", "a-support", "b-shopping"}:
        raise ValueError("Exactly three identities are required")
    for identity in identities.values():
        for key in ["actorId", "sessionId", "tokenEnv"]:
            if not re.fullmatch(r"[A-Za-z0-9_-]+", identity[key]):
                raise ValueError(f"Invalid {key}")
        if identity["namespacePath"] != f'/tenants/{identity["actorId"]}/shared/':
            raise ValueError("Each namespace must be its actor's canonical shared path")
    first, second, other = (identities[key] for key in ["a-shopping", "a-support", "b-shopping"])
    if first["actorId"] != second["actorId"] or first["actorId"] == other["actorId"]:
        raise ValueError("Two A agents must share an actor; B must have a distinct actor")
    if first["sessionId"] == second["sessionId"]:
        raise ValueError("A agents need distinct private sessions")
    if len({identity["tokenEnv"] for identity in identities.values()}) != 3:
        raise ValueError("Use separately scoped tokens for the three identities")
    account = config["memoryArn"].split(":")[4]
    expected_memory = f'arn:aws:bedrock-agentcore:{config["region"]}:{account}:memory/{config["memoryId"]}'
    expected_gateway = f'arn:aws:bedrock-agentcore:{config["region"]}:{account}:gateway/{config["gatewayId"]}'
    if config["memoryArn"] != expected_memory or config["gatewayArn"] != expected_gateway:
        raise ValueError("Region, account, and resource identifiers must be consistent")
    if not re.fullmatch(rf"arn:aws:iam::{account}:role/[A-Za-z0-9+=,.@_/-]+",
                        config["gatewayRoleArn"]):
        raise ValueError("Gateway execution role must belong to the same account")


def assert_fence(policy, config):
    """Confirm an explicit deny outside the dedicated Gateway execution role."""
    for statement in policy.get("Statement", []):
        if (statement.get("Effect") == "Deny" and statement.get("Principal") == "*" and
                statement.get("Resource") == config["memoryArn"] and
                statement.get("Condition") == {
                    "ArnNotEquals": {"aws:PrincipalArn": config["gatewayRoleArn"]}} and
                set(statement.get("Action", [])) >= {f"bedrock-agentcore:{name}" for name in DATA_ACTIONS}):
            return
    raise AssertionError("Memory resource policy lacks the complete expected execution-role fence")


def assert_execution_role(policy, trust, config, engine_arn):
    """Require exact permissions and service-only, resource-scoped role trust.

    Memory's PrincipalArn fence and this trust policy form one boundary. A role
    with a broader trust policy would allow callers to obtain its credentials.
    """
    memory, gateway = config["memoryArn"], config["gatewayArn"]
    expected = {
        (frozenset(f"bedrock-agentcore:{name}" for name in ALLOWED), frozenset([memory])),
        (frozenset(["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"]),
         frozenset([engine_arn, gateway])),
        (frozenset(["bedrock-agentcore:GetPolicyEngine"]), frozenset([engine_arn])),
        (frozenset(["bedrock-agentcore:GetMemory"]), frozenset([memory])),
    }
    observed = set()
    for statement in policy.get("Statement", []):
        if statement.get("Effect") != "Allow" or "NotAction" in statement or "NotResource" in statement:
            raise AssertionError("Unexpected Gateway role permission")
        actions, resources = statement.get("Action", []), statement.get("Resource", [])
        if isinstance(actions, str):
            actions = [actions]
        if isinstance(resources, str):
            resources = [resources]
        observed.add((frozenset(actions), frozenset(resources)))
    if len(policy.get("Statement", [])) != 4 or observed != expected:
        raise AssertionError("Gateway role permissions must match the dedicated Memory and Policy resources")
    statements = trust.get("Statement", [])
    if len(statements) != 1:
        raise AssertionError("Gateway role must have only the scoped service trust")
    statement = statements[0]
    account = memory.split(":")[4]
    condition = statement.get("Condition", {})
    sources = condition.get("ArnEquals", {}).get("aws:SourceArn", [])
    if isinstance(sources, str):
        sources = [sources]
    if (statement.get("Effect") != "Allow" or
            statement.get("Principal") != {"Service": "bedrock-agentcore.amazonaws.com"} or
            statement.get("Action") != "sts:AssumeRole" or
            condition.get("StringEquals") != {"aws:SourceAccount": account} or
            set(sources) != {gateway, engine_arn} or
            set(condition) != {"StringEquals", "ArnEquals"}):
        raise AssertionError("Gateway role trust must pin the account, Gateway, and Policy engine")


def call_when_ready(client, operation, parameters, timeout=300):
    """Bound readiness retries for expected positive cases, never negatives."""
    if operation not in ALLOWED:
        raise ValueError("Readiness retries are only for the sample's permitted operations")
    deadline = time.monotonic() + timeout
    while True:
        try:
            return client.call(operation, parameters)
        except GatewayDenied:
            if time.monotonic() >= deadline:
                raise
            print(f"WAIT authorized {operation} request returned 403", flush=True)
            time.sleep(5)


def create_probe_event(client, parameters, timeout=300):
    """Retry an authorized setup write with one stable idempotency token."""
    if not parameters.get("clientToken"):
        raise ValueError("Initial event retries require a stable clientToken")
    return call_when_ready(client, "CreateEvent", parameters, timeout)


def run(config, extraction_timeout, report):
    """Run a real test; only observed authorization denials pass negative cases."""
    validate_config(config)
    clients = {}
    results = []
    complete = False
    control = boto3.client("bedrock-agentcore-control", region_name=config["region"])
    gateway = control.get_gateway(gatewayIdentifier=config["gatewayId"])
    if (gateway.get("authorizerType") != "CUSTOM_JWT" or
            gateway.get("policyEngineConfiguration", {}).get("mode") != "ENFORCE"):
        raise AssertionError("Gateway must use CUSTOM_JWT and ENFORCE")
    if gateway.get("gatewayArn") != config["gatewayArn"]:
        raise AssertionError("Gateway ARN does not match test configuration")
    if gateway.get("gatewayUrl", "").rstrip("/") != config["gatewayUrl"].rstrip("/"):
        raise AssertionError("Gateway URL differs from GetGateway")
    if gateway.get("roleArn") != config["gatewayRoleArn"]:
        raise AssertionError("Gateway execution role differs from GetGateway")
    iam = boto3.client("iam")
    role_name = config["gatewayRoleArn"].rsplit("/", 1)[-1]
    if (iam.list_role_policies(RoleName=role_name)["PolicyNames"] != ["ScopedMemory"] or
            iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]):
        raise AssertionError("Gateway role must have only the sample's scoped inline policy")
    role = iam.get_role(RoleName=role_name)["Role"]
    permissions = iam.get_role_policy(RoleName=role_name, PolicyName="ScopedMemory")["PolicyDocument"]
    assert_execution_role(permissions, role["AssumeRolePolicyDocument"], config,
                          gateway["policyEngineConfiguration"]["arn"])
    target = control.get_gateway_target(gatewayIdentifier=config["gatewayId"], targetId=config["targetId"])
    connector = target.get("targetConfiguration", {}).get("http", {}).get("connector", {})
    if (target.get("name") != config["targetName"] or
            connector.get("source", {}).get("connectorId") != "agentcore-memory" or
            connector.get("parameters", {}).get("memoryId") != config["memoryId"] or
            target.get("credentialProviderConfigurations") != [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]):
        raise AssertionError("Target must match the native Memory connector and role mode")
    policy = control.get_resource_policy(resourceArn=config["memoryArn"])
    assert_fence(json.loads(policy["policy"]), config)

    def passed(name):
        results.append({"case": name, "result": "PASS"})
        print(f"PASS {name}")

    def deny(name, client, operation, parameters):
        try:
            client.call(operation, parameters)
        except GatewayDenied:
            passed(name)
            return
        raise AssertionError(f"{name}: request was allowed")

    def retrieve(key):
        identity = config["identities"][key]
        return clients[key].call("RetrieveMemoryRecords", {
            "memoryId": config["memoryId"], "namespacePath": identity["namespacePath"],
            "searchCriteria": {"searchQuery": "warehouse codename", "topK": 10},
        })

    def session_params(key):
        identity = config["identities"][key]
        return {"memoryId": config["memoryId"], "actorId": identity["actorId"],
                "sessionId": identity["sessionId"]}

    run_id = uuid.uuid4().hex[:12]
    markers = {"a-shopping": f"Amber{run_id}", "b-shopping": f"Blue{run_id}"}
    try:
        for key, identity in config["identities"].items():
            token = os.environ.get(identity["tokenEnv"])
            if not token:
                raise ValueError(f'Missing environment variable {identity["tokenEnv"]}')
            clients[key] = GatewayMemory(config["gatewayUrl"], config["targetName"], token)
        passed("configured Gateway uses JWT authentication and enforced policies")
        passed("Gateway role trust and permissions are pinned to the dedicated resources")
        passed("Memory resource has an explicit execution-role data-plane fence")

        for key, marker in markers.items():
            event = create_probe_event(clients[key], {
                **session_params(key), "eventTimestamp": datetime.now(timezone.utc),
                "clientToken": str(uuid.uuid4()),
                "payload": [{"conversational": {"role": "USER", "content": {
                    "text": f"Our organisation's warehouse codename is {marker}. Remember this shared operational fact.",
                }}}],
            })
            passed(f"{key}: writes its own scoped event")
        support_event = create_probe_event(clients["a-support"], {
            **session_params("a-support"), "eventTimestamp": datetime.now(timezone.utc),
            "clientToken": str(uuid.uuid4()),
            "payload": [{"conversational": {"role": "USER", "content": {
                "text": "Synthetic support conversation setup.",
            }}}],
        })
        passed("a-support: writes its own scoped event")
        deny("Short-term event reads are not exposed to agents", clients["a-support"],
             "ListEvents", session_params("a-support"))
        deny("A cannot read B's short-term session", clients["a-shopping"], "ListEvents",
             session_params("b-shopping"))
        deny("A shopping cannot read A support session", clients["a-shopping"], "ListEvents",
             session_params("a-support"))
        changed_write = {
            **session_params("b-shopping"), "eventTimestamp": datetime.now(timezone.utc),
            "payload": [{"conversational": {"role": "USER", "content": {"text": "Synthetic rejected write"}}}],
        }
        deny("A cannot write events under B actor", clients["a-shopping"], "CreateEvent", changed_write)
        changed_write.update(session_params("a-shopping"))
        changed_write["extractionConfig"] = {"namespaceVariables": {"tenant": "tenant-b"}}
        deny("A cannot override extraction namespace variables", clients["a-shopping"],
             "CreateEvent", changed_write)
        for path in [config["identities"]["b-shopping"]["namespacePath"], "/tenants/",
                     f'/tenants/{config["identities"]["a-shopping"]["actorId"]}/']:
            deny("A cannot retrieve changed namespace " + path, clients["a-shopping"],
                 "RetrieveMemoryRecords", {"memoryId": config["memoryId"],
                     "namespacePath": path, "searchCriteria": {"searchQuery": "warehouse codename"}})
        deny("A cannot enumerate tenant actors", clients["a-shopping"], "ListActors",
             {"memoryId": config["memoryId"]})

        # Observe extraction rather than turning eventual consistency into an authorization claim.
        deadline = time.monotonic() + extraction_timeout
        while True:
            observed = {key: json.dumps(retrieve(key)) for key in config["identities"]}
            if (markers["a-shopping"] in observed["a-shopping"] and
                    markers["a-shopping"] in observed["a-support"] and
                    markers["b-shopping"] in observed["b-shopping"]):
                if (markers["b-shopping"] in observed["a-shopping"] or
                        markers["b-shopping"] in observed["a-support"] or
                        markers["a-shopping"] in observed["b-shopping"]):
                    raise AssertionError("Cross-tenant canary appeared in an allowed response")
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Extraction not observed before deadline; live validation incomplete")
            time.sleep(10)
        passed("A shopping and A support recall A's same extracted fact")
        passed("B recalls B's fact; neither tenant response contains the other's canary")

        records = clients["a-shopping"].call("ListMemoryRecords", {
            "memoryId": config["memoryId"],
            "namespacePath": config["identities"]["a-shopping"]["namespacePath"],
        })
        summaries = records.get("memoryRecordSummaries", [])
        if not summaries:
            raise AssertionError("No record ID available for ID-access denial test")
        record_id = summaries[0]["memoryRecordId"]
        deny("Record-ID lookup has no tenant permit", clients["a-shopping"], "GetMemoryRecord",
             {"memoryId": config["memoryId"], "memoryRecordId": record_id})

        direct = boto3.client("bedrock-agentcore", region_name=config["region"])
        try:
            direct.retrieve_memory_records(
                memoryId=config["memoryId"],
                namespacePath=config["identities"]["a-shopping"]["namespacePath"],
                searchCriteria={"searchQuery": "warehouse codename"})
        except ClientError as error:
            if error.response["Error"]["Code"] not in {"AccessDeniedException", "AccessDenied"}:
                raise
            passed("Direct IAM call is denied outside Gateway")
        else:
            raise AssertionError("Direct Memory call bypassed Gateway")
        try:
            boto3.client("sts", region_name=config["region"]).assume_role(
                RoleArn=config["gatewayRoleArn"], RoleSessionName="outside-gateway-probe")
        except ClientError as error:
            if error.response["Error"]["Code"] not in {"AccessDeniedException", "AccessDenied"}:
                raise
            passed("Direct caller cannot assume the Gateway execution role")
        else:
            raise AssertionError("Direct caller obtained Gateway execution-role credentials")
        # Optional expired token check is explicitly recorded when the fixture is absent.
        expired = os.environ.get("EXPIRED_TEST_TOKEN")
        if expired:
            client = GatewayMemory(config["gatewayUrl"], config["targetName"], expired)
            try:
                client.call("ListEvents", session_params("a-shopping"))
            except GatewayDenied:
                passed("Expired token denied")
            except httpx.HTTPStatusError as error:
                if error.response.status_code != 401:
                    raise
                passed("Expired token denied")
            else:
                raise AssertionError("Expired token accepted")
            finally:
                client.close()
        else:
            results.append({"case": "Expired-token fixture", "result": "NOT_RUN"})
        complete = True
        return results
    except Exception as error:
        results.append({"case": "Live matrix", "result": "FAILED", "errorType": type(error).__name__})
        raise
    finally:
        for client in clients.values():
            client.close()
        report.write_text(json.dumps({"status": "PASSED" if complete and
            not any(case["result"] == "FAILED" for case in results) else "FAILED",
            "date": datetime.now(timezone.utc).isoformat(),
            "region": config["region"], "results": results,
            "note": "Long-term records remain until the dedicated Memory resource is deleted."}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--execute", action="store_true", help="Submit synthetic test calls to AWS")
    parser.add_argument("--extraction-timeout", type=int, default=600)
    parser.add_argument("--report", type=Path, default=Path("live-report.json"))
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    validate_config(config)
    if not args.execute:
        print("DRY RUN: three identities; scoped event writes, Cedar denial probes, shared recall, and direct-bypass probe.")
        print("No tokens read. No AWS calls made. Pass --execute only for a dedicated test Memory.")
        return
    if not 30 <= args.extraction_timeout <= 3600:
        parser.error("--extraction-timeout must be 30–3600 seconds")
    try:
        results = run(config, args.extraction_timeout, args.report)
        if any(case["result"] == "FAILED" for case in results):
            raise AssertionError("Cleanup failed")
    except Exception as error:
        # Status only. Exceptions can carry response payloads or deployment details.
        print(f"LIVE VALIDATION FAILED ({type(error).__name__}); inspect the test configuration and AWS logs.")
        if not args.report.exists():
            args.report.write_text(json.dumps({"status": "FAILED", "results": [],
                "errorType": type(error).__name__, "note": "Preflight failed; no complete live matrix."}, indent=2))
        raise SystemExit(1) from None
    print("LIVE VALIDATION PASSED; inspect report for NOT_RUN cases and remove the test Memory.")


if __name__ == "__main__":
    main()
