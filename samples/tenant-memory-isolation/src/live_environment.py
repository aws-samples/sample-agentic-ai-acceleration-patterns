# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Provision, exercise, and remove a dedicated synthetic validation environment.

Run from the sample root:
    python -m src.live_environment --region ap-southeast-2 --execute

State contains resource identifiers only and is ignored by Git. Passwords and
tokens stay in process memory. Cleanup only touches resources recorded here.
This SDK driver is a draft integration helper; it is not the repository's CDK
and integ-runner implementation.
"""
import argparse
import base64
import binascii
import io
import json
import os
import secrets
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from .render_config import render
from .test_identity import SCOPES
from .validate_live import run


def assert_token_scope(token, username, client_id):
    """Check issued fixture claims; Gateway independently verifies signatures."""
    actor, session = SCOPES[username]
    expected = {
        "memory_actor": actor, "memory_session": session,
        "memory_namespace": f"/tenants/{actor}/shared/",
        "client_id": client_id,
        "token_use": "access",  # nosec B105
    }
    try:
        _header, payload, _signature = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, binascii.Error, UnicodeDecodeError) as error:
        raise ValueError("Malformed fixture access token") from error
    if not isinstance(claims, dict) or any(
            claims.get(key) != value for key, value in expected.items()):
        raise ValueError("Issued fixture access token has unexpected scope")


def gateway_role_is_propagating(error):
    """Recognise Gateway's specific IAM checks without hiding other errors."""
    detail = error.response["Error"]
    if detail["Code"] not in {"ValidationException", "AccessDeniedException"}:
        return False
    message = detail.get("Message", "")
    return ("AssumeRole" in message or "GenesisPolicyEngineCheck" in message or
            "Access denied while calling GetPolicyEngine" in message)


class LiveEnvironment:
    """Own one isolated run and persist identifiers for interrupted cleanup."""

    def __init__(self, region, state_path):
        self.region = region
        self.path = state_path
        sdk_config = Config(connect_timeout=10, read_timeout=30,
                            retries={"mode": "standard", "max_attempts": 3})
        self.session = boto3.Session(region_name=region)
        self.control = self.session.client("bedrock-agentcore-control", config=sdk_config)
        self.iam = self.session.client("iam", config=sdk_config)
        self.cognito = self.session.client("cognito-idp", config=sdk_config)
        self.functions = self.session.client("lambda", config=sdk_config)
        self.logs = self.session.client("logs", config=sdk_config)
        self.account = self.session.client("sts").get_caller_identity()["Account"]
        self.state = {"region": region, "account": self.account,
                      "runId": uuid.uuid4().hex[:8], "policies": []}
        if state_path.exists():
            saved = json.loads(state_path.read_text())
            if saved["region"] != region or saved["account"] != self.account:
                raise ValueError("Saved state belongs to a different account or Region")
            self.state = saved

    def save(self, **updates):
        """Record only created resource identifiers, never token material."""
        self.state.update(updates)
        self.path.write_text(json.dumps(self.state, indent=2) + "\n")
        self.path.chmod(0o600)

    def create_or_reuse_role(self, role_name, trust):
        """Create a test role, or safely reuse the known empty retained role."""
        try:
            return self.iam.create_role(
                RoleName=role_name,
                AssumeRolePolicyDocument=json.dumps(trust))["Role"]
        except ClientError as error:
            if error.response["Error"]["Code"] != "EntityAlreadyExists":
                raise
        if (self.iam.list_role_policies(RoleName=role_name)["PolicyNames"] or
                self.iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]):
            raise RuntimeError(f"Refusing to reuse non-empty IAM role {role_name}")
        retained_roles = set(self.state.get("retainedRoles", []))
        retained_roles.add(role_name)
        self.save(retainedRoles=sorted(retained_roles))
        self.iam.update_assume_role_policy(
            RoleName=role_name, PolicyDocument=json.dumps(trust))
        print(f"REUSE empty retained IAM role {role_name}", flush=True)
        return self.iam.get_role(RoleName=role_name)["Role"]

    @staticmethod
    def wait(fetch, expected, label, timeout=600):
        """Wait for readiness, rejecting terminal failures and timeouts."""
        deadline = time.monotonic() + timeout
        last_message = 0
        while True:
            result = fetch()
            status = result.get("status", result.get("State"))
            if status == expected:
                print(f"READY {label}", flush=True)
                return result
            if status and ("FAIL" in status.upper() or "UNSUCCESSFUL" in status):
                raise RuntimeError(f"{label} failed: {result.get('statusReasons', [])}")
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{label} did not become {expected}")
            if time.monotonic() - last_message >= 30:
                print(f"WAIT {label}: {status}", flush=True)
                last_message = time.monotonic()
            time.sleep(5)

    def provision(self):
        """Create a throwaway issuer and the sample's native Memory path."""
        if self.state.get("cleanedUp"):
            history = Path(".live-history")
            history.mkdir(exist_ok=True)
            previous = history / (self.state["runId"] + ".json")
            previous.write_text(json.dumps(self.state, indent=2) + "\n")
            previous.chmod(0o600)
            self.state = {"region": self.region, "account": self.account,
                          "runId": uuid.uuid4().hex[:8], "policies": []}
        if any(key in self.state for key in ["poolId", "memoryId", "gatewayId"]):
            raise ValueError("Existing deployment state requires cleanup first")
        suffix = self.state["runId"]
        name = f"tenant-memory-{suffix}"
        trust = {"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }]}
        identity_role = self.create_or_reuse_role(
            self.state.get("identityRole", name + "-issuer"), trust)
        self.save(identityRole=identity_role["RoleName"])
        function_name = name + "-issuer"
        log_group = f"/aws/lambda/{function_name}"
        self.logs.create_log_group(logGroupName=log_group)
        self.save(logGroup=log_group)
        self.logs.put_retention_policy(logGroupName=log_group, retentionInDays=1)
        self.iam.put_role_policy(
            RoleName=identity_role["RoleName"], PolicyName="IssuerLogs",
            PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
                "Resource": f"arn:aws:logs:{self.region}:{self.account}:log-group:{log_group}:*",
            }]}))
        code = io.BytesIO()
        with zipfile.ZipFile(code, "w") as archive:
            archive.writestr("test_identity.py",
                             Path(__file__).with_name("test_identity.py").read_text())
        for attempt in range(12):
            try:
                function = self.functions.create_function(
                    FunctionName=function_name, Runtime="python3.12",
                    Role=identity_role["Arn"], Handler="test_identity.handler",
                    Code={"ZipFile": code.getvalue()}, Timeout=10, MemorySize=128)
                break
            except ClientError as error:
                if (error.response["Error"]["Code"] != "InvalidParameterValueException"
                        or "assumed" not in error.response["Error"].get("Message", "")
                        or attempt == 11):
                    raise
                time.sleep(5)
        self.save(functionName=function_name)
        self.wait(lambda: self.functions.get_function_configuration(
            FunctionName=function_name), "Active", "Cognito issuer")
        pool = self.cognito.create_user_pool(
            PoolName=name, UserPoolTier="ESSENTIALS",
            AdminCreateUserConfig={"AllowAdminCreateUserOnly": True},
            DeletionProtection="INACTIVE")["UserPool"]
        pool_id = pool["Id"]
        self.save(poolId=pool_id)
        self.functions.add_permission(
            FunctionName=function_name, StatementId="CognitoOnly",
            Action="lambda:InvokeFunction", Principal="cognito-idp.amazonaws.com",
            SourceAccount=self.account,
            SourceArn=f"arn:aws:cognito-idp:{self.region}:{self.account}:userpool/{pool_id}")
        self.cognito.update_user_pool(
            UserPoolId=pool_id, UserPoolTier="ESSENTIALS",
            AdminCreateUserConfig={"AllowAdminCreateUserOnly": True},
            LambdaConfig={"PreTokenGenerationConfig": {
                "LambdaVersion": "V2_0", "LambdaArn": function["FunctionArn"]}})
        app = self.cognito.create_user_pool_client(
            UserPoolId=pool_id, ClientName="validation",
            GenerateSecret=False, ExplicitAuthFlows=["ALLOW_ADMIN_USER_PASSWORD_AUTH"],
            AccessTokenValidity=60, IdTokenValidity=60,
            TokenValidityUnits={"AccessToken": "minutes", "IdToken": "minutes"},
            WriteAttributes=["email"], EnableTokenRevocation=True)["UserPoolClient"]
        self.save(clientId=app["ClientId"])
        passwords = {}
        for username in SCOPES:
            password = secrets.token_urlsafe(24) + "Aa1!"
            self.cognito.admin_create_user(
                UserPoolId=pool_id, Username=username, MessageAction="SUPPRESS")
            self.cognito.admin_set_user_password(
                UserPoolId=pool_id, Username=username, Password=password, Permanent=True)
            passwords[username] = password

        engine = self.control.create_policy_engine(name=f"TenantMemory_{suffix}")
        self.save(policyEngineId=engine["policyEngineId"],
                  policyEngineArn=engine["policyEngineArn"])
        self.wait(lambda: self.control.get_policy_engine(
            policyEngineId=engine["policyEngineId"]), "ACTIVE", "Policy engine")
        memory = self.control.create_memory(
            name=f"TenantMemory_{suffix}", eventExpiryDuration=7,
            memoryStrategies=[{"semanticMemoryStrategy": {
                "name": "TenantFacts", "namespaces": ["/tenants/{actorId}/shared/"]}}])["memory"]
        self.save(memoryId=memory["id"], memoryArn=memory["arn"])
        self.wait(lambda: self.control.get_memory(
            memoryId=memory["id"])["memory"], "ACTIVE", "Memory")
        gateway_trust = {"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {"StringEquals": {"aws:SourceAccount": self.account},
                          "ArnLike": {"aws:SourceArn":
                              f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:*"}},
        }]}
        role = self.create_or_reuse_role(
            self.state.get("gatewayRole", name + "-gateway"), gateway_trust)
        self.save(gatewayRole=role["RoleName"])
        discovery = f"https://cognito-idp.{self.region}.amazonaws.com/{pool_id}/.well-known/openid-configuration"
        config = render(self.region, self.account, "pending", memory["id"], role["Arn"],
                        discovery, app["ClientId"], engine["policyEngineArn"],
                        gateway_name=name)
        self.iam.put_role_policy(
            RoleName=role["RoleName"], PolicyName="ScopedMemory",
            PolicyDocument=json.dumps(config["gateway-role-policy.json"]))
        gateway_request = config["create-gateway.json"]
        gateway_request["name"] = name
        gateway_request["exceptionLevel"] = "DEBUG"
        # Newly created IAM roles are eventually consistent at service callers.
        for attempt in range(24):
            try:
                gateway = self.control.create_gateway(**gateway_request)
                break
            except ClientError as error:
                if not gateway_role_is_propagating(error) or attempt == 23:
                    raise
                print("WAIT Gateway role/Policy permission propagation", flush=True)
                time.sleep(5)
        self.save(gatewayId=gateway["gatewayId"], gatewayArn=gateway["gatewayArn"])
        gateway = self.wait(lambda: self.control.get_gateway(
            gatewayIdentifier=gateway["gatewayId"]), "READY", "Gateway")
        del gateway_trust["Statement"][0]["Condition"]["ArnLike"]
        gateway_trust["Statement"][0]["Condition"]["ArnEquals"] = {
            "aws:SourceArn": [gateway["gatewayArn"], engine["policyEngineArn"]]}
        self.iam.update_assume_role_policy(
            RoleName=role["RoleName"], PolicyDocument=json.dumps(gateway_trust))
        config = render(self.region, self.account, gateway["gatewayId"], memory["id"],
                        role["Arn"], discovery, app["ClientId"], engine["policyEngineArn"],
                        gateway_name=name)
        self.iam.put_role_policy(
            RoleName=role["RoleName"], PolicyName="ScopedMemory",
            PolicyDocument=json.dumps(config["gateway-role-policy.json"]))
        target = self.control.create_gateway_target(**config["create-target.json"])
        self.save(targetId=target["targetId"])
        self.wait(lambda: self.control.get_gateway_target(
            gatewayIdentifier=gateway["gatewayId"], targetId=target["targetId"]),
            "READY", "native Memory target")
        for key in ["event-write", "shared-recall"]:
            policy = self.control.create_policy(**config[key + "-policy.json"])
            self.state["policies"].append(policy["policyId"])
            self.save()
            self.wait(lambda: self.control.get_policy(
                policyEngineId=engine["policyEngineId"], policyId=policy["policyId"]),
                "ACTIVE", key)
        self.control.put_resource_policy(
            resourceArn=memory["arn"],
            policy=json.dumps(config["memory-resource-policy.json"]))
        # Issue fresh access tokens after provisioning and confirm the V2 trigger
        # supplied every entitlement before starting the authorization matrix.
        for username, password in passwords.items():
            for attempt in range(24):
                auth = self.cognito.admin_initiate_auth(
                    UserPoolId=pool_id, ClientId=app["ClientId"],
                    AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                    AuthParameters={"USERNAME": username, "PASSWORD": password})
                token = auth["AuthenticationResult"]["AccessToken"]
                try:
                    assert_token_scope(token, username, app["ClientId"])
                    break
                except ValueError:
                    if attempt == 23:
                        raise
                    print(f"WAIT {username}: issuer scope propagation", flush=True)
                    time.sleep(5)
            os.environ[username.upper().replace("-", "_") + "_TOKEN"] = token
            print(f"READY {username}: verified issued fixture scope", flush=True)
        passwords.clear()
        live = {
            "region": self.region, "memoryId": memory["id"], "memoryArn": memory["arn"],
            "gatewayId": gateway["gatewayId"], "gatewayArn": gateway["gatewayArn"],
            "gatewayRoleArn": role["Arn"],
            "gatewayUrl": gateway["gatewayUrl"], "targetName": "tenant-memory",
            "targetId": target["targetId"], "identities": {
                username: {"actorId": actor, "sessionId": session,
                           "namespacePath": f"/tenants/{actor}/shared/",
                           "tokenEnv": username.upper().replace("-", "_") + "_TOKEN"}
                for username, (actor, session) in SCOPES.items()
            },
        }
        Path("live-config.json").write_text(json.dumps(live, indent=2) + "\n")
        Path("live-config.json").chmod(0o600)
        return live

    def cleanup(self):
        """Delete only this run's journalled resources and verify removal."""
        errors = []

        def settle(key, fetch):
            try:
                self.wait_absent(fetch)
            except Exception as error:
                errors.append({"resource": key, "error": type(error).__name__})

        def remove(key, function, display_label=None, **arguments):
            if key not in self.state:
                return
            try:
                function(**arguments)
                print(f"DELETE {display_label or key}", flush=True)
            except ClientError as error:
                if error.response["Error"]["Code"] not in {
                    "ResourceNotFoundException", "ResourceNotFound", "NoSuchEntity",
                    "UserPoolNotFoundException"}:
                    errors.append({"resource": key, "error": error.response["Error"]["Code"]})

        if "targetId" in self.state:
            remove("targetId", self.control.delete_gateway_target,
                   gatewayIdentifier=self.state["gatewayId"], targetId=self.state["targetId"])
            settle("targetId", lambda: self.control.get_gateway_target(
                gatewayIdentifier=self.state["gatewayId"], targetId=self.state["targetId"]))
        if "gatewayId" in self.state:
            remove("gatewayId", self.control.delete_gateway,
                   gatewayIdentifier=self.state["gatewayId"])
            settle("gatewayId", lambda: self.control.get_gateway(
                gatewayIdentifier=self.state["gatewayId"]))
        for policy_id in self.state["policies"]:
            try:
                self.control.delete_policy(
                    policyEngineId=self.state["policyEngineId"], policyId=policy_id)
                settle("policy", lambda: self.control.get_policy(
                    policyEngineId=self.state["policyEngineId"], policyId=policy_id))
            except ClientError as error:
                if error.response["Error"]["Code"] != "ResourceNotFoundException":
                    errors.append({"resource": "policy", "error": error.response["Error"]["Code"]})
        if "policyEngineId" in self.state:
            remove("policyEngineId", self.control.delete_policy_engine,
                   policyEngineId=self.state["policyEngineId"])
            settle("policyEngineId", lambda: self.control.get_policy_engine(
                policyEngineId=self.state["policyEngineId"]))
        if "memoryId" in self.state:
            remove("memoryId", self.control.delete_memory, memoryId=self.state["memoryId"])
            settle("memoryId", lambda: self.control.get_memory(memoryId=self.state["memoryId"]))
        remove("poolId", self.cognito.delete_user_pool, UserPoolId=self.state.get("poolId"))
        remove("functionName", self.functions.delete_function,
               FunctionName=self.state.get("functionName"))
        for key, policy_name in [("gatewayRole", "ScopedMemory"), ("identityRole", "IssuerLogs")]:
            if key in self.state:
                remove(key, self.iam.delete_role_policy,
                       display_label=f"{key} inline policy",
                       RoleName=self.state[key], PolicyName=policy_name)
                if self.state[key] in self.state.get("retainedRoles", []):
                    print(f"RETAIN pre-existing empty role {self.state[key]}", flush=True)
                else:
                    remove(key, self.iam.delete_role, RoleName=self.state[key])
        remove("logGroup", self.logs.delete_log_group, logGroupName=self.state.get("logGroup"))
        for username in SCOPES:
            os.environ.pop(username.upper().replace("-", "_") + "_TOKEN", None)
        self.save(cleanupErrors=errors, cleanedUp=not errors)
        if errors:
            raise RuntimeError("Cleanup incomplete; inspect ignored live-state.json")
        print("CLEANUP complete for journalled test resources", flush=True)

    @staticmethod
    def wait_absent(fetch, timeout=600):
        """Confirm an asynchronous control-plane deletion completed."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                fetch()
            except ClientError as error:
                if error.response["Error"]["Code"] in {
                    "ResourceNotFoundException", "ResourceNotFound", "NoSuchEntity"}:
                    return
                raise
            time.sleep(5)
        raise TimeoutError("Resource deletion did not complete")


def main():
    """Require explicit execution; always clean up after validation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--state", type=Path, default=Path("live-state.json"))
    parser.add_argument("--report", type=Path, default=Path("live-report.json"))
    args = parser.parse_args()
    if not args.execute:
        print("DRY RUN: dedicated Cognito issuer, Lambda, Memory, Gateway, Policy; then teardown.")
        print("No AWS calls made. Pass --execute to provision and validate.")
        return
    env = LiveEnvironment(args.region, args.state)
    if args.cleanup:
        env.cleanup()
        return
    if env.state.get("cleanedUp"):
        history = Path(".live-history")
        history.mkdir(exist_ok=True)
        for filename in [args.report, Path("live-diagnostics.json")]:
            if filename.exists():
                filename.rename(history / (env.state["runId"] + "-" + filename.name))
    try:
        config = env.provision()
        results = run(config, 600, args.report)
        if any(case["result"] == "FAILED" for case in results):
            raise AssertionError("Live matrix has failed cases")
    except Exception as error:
        diagnostic = {
            "date": datetime.now(timezone.utc).isoformat(), "errorType": type(error).__name__}
        if isinstance(error, ClientError):
            diagnostic["serviceError"] = error.response.get("Error")
            diagnostic["requestId"] = error.response.get("ResponseMetadata", {}).get("RequestId")
        elif isinstance(error, RuntimeError):
            diagnostic["message"] = str(error)
        if hasattr(error, "diagnostic"):
            diagnostic["gateway"] = error.diagnostic
        diagnostic_path = Path("live-diagnostics.json")
        diagnostic_path.write_text(json.dumps(diagnostic, indent=2) + "\n")
        diagnostic_path.chmod(0o600)
        if not args.report.exists():
            args.report.write_text(json.dumps({
                "status": "FAILED", "region": args.region,
                "date": diagnostic["date"], "results": [],
                "errorType": diagnostic["errorType"],
                "note": "Provisioning failed before the live authorization matrix.",
            }, indent=2) + "\n")
        print(f"LIVE FAILED ({type(error).__name__}); inspect ignored live-diagnostics.json", flush=True)
        raise
    finally:
        env.cleanup()


if __name__ == "__main__":
    main()
