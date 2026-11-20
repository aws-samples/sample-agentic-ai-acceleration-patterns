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
# A deny probe passes only when the error names an explicit deny in a permissions boundary.
# Before the first probe of each role it checks that the CLI runs as that role, and stops
# with exit 2 when it does not. Exit code: the number of failed probes.
#
#   AWS_REGION=eu-central-1 CELL_ROLE_PAIR_ROLE=<name of a role on / that trusts the account> \
#     [CELL_POLICY_SUFFIX=-v2] stress/application/probes.sh
#
# CELL_ROLE_PAIR_ROLE is the role the probes aim at outside /cell/: in a cell account, the role
# pair's cell role.
set -uo pipefail

region="${AWS_REGION:?AWS_REGION is required}"
pair="${CELL_ROLE_PAIR_ROLE:?CELL_ROLE_PAIR_ROLE is required: a role on / in this account}"
suffix="${CELL_POLICY_SUFFIX:-}"
[[ "$suffix" =~ ^(-[a-z0-9]{1,16})?$ ]] || { echo "bad CELL_POLICY_SUFFIX" >&2; exit 2; }
for tool in aws zip; do command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 2; }; done

caller="$(aws sts get-caller-identity --query Arn --output text)" || exit 2
account="$(aws sts get-caller-identity --query Account --output text)" || exit 2
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 2; }
partition="${caller#arn:}"; partition="${partition%%:*}"
iam_arn() { echo "arn:${partition}:iam::${account}:$1"; }

pair_arn="$(iam_arn "role/${pair}")"
pair_path="$(aws iam get-role --role-name "$pair" --query Role.Path --output text)" || { echo "no role ${pair}" >&2; exit 2; }
[[ "$pair_path" == "/" ]] || { echo "${pair} is on ${pair_path}, not /" >&2; exit 2; }
deploy="cdk-cell-deploy-role-${account}-${region}"
target="cell-policy-probe-target"
target_arn="$(iam_arn "role/cell/${target}")"
tenant_arn="$(iam_arn "role/cell/cell-policy-probe-tenant")"
created="cell-policy-probe-created"
boundary="$(iam_arn "policy/cell-permissions-boundary${suffix}")"
workload="$(iam_arn "policy/cell-workload-boundary${suffix}")"
execution="$(iam_arn "policy/cell-execution-policy${suffix}")"

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
    echo "FAIL  [${who}] ${name}: allowed"; fails=$((fails + 1))
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
lambda_trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
scratch="$(mktemp -d)"
trap 'rm -f "${scratch}/fn.py" "${scratch}/fn.zip"; rmdir "$scratch" 2>/dev/null || true' EXIT
printf 'def h(e, c):\n    return 0\n' > "${scratch}/fn.py"
(cd "$scratch" && zip -q fn.zip fn.py)
zip_file="fileb://${scratch}/fn.zip"

# ---- cell/cell-policy-probe, under the cell permissions boundary ----
assume cell cell-policy-probe
# A leftover from an interrupted run would turn the create control into a failure.
as cell iam delete-role --role-name "$created" >/dev/null 2>&1 || true

expect_denied cell "UpdateAssumeRolePolicy on the role pair" iam update-assume-role-policy --role-name "$pair" --policy-document "$trust"
expect_denied cell "PutRolePolicy on the role pair" iam put-role-policy --role-name "$pair" --policy-name cell-probe --policy-document "$admin"
expect_denied cell "PutRolePolicy on a cdk-cell bootstrap role" iam put-role-policy --role-name "$deploy" --policy-name cell-probe --policy-document "$admin"
expect_denied cell "AttachRolePolicy AdministratorAccess on the role pair" iam attach-role-policy --role-name "$pair" --policy-arn "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied cell "AssumeRole of the role pair" sts assume-role --role-arn "$pair_arn" --role-session-name cell-probe
expect_denied cell "AssumeRole of the cdk-cell deploy role" sts assume-role --role-arn "$(iam_arn "role/${deploy}")" --role-session-name cell-probe
expect_denied cell "PassRole of a role outside /cell/" lambda create-function --function-name cell-policy-probe-pass --runtime python3.12 --handler fn.h --zip-file "$zip_file" --role "$pair_arn"
expect_denied cell "PassRole of a /cell/ role to a service the cell does not use" logs put-destination --destination-name cell-policy-probe --target-arn "arn:${partition}:kinesis:${region}:${account}:stream/cell-policy-probe" --role-arn "$target_arn"
expect_denied cell "CreateRole on / with the workload boundary" iam create-role --role-name cell-probe-root-path --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload"
expect_denied cell "CreateRole on /cell/ without a boundary" iam create-role --role-name cell-probe-no-boundary --path /cell/ --assume-role-policy-document "$lambda_trust"
expect_denied cell "CreateRole on /cell/ with the cell permissions boundary (a cell role takes the workload boundary)" iam create-role --role-name cell-probe-cell-boundary --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$boundary"
expect_denied cell "CreateServiceLinkedRole for another service" iam create-service-linked-role --aws-service-name elasticloadbalancing.amazonaws.com
expect_denied cell "DeleteRolePermissionsBoundary on itself" iam delete-role-permissions-boundary --role-name cell-policy-probe
expect_denied cell "AttachRolePolicy AdministratorAccess on a cdk-cell bootstrap role" iam attach-role-policy --role-name "$deploy" --policy-arn "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied cell "PutRolePermissionsBoundary AdministratorAccess on a /cell/ role" iam put-role-permissions-boundary --role-name "$target" --permissions-boundary "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied cell "PutRolePermissionsBoundary: the cell permissions boundary on a /cell/ role" iam put-role-permissions-boundary --role-name "$target" --permissions-boundary "$boundary"
expect_denied cell "CreatePolicyVersion on the cell permissions boundary" iam create-policy-version --policy-arn "$boundary" --policy-document "$admin" --set-as-default
expect_denied cell "CreatePolicyVersion on the workload boundary" iam create-policy-version --policy-arn "$workload" --policy-document "$admin" --set-as-default
expect_denied cell "SetDefaultPolicyVersion on the execution policy" iam set-default-policy-version --policy-arn "$execution" --version-id v1
expect_denied cell "PutParameter over the identity pool id" ssm put-parameter --name /application-plane/shared/identity/userPoolId --type String --value cell-probe --overwrite
expect_denied cell "PutParameter over the cell bootstrap version" ssm put-parameter --name /cdk-bootstrap/cell/version --type String --value 99 --overwrite
expect_denied cell "UpdateAccount: point the API Gateway logs role at a /cell/ role" apigateway update-account --patch-operations "op=replace,path=/cloudwatchRoleArn,value=${target_arn}"
slr_out="$(as cell iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com 2>&1)"
slr_rc=$?
if [[ $slr_rc -eq 0 ]]; then
  echo "PASS  [cell] CreateServiceLinkedRole for API Gateway (control): allowed (created)"; passes=$((passes + 1))
elif grep -q 'has been taken' <<<"$slr_out"; then
  echo "PASS  [cell] CreateServiceLinkedRole for API Gateway (control): allowed (already present)"; passes=$((passes + 1))
else
  echo "FAIL  [cell] CreateServiceLinkedRole for API Gateway: $(head -c 240 <<<"$slr_out")"; fails=$((fails + 1))
fi
expect_allowed cell "UpdateRoleDescription on a /cell/ role (control)" iam update-role-description --role-name "$target" --description "changed by the cell policy probe"
expect_allowed cell "CreateRole on /cell/ with the workload boundary (control)" iam create-role --role-name "$created" --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload" --query Role.Arn --output text
expect_allowed cell "DeleteRole of that /cell/ role (control)" iam delete-role --role-name "$created"
expect_allowed cell "GetRole on the role pair (read stays open)" iam get-role --role-name "$pair" --query Role.Path --output text

# ---- cell/cell-policy-probe-workload, under the cell workload boundary ----
assume workload cell-policy-probe-workload
expect_denied workload "UpdateRoleDescription on a /cell/ role" iam update-role-description --role-name "$target" --description "changed by the workload probe"
expect_denied workload "PutRolePolicy on a /cell/ role" iam put-role-policy --role-name "$target" --policy-name cell-probe --policy-document "$admin"
expect_denied workload "CreateRole on /cell/ with the workload boundary" iam create-role --role-name cell-probe-workload-create --path /cell/ --assume-role-policy-document "$lambda_trust" --permissions-boundary "$workload"
expect_denied workload "PassRole of a /cell/ role to Lambda" lambda create-function --function-name cell-policy-probe-workload-pass --runtime python3.12 --handler fn.h --zip-file "$zip_file" --role "$target_arn"
expect_denied workload "CreateServiceLinkedRole for API Gateway" iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com
expect_denied workload "DeleteRolePermissionsBoundary on itself" iam delete-role-permissions-boundary --role-name cell-policy-probe-workload
expect_denied workload "AssumeRole of the cdk-cell deploy role" sts assume-role --role-arn "$(iam_arn "role/${deploy}")" --role-session-name cell-probe
expect_denied workload "AssumeRole of the role pair" sts assume-role --role-arn "$pair_arn" --role-session-name cell-probe
expect_denied workload "PutParameter over the identity pool id" ssm put-parameter --name /application-plane/shared/identity/userPoolId --type String --value cell-probe --overwrite
expect_denied workload "UpdateAccount: point the API Gateway logs role at a /cell/ role" apigateway update-account --patch-operations "op=replace,path=/cloudwatchRoleArn,value=${target_arn}"
expect_allowed workload "AssumeRole of a /cell/ tenant role, as the TVM does (control)" sts assume-role --role-arn "$tenant_arn" --role-session-name cell-probe --query AssumedRoleUser.Arn --output text

echo "probes passed: ${passes} failed: ${fails}"
exit "$fails"
