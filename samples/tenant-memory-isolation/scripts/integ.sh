#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (standard §5.2, ADR-0010).
#
#   AWS_REGION=us-east-1 TMI_INTEG_ACCOUNT=<account id> scripts/integ.sh   # or: npx projen integ
#
# Flow:
#   0. Guards: AWS_REGION is set (exactly one Region); the caller's account
#      equals TMI_INTEG_ACCOUNT, which the operator sets to confirm the
#      account may hold the run's synthetic resources; the demo stack is not
#      already deployed (this run tears down only what it deploys).
#   1. Synthesise src/main.ts into cdk.integ.out/ and deploy the demo stack
#      with the CDK CLI.
#   2. Run the steps (test/integ.memory-isolation.ts).
#   3. From the EXIT trap (also on failure): destroy the stack, then prove
#      that nothing it created is left: the stack, the Memory, Gateway, and
#      Policy engine, the user pool, the IAM roles, the log groups, the
#      published parameter, the Contributor Insights rules, and any resource
#      still carrying the stack's tag.
#
# Requires the account to be CDK-bootstrapped in AWS_REGION. Conventions:
# scripts/CONVENTIONS.md (no tracing, names and statuses only).

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the one Region to test in}"
export AWS_DEFAULT_REGION="$REGION"
for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAMPLE_DIR"
STACK="TenantMemoryIsolation"
OUT="cdk.integ.out"
PARAMETER="/application-plane/shared/memory/gateway"
TMP="$(mktemp -d)"
DEPLOYED=0
FAILED=0

step() { echo "== $1"; }
fail() { echo "integ: $1" >&2; exit 1; }

# Identifiers recorded after deploy, checked after destroy.
IDS="${TMP}/ids.json"
echo '{}' >"$IDS"

still_exists() { # arn -> 0 if the resource still exists (or its service is not known here)
  local arn="$1" id="${1##*/}"
  case "$arn" in
    arn:aws:cognito-idp:*:userpool/*) aws cognito-idp describe-user-pool --user-pool-id "$id" >/dev/null 2>&1 ;;
    arn:aws:lambda:*) aws lambda get-function --function-name "$arn" >/dev/null 2>&1 ;;
    arn:aws:iam::*:role/*) aws iam get-role --role-name "$id" >/dev/null 2>&1 ;;
    arn:aws:ssm:*:parameter/*) aws ssm get-parameter --name "/${arn#*:parameter/}" >/dev/null 2>&1 ;;
    arn:aws:logs:*) local group="${arn#*:log-group:}"; group="${group%:\*}"
      aws logs describe-log-groups --log-group-name-prefix "$group" --query 'length(logGroups)' --output text 2>/dev/null | grep -qv '^0$' ;;
    arn:aws:bedrock-agentcore:*:memory/*) aws bedrock-agentcore-control get-memory --memory-id "$id" >/dev/null 2>&1 ;;
    arn:aws:bedrock-agentcore:*:gateway/*) aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" >/dev/null 2>&1 ;;
    arn:aws:bedrock-agentcore:*:policy-engine/*) aws bedrock-agentcore-control get-policy-engine --policy-engine-id "$id" >/dev/null 2>&1 ;;
    *) return 0 ;;
  esac
}

prove_teardown() {
  local left=0 v
  check_gone() { # name, command...
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "  LEFT: ${name}" >&2; left=1; else echo "  gone: ${name}"; fi
  }
  check_gone "stack ${STACK}" aws cloudformation describe-stacks --stack-name "$STACK"
  v="$(jq -r '.memoryId // empty' "$IDS")"; [[ -z "$v" ]] || check_gone "Memory" aws bedrock-agentcore-control get-memory --memory-id "$v"
  v="$(jq -r '.gatewayId // empty' "$IDS")"; [[ -z "$v" ]] || check_gone "Gateway" aws bedrock-agentcore-control get-gateway --gateway-identifier "$v"
  v="$(jq -r '.policyEngineId // empty' "$IDS")"; [[ -z "$v" ]] || check_gone "Policy engine" aws bedrock-agentcore-control get-policy-engine --policy-engine-id "$v"
  v="$(jq -r '.userPoolId // empty' "$IDS")"; [[ -z "$v" ]] || check_gone "user pool" aws cognito-idp describe-user-pool --user-pool-id "$v"
  v="$(jq -r '.applicationLogGroup // empty' "$IDS")"
  if [[ -n "$v" ]] && [[ "$(aws logs describe-log-groups --log-group-name-prefix "$v" --query 'length(logGroups)' --output text)" != 0 ]]; then
    echo "  LEFT: Memory application log group" >&2; left=1
  else echo "  gone: Memory application log group"; fi
  if [[ "$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" --query 'length(logGroups)' --output text)" != 0 ]] \
    || [[ "$(aws logs describe-log-groups --log-group-name-prefix "${STACK}" --query 'length(logGroups)' --output text)" != 0 ]]; then
    echo "  LEFT: Lambda log groups" >&2; left=1
  else echo "  gone: Lambda log groups"; fi
  local roles
  roles="$(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text)"
  if [[ -n "$roles" && "$roles" != None ]]; then echo "  LEFT: IAM roles ${roles}" >&2; left=1; else echo "  gone: IAM roles"; fi
  check_gone "published parameter" aws ssm get-parameter --name "$PARAMETER"
  local rules
  rules="$(aws cloudwatch describe-insight-rules --query "InsightRules[?contains(Name, '-memory-')].Name" --output text)"
  if [[ -n "$rules" && "$rules" != None ]]; then echo "  LEFT: Contributor Insights rules ${rules}" >&2; left=1; else echo "  gone: Contributor Insights rules"; fi
  # The tagging index lags deletions, so each ARN it still lists is checked against its own
  # service; only one that still exists counts as left.
  local arn
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters "Key=aws:cloudformation:stack-name,Values=${STACK}" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text); do
    if still_exists "$arn"; then echo "  LEFT: tagged ${arn##*:}" >&2; left=1; else echo "  gone: tagged ${arn##*:} (stale tag index entry)"; fi
  done
  echo "  checked: resources tagged with the stack"
  aws logs describe-resource-policies --query 'resourcePolicies[].policyName' --output json >"${TMP}/policies-after.json"
  if ! diff -q "${TMP}/policies-before.json" "${TMP}/policies-after.json" >/dev/null; then
    echo "  LEFT: CloudWatch Logs resource policies changed: $(jq -c --slurpfile b "${TMP}/policies-before.json" '. - $b[0]' "${TMP}/policies-after.json")" >&2; left=1
  else echo "  unchanged: CloudWatch Logs resource policies"; fi
  return "$left"
}

cleanup() {
  local status=$?
  set +e
  if [[ "$DEPLOYED" == 1 ]]; then
    step "3: destroy and prove teardown"
    npx cdk destroy --app "$OUT" "$STACK" --force >"${TMP}/destroy.log" 2>&1 \
      || { echo "destroy failed; retrying once in 60 s" >&2; sleep 60; npx cdk destroy --app "$OUT" "$STACK" --force >>"${TMP}/destroy.log" 2>&1 \
        || { tail -20 "${TMP}/destroy.log" >&2; FAILED=1; }; }
    local tries=0
    until prove_teardown; do
      tries=$((tries + 1))
      if [[ "$tries" -ge 6 ]]; then FAILED=1; break; fi
      echo "  waiting 30 s for eventual consistency (attempt ${tries})"; sleep 30
    done
  fi
  rm -rf "$TMP"
  if [[ "$status" -ne 0 || "$FAILED" -ne 0 ]]; then echo "integ: FAILED" >&2; exit 1; fi
  echo "integ: PASSED"
}
trap cleanup EXIT

step "0: guards"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "${TMI_INTEG_ACCOUNT:-}" == "$ACCOUNT" ]] || fail "set TMI_INTEG_ACCOUNT to the caller's account id to confirm it may hold this run's synthetic resources"
aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1 || fail "the account is not CDK-bootstrapped in ${REGION}"
if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  fail "${STACK} is already deployed in ${REGION}; this run deploys and destroys its own"
fi
aws logs describe-resource-policies --query 'resourcePolicies[].policyName' --output json >"${TMP}/policies-before.json"
echo "  Region ${REGION}; account confirmed"

step "1: synthesise and deploy ${STACK}"
npx cdk synth -q --output "$OUT" >"${TMP}/synth.log" 2>&1 || { tail -30 "${TMP}/synth.log" >&2; fail "synth"; }
DEPLOYED=1
npx cdk deploy --app "$OUT" "$STACK" --require-approval never --tags "integ-run=$(date +%s)" >"${TMP}/deploy.log" 2>&1 \
  || { tail -40 "${TMP}/deploy.log" >&2; fail "deploy"; }
aws ssm get-parameter --name "$PARAMETER" --query Parameter.Value --output text \
  | jq '{memoryId, gatewayId: (.gatewayArn | split("/") | last), policyEngineId: (.policyEngineArn | split("/") | last), userPoolId: .demoIssuer.userPoolId, applicationLogGroup}' >"$IDS"
echo "  deployed"

step "2: steps (test/integ.memory-isolation.ts)"
npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.memory-isolation.ts || FAILED=1
