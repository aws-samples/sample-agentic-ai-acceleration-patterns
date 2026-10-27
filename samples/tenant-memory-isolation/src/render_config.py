# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Generate reviewable configuration files without making AWS calls."""
import argparse
import json
import re
from pathlib import Path

from botocore.session import Session
from botocore.validate import validate_parameters

ALLOWED = ["CreateEvent", "RetrieveMemoryRecords", "ListMemoryRecords"]
BATCH = ["BatchCreateMemoryRecords", "BatchUpdateMemoryRecords", "BatchDeleteMemoryRecords"]
DATA_ACTIONS = ALLOWED + [
    "ListEvents", "GetEvent", "DeleteEvent", "ListActors", "ListSessions",
    "GetMemoryRecord", "DeleteMemoryRecord",
    "ListMemoryExtractionJobs", "StartMemoryExtractionJob",
] + BATCH
FIXTURE_GATEWAY = "arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/example"
FIXTURE_MEMORY = "ExampleMemory-1234567890"
TARGET = "tenant-memory"


def render(region, account, gateway_id, memory_id, role_arn, discovery_url,
           client_id, policy_engine_arn, gateway_name="tenant-memory-validation"):
    """Render the native connector, ENFORCE association, and execution-role fence."""
    if not re.fullmatch(r"\d{12}", account):
        raise ValueError("account must be a 12-digit account ID")
    if not re.fullmatch(r"[a-z0-9-]+", region) or not re.fullmatch(r"[A-Za-z0-9_-]+", gateway_id):
        raise ValueError("Invalid region or Gateway identifier")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", memory_id):
        raise ValueError("Invalid Memory identifier")
    gateway_arn = f"arn:aws:bedrock-agentcore:{region}:{account}:gateway/{gateway_id}"
    policy_gateway_arn = gateway_arn
    if gateway_id == "pending":
        if not re.fullmatch(r"[A-Za-z0-9-]{1,48}", gateway_name):
            raise ValueError("Invalid Gateway name")
        # CreateGateway validates Policy access before returning a Gateway ID.
        # Narrow this bootstrap scope to the returned ARN before adding targets.
        policy_gateway_arn = f"arn:aws:bedrock-agentcore:{region}:{account}:gateway/*"
    memory_arn = f"arn:aws:bedrock-agentcore:{region}:{account}:memory/{memory_id}"
    resources = {
        "create-memory.json": {
            "name": "TenantMemoryValidation", "eventExpiryDuration": 7,
            "memoryStrategies": [{"semanticMemoryStrategy": {
                "name": "TenantFacts", "namespaces": ["/tenants/{actorId}/shared/"],
            }}],
        },
        "create-gateway.json": {
            "name": gateway_name,
            "roleArn": role_arn, "authorizerType": "CUSTOM_JWT",
            "authorizerConfiguration": {"customJWTAuthorizer": {
                "discoveryUrl": discovery_url, "allowedClients": [client_id],
            }},
            "policyEngineConfiguration": {"arn": policy_engine_arn, "mode": "ENFORCE"},
        },
        "create-target.json": {
            "gatewayIdentifier": gateway_id, "name": TARGET,
            "targetConfiguration": {"http": {"connector": {
                "source": {"connectorId": "agentcore-memory"},
                "parameters": {"memoryId": memory_id},
            }}},
            "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
        },
        "gateway-role-policy.json": {
            "Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Action": [f"bedrock-agentcore:{name}" for name in ALLOWED],
                "Resource": memory_arn,
            }, {
                "Effect": "Allow", "Action": [
                    "bedrock-agentcore:AuthorizeAction",
                    "bedrock-agentcore:PartiallyAuthorizeActions"],
                "Resource": [policy_engine_arn, policy_gateway_arn],
            }, {
                "Effect": "Allow", "Action": ["bedrock-agentcore:GetPolicyEngine"],
                "Resource": policy_engine_arn,
            }, {
                "Effect": "Allow", "Action": ["bedrock-agentcore:GetMemory"],
                "Resource": memory_arn,
            }],
        },
        "memory-resource-policy.json": {
            "Version": "2012-10-17", "Statement": [
                {"Sid": "DenyDataAccessOutsideGateway", "Effect": "Deny", "Principal": "*",
                 "Action": [f"bedrock-agentcore:{name}" for name in DATA_ACTIONS],
                 "Resource": memory_arn,
                 "Condition": {"ArnNotEquals": {"aws:PrincipalArn": role_arn}}},
                {"Sid": "AllowGatewayRole", "Effect": "Allow", "Principal": {"AWS": role_arn},
                 "Action": [f"bedrock-agentcore:{name}" for name in ALLOWED],
                 "Resource": memory_arn,
                 "Condition": {"ArnEquals": {"aws:PrincipalArn": role_arn}}},
                {"Sid": "DenyBatchOperationsInValidationMemory", "Effect": "Deny", "Principal": "*",
                 "Action": [f"bedrock-agentcore:{name}" for name in BATCH], "Resource": memory_arn},
            ],
        },
    }
    for filename, operation in [
        ("create-memory.json", "CreateMemory"),
        ("create-gateway.json", "CreateGateway"),
        ("create-target.json", "CreateGatewayTarget"),
    ]:
        model = Session().get_service_model("bedrock-agentcore-control").operation_model(operation)
        validate_parameters(resources[filename], model.input_shape)
    # Each file contains exactly one Cedar statement, matching CreatePolicy's contract.
    for path in (Path(__file__).parent.parent / "policies").glob("*.cedar"):
        statement = path.read_text().replace(FIXTURE_GATEWAY, gateway_arn).replace(FIXTURE_MEMORY, memory_id)
        resources[path.stem + "-policy.json"] = {
            "name": path.stem.replace("-", "_"),
            "policyEngineId": policy_engine_arn.rsplit("/", 1)[-1],
            "definition": {"cedar": {"statement": statement}},
            "validationMode": "FAIL_ON_ANY_FINDINGS", "enforcementMode": "ACTIVE",
        }
        validate_parameters(resources[path.stem + "-policy.json"],
            Session().get_service_model("bedrock-agentcore-control").operation_model("CreatePolicy").input_shape)
    return resources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["region", "account", "gateway-id", "memory-id", "role-arn",
                 "discovery-url", "client-id", "policy-engine-arn"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--output", type=Path, default=Path("generated"))
    args = vars(parser.parse_args())
    output = args.pop("output")
    output.mkdir(parents=True, exist_ok=True)
    for filename, content in render(**args).items():
        (output / filename).write_text(json.dumps(content, indent=2) + "\n")
    print(f"Rendered configuration into {output}. No AWS calls made.")


if __name__ == "__main__":
    main()
