#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Probes the shipped cell policies (README, "Probe the policies"; ported from the path spike's
# probes.sh). It assumes each probe role in turn, whose own policy allows every escalation on
# `*`, and checks that its boundary refuses each one while the controls still work:
#
# - as cell/cell-policy-probe, under the cell permissions boundary (the execution role's cap);
# - as cell/cell-policy-probe-workload, under the cell workload boundary (every role a cell
#   creates, ADR-0011).
#
# Every write a probe tries lands on something the account does not use, so a probe that a
# regressed policy lets through changes nothing that matters: the decoy role on / and the
# decoy policy of the CellBoundaryProbe stack, new parameter names under the owner's paths,
# and the API Gateway account setting set to the value it already has. A probe that names a
# cdk-cell bootstrap role only tries to assume it. probe-remove.sh lists anything a
# let-through probe left behind.
#
# A deny probe passes only when the error names an explicit deny in a permissions boundary.
# Before the first probe of each role it checks that the CLI runs as that role, and stops
# with exit 2 when it does not. Exit code: the number of failed probes.
#
#   AWS_REGION=eu-central-1 [CELL_POLICY_SUFFIX=-v2] stress/application/probes.sh
set -uo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
suffix="${CELL_POLICY_SUFFIX:-}"
[[ "$suffix" =~ ^(-[a-z0-9]{1,16})?$ ]] || { echo "bad CELL_POLICY_SUFFIX" >&2; exit 2; }
for tool in aws zip; do command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 2; }; done

caller="$(aws sts get-caller-identity --query Arn --output text)" || exit 2
account="$(aws sts get-caller-identity --query Account --output text)" || exit 2
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 2; }
partition="${caller#arn:}"; partition="${partition%%:*}"
iam_arn() { echo "arn:${partition}:iam::${account}:$1"; }
echo "account=${account} region=${region}"

decoy="cell-policy-probe-decoy"
decoy_arn="$(iam_arn "role/${decoy}")"
decoy_policy="$(iam_arn "policy/cell-policy-probe-decoy")"
decoy_path="$(aws iam get-role --role-name "$decoy" --query Role.Path --output text)" || { echo "no ${decoy}: run probe-deploy.sh first" >&2; exit 2; }
[[ "$decoy_path" == "/" ]] || { echo "${decoy} is on ${decoy_path}, not /" >&2; exit 2; }
# The probes of the API Gateway account setting write the value it already has.
logs_role="$(aws apigateway get-account --query cloudwatchRoleArn --output text)" || exit 2
[[ "$logs_role" == arn:* ]] || { echo "the API Gateway account has no CloudWatch Logs role: run deploy-owner.sh first" >&2; exit 2; }
deploy="cdk-cell-deploy-role-${account}-${region}"
target="cell-policy-probe-target"
target_arn="$(iam_arn "role/cell/${target}")"
tenant_arn="$(iam_arn "role/cell/cell-policy-probe-tenant")"
created="cell-policy-probe-created"
fn="cell-policy-probe-fn"
boundary="$(iam_arn "policy/cell-permissions-boundary${suffix}")"
workload="$(iam_arn "policy/cell-workload-boundary${suffix}")"

# One set of keys per probe role. No shared config or credentials file and no instance
# metadata: the probe role's keys are the only ones the CLI can find.
declare -A KEY SECRET SESSION
assume() {
  local who="$1" role="$2" out
  out="$(aws sts assume-role --role-arn "$(iam_arn "role/cell/${role}")" --role-session-name cell-policy-probe \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)" || { echo "could not assume cell/${role}" >&2; exit 2; }
  read -r KEY[$who] SECRET[$who] SESSION[$who] <<<"$out"
  [[ -n "${KEY[$who]}" && -n "${SECRET[$who]}" && -n "${SESSION[$who]}" ]] || { echo "no keys for cell/${role}" >&2; exit 2; }
  local seen
  seen="$(as "$who" sts get-caller-identity --query Arn --output text)"
  [[ "$seen" == "arn:${partition}:sts::${account}:assumed-role/${role}/cell-policy-probe" ]] \
    || { echo "probes would run as ${seen}, not cell/${role}" >&2; exit 2; }
}
as() {
  local who="$1"; shift
  env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
    AWS_ACCESS_KEY_ID="${KEY[$who]}" AWS_SECRET_ACCESS_KEY="${SECRET[$who]}" AWS_SESSION_TOKEN="${SESSION[$who]}" AWS_REGION="$region" aws "$@"
}

fails=0
passes=0
# Runs one call as a probe role, waiting out throttling: the API Gateway account setting takes
# few calls per second, and two probes change it within seconds of each other.
OUT=""
call() {
  local who="$1" attempt rc; shift
  for attempt in 1 2 3 4 5; do
    OUT="$(as "$who" "$@" 2>&1)"; rc=$?
    grep -qE 'TooManyRequestsException|ThrottlingException|Rate exceeded' <<<"$OUT" || return "$rc"
    sleep $((attempt * 5))
  done
  return "$rc"
}
expect_denied() {
  local who="$1" name="$2"; shift 2
  local rc out
  call "$who" "$@"; rc=$?; out="$OUT"
  if [[ $rc -eq 0 ]]; then
    echo "FAIL  [${who}] ${name}: allowed (run probe-remove.sh: it lists what this left)"; fails=$((fails + 1))
  elif grep -qi 'explicit deny in a permissions boundary' <<<"$out"; then
    echo "PASS  [${who}] ${name}: explicit deny in the permissions boundary"; passes=$((passes + 1))
  else
    echo "FAIL  [${who}] ${name}: unexpected error: $(tr -s "\n" " " <<<"$out" | head -c 400)"; fails=$((fails + 1))
  fi
}
expect_allowed() {
  local who="$1" name="$2"; shift 2
  if call "$who" "$@"; then echo "PASS  [${who}] ${name}: allowed"; passes=$((passes + 1))
  else echo "FAIL  [${who}] ${name}: $(tr -s "\n" " " <<<"$OUT" | head -c 400)"; fails=$((fails + 1)); fi
}

trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::111122223333:root"},"Action":"sts:AssumeRole"}]}'
admin='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'
nothing='{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'
lambda_trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
logs_policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"delivery.logs.amazonaws.com"},"Action":"logs:PutLogEvents","Resource":"*","Condition":{"StringEquals":{"aws:SourceAccount":"111122223333"}}}]}'
# DynamoDB and KMS check the resource before IAM, so these probes aim at the decoy table and key.
table_arn="arn:${partition}:dynamodb:${region}:${account}:table/cell-policy-probe-decoy"
key_arn="$(aws kms describe-key --key-id alias/cell-policy-probe-decoy --query KeyMetadata.Arn --output text)" || { echo "no decoy key: run probe-deploy.sh first" >&2; exit 2; }
table_policy="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"dynamodb:GetItem\",\"Resource\":\"${table_arn}\"}]}"
key_policy="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:${partition}:iam::${account}:root\"},\"Action\":\"kms:*\",\"Resource\":\"*\"}]}"
scratch="$(mktemp -d)"
trap 'rm -f "${scratch}/fn.py" "${scratch}/fn.zip"; rmdir "$scratch" 2>/dev/null || true' EXIT
printf 'def h(e, c):\n    return 0\n' > "${scratch}/fn.py"
(cd "$scratch" && zip -q fn.zip fn.py)
zip_file="fileb://${scratch}/fn.zip"
lambda_args=(--runtime python3.12 --handler fn.h --zip-file "$zip_file")

# ---- cell/cell-policy-probe, under the cell permissions boundary ----
assume cell cell-policy-probe
# Leftovers of an interrupted run would turn the create controls into failures.
as cell iam delete-role --role-name "$created" >/dev/null 2>&1 || true
as cell lambda delete-function --function-name "$fn" >/dev/null 2>&1 || true

expect_denied cell "UpdateAssumeRolePolicy on a role on / (decoy)" iam update-assume-role-policy --role-name "$decoy" --policy-document "$trust"
expect_denied cell "PutRolePolicy on a role on / (decoy)" iam put-role-policy --role-name "$decoy" --policy-name cell-probe --policy-document "$admin"
expect_denied cell "AttachRolePolicy AdministratorAccess on a role on / (decoy)" iam attach-role-policy --role-name "$decoy" --policy-arn "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied cell "AssumeRole of a role on / (decoy)" sts assume-role --role-arn "$decoy_arn" --role-session-name cell-probe
expect_denied cell "AssumeRole of the cdk-cell deploy role" sts assume-role --role-arn "$(iam_arn "role/${deploy}")" --role-session-name cell-probe
expect_denied cell "PassRole of a role on / to Lambda (decoy)" lambda create-function --function-name cell-policy-probe-pass "${lambda_args[@]}" --role "$decoy_arn"
expect_denied cell "PassRole of a /cell/ role to a service the cell does not use" logs put-destination --destination-name cell-policy-probe --target-arn "arn:${partition}:kinesis:${region}:${account}:stream/cell-policy-probe" --role-arn "$target_arn"
expect_denied cell "CreateRole on / with the workload boundary" iam create-role --role-name cell-probe-root-path --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload"
expect_denied cell "CreateRole on /cell/ without a boundary" iam create-role --role-name cell-probe-no-boundary --path /cell/ --assume-role-policy-document "$lambda_trust"
expect_denied cell "CreateRole on /cell/ with the cell permissions boundary (a cell role takes the workload boundary)" iam create-role --role-name cell-probe-cell-boundary --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$boundary"
expect_denied cell "CreateServiceLinkedRole for another service" iam create-service-linked-role --aws-service-name elasticloadbalancing.amazonaws.com
expect_denied cell "DeleteRolePermissionsBoundary on itself" iam delete-role-permissions-boundary --role-name cell-policy-probe
expect_denied cell "PutRolePermissionsBoundary AdministratorAccess on a /cell/ role" iam put-role-permissions-boundary --role-name "$target" --permissions-boundary "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied cell "PutRolePermissionsBoundary: the cell permissions boundary on a /cell/ role" iam put-role-permissions-boundary --role-name "$target" --permissions-boundary "$boundary"
expect_denied cell "CreatePolicyVersion on a customer managed policy (decoy)" iam create-policy-version --policy-arn "$decoy_policy" --policy-document "$nothing"
expect_denied cell "SetDefaultPolicyVersion on a customer managed policy (decoy)" iam set-default-policy-version --policy-arn "$decoy_policy" --version-id v1
expect_denied cell "CreateUser" iam create-user --user-name cell-policy-probe-user
expect_denied cell "CreateAccessKey" iam create-access-key --user-name cell-policy-probe-user
expect_denied cell "CreatePolicy" iam create-policy --policy-name cell-policy-probe-created --policy-document "$nothing"
expect_denied cell "PutParameter under the identity path" ssm put-parameter --name /application-plane/shared/identity/cell-policy-probe --type String --value cell-probe
expect_denied cell "PutParameter under the cell bootstrap path" ssm put-parameter --name /cdk-bootstrap/cell/cell-policy-probe --type String --value cell-probe
expect_denied cell "UpdateAccount: the API Gateway logs role (to its current value)" apigateway update-account --patch-operations "op=replace,path=/cloudwatchRoleArn,value=${logs_role}"
slr_out="$(as cell iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com 2>&1)"
slr_rc=$?
if [[ $slr_rc -eq 0 ]]; then
  echo "PASS  [cell] CreateServiceLinkedRole for API Gateway (control): allowed (created)"; passes=$((passes + 1))
elif grep -q 'has been taken' <<<"$slr_out"; then
  echo "PASS  [cell] CreateServiceLinkedRole for API Gateway (control): allowed (already present)"; passes=$((passes + 1))
else
  echo "FAIL  [cell] CreateServiceLinkedRole for API Gateway: $(tr -s "\n" " " <<<"$slr_out" | head -c 400)"; fails=$((fails + 1))
fi
expect_allowed cell "UpdateRoleDescription on a /cell/ role (control)" iam update-role-description --role-name "$target" --description "changed by the cell policy probe"
expect_allowed cell "CreateRole on /cell/ with the workload boundary (control)" iam create-role --role-name "$created" --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload" --query Role.Arn --output text
expect_allowed cell "DeleteRole of that /cell/ role (control)" iam delete-role --role-name "$created"
expect_allowed cell "PutRolePermissionsBoundary: re-bound a /cell/ role to the workload boundary (control)" iam put-role-permissions-boundary --role-name "$target" --permissions-boundary "$workload"
expect_allowed cell "PassRole of a /cell/ role to Lambda (control)" lambda create-function --function-name "$fn" "${lambda_args[@]}" --role "$target_arn" --query FunctionArn --output text
expect_denied cell "CreateFunctionUrlConfig with AuthType NONE" lambda create-function-url-config --function-name "$fn" --auth-type NONE
expect_denied cell "AddPermission for a public function URL (AuthType NONE)" lambda add-permission --function-name "$fn" --statement-id cell-probe-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
expect_allowed cell "GetRole on a role on / (read stays open)" iam get-role --role-name "$decoy" --query Role.Path --output text

# ---- cell/cell-policy-probe-workload, under the cell workload boundary ----
assume workload cell-policy-probe-workload
expect_denied workload "UpdateRoleDescription on a /cell/ role" iam update-role-description --role-name "$target" --description "changed by the workload probe"
expect_denied workload "PutRolePolicy on a /cell/ role" iam put-role-policy --role-name "$target" --policy-name cell-probe --policy-document "$admin"
expect_denied workload "CreateRole on /cell/ with the workload boundary" iam create-role --role-name cell-probe-workload-create --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload"
expect_denied workload "PassRole of a /cell/ role to Lambda" lambda create-function --function-name cell-policy-probe-workload-pass "${lambda_args[@]}" --role "$target_arn"
expect_denied workload "CreateServiceLinkedRole for API Gateway" iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com
expect_denied workload "DeleteRolePermissionsBoundary on itself" iam delete-role-permissions-boundary --role-name cell-policy-probe-workload
expect_denied workload "AssumeRole of the cdk-cell deploy role" sts assume-role --role-arn "$(iam_arn "role/${deploy}")" --role-session-name cell-probe
expect_denied workload "AssumeRole of a role on / (decoy)" sts assume-role --role-arn "$decoy_arn" --role-session-name cell-probe
expect_denied workload "PutParameter under the identity path" ssm put-parameter --name /application-plane/shared/identity/cell-policy-probe --type String --value cell-probe
expect_denied workload "PutParameter under the cell bootstrap path" ssm put-parameter --name /cdk-bootstrap/cell/cell-policy-probe --type String --value cell-probe
expect_denied workload "UpdateAccount: the API Gateway logs role (to its current value)" apigateway update-account --patch-operations "op=replace,path=/cloudwatchRoleArn,value=${logs_role}"
expect_denied workload "AddPermission on a cell function" lambda add-permission --function-name "$fn" --statement-id cell-probe-share --action lambda:InvokeFunction --principal s3.amazonaws.com
expect_denied workload "CreateFunctionUrlConfig with AuthType NONE" lambda create-function-url-config --function-name "$fn" --auth-type NONE
expect_denied workload "logs PutResourcePolicy" logs put-resource-policy --policy-name cell-policy-probe --policy-document "$logs_policy"
expect_denied workload "dynamodb PutResourcePolicy" dynamodb put-resource-policy --resource-arn "$table_arn" --policy "$table_policy"
expect_denied workload "kms PutKeyPolicy" kms put-key-policy --key-id "$key_arn" --policy-name default --policy "$key_policy"
expect_allowed workload "AssumeRole of a /cell/ tenant role, as the TVM does (control)" sts assume-role --role-arn "$tenant_arn" --role-session-name cell-probe --query AssumedRoleUser.Arn --output text

# The PassRole control's function goes again; the probe role created it.
expect_allowed cell "DeleteFunction of the control function (cleanup)" lambda delete-function --function-name "$fn"

echo "probes passed: ${passes} failed: ${fails}"
exit "$fails"
