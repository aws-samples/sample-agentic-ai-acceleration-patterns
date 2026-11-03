#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test, v2 (spec §8, docs/sample-standard.md §5.2).
#
#   AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ      # or: scripts/integ.sh
#
# Flow (spec §8; every step lands in the table printed at the end):
#   1. tenant-identity: `shared-pool` (tenants A and B, users A1, A2, AA the
#      tenant admin, B1) is reused when published and has the scope catalogue,
#      else deployed and destroyed at the end; `shared-pool-multi-tenant`
#      (the user MU in two tenants) is reused when its stack exists, else
#      deployed beside it without the shared parameters and destroyed at the
#      end. The vendor scopes `app/use` and `entitlements/admin` are
#      registered when absent and removed at the end only if this run added
#      them. A published shared-pool without /platform/scopes is stale: the run
#      fails and says so unless INTEG_REPLACE_STALE_IDENTITY=1 (the
#      replacement deletes the shared user pool). INTEG_SKIP_MULTI_TENANT=1
#      skips the second deployment; step 19's MU half is then SKIP.
#   2. Synthesise test/integ.runtime.ts and deploy its stacks at once; create
#      the tenants and users; write plan `standard` and the subscriptions per
#      stack with the vendor operations (SigV4); AA writes A2's cut; seed the
#      demo items.
#   3..9, 9-registry, 11..20, 22..24 on both all-on stacks (api-gateway,
#      agentcore-gateway); 4a, the `scope: 'user'` half of 4b and the limits
#      step on their own stacks; 19 (MU) on the multi-tenant stack; 21 on the
#      api-gateway stack (a redeploy with keyGeneration 2); then the log
#      sweep and the metrics.
#  10. Destroy from the EXIT trap (also on failure) and verify nothing is
#      left: stacks, parameters, log groups, tables, Gateways and Policy
#      engines gone, KMS keys pending deletion, each policy deleted before
#      its target, the vendor scopes removed if this run added them.
#
# Steps that confirm a shape only a deployed Gateway can show (the status of
# an interceptor refusal, request headers at a RESPONSE interceptor) say so
# in their assertion message ("shape: ..."), so a failure points at the
# documented shape, not the design.
#
# Deploys into the account of the ambient AWS credentials, which must be
# CDK-bootstrapped in AWS_REGION. Conventions: scripts/CONVENTIONS.md (no
# token, credential or header value is ever printed).

# Token variables are passed to the helpers by NAME and read there as ${!name}.
# shellcheck disable=SC2034

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)}"
export AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq npx base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY_DIR="$(cd "${SAMPLE_DIR}/../tenant-identity" && pwd)"
cd "$SAMPLE_DIR"
LIB_TMP="$(mktemp -d)"
# shellcheck source=lib.sh
source "${SAMPLE_DIR}/scripts/lib.sh"

OUT="cdk.integ.out"
CDK=(npx cdk --app "$OUT")
INTEG_APP="npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.runtime.ts"
# INTEG_PREFIX deploys under another stack prefix, beside an earlier run's
# DELETE_FAILED stacks (CloudFormation refuses updates to them); the leftover
# check below is scoped to this prefix.
STACK_PREFIX="${INTEG_PREFIX:-RuntimeIsolationInteg}"
[[ "$STACK_PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "INTEG_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 1; }
IDENTITY_STACK="TenantIdentity-shared-pool"
MT_IDENTITY_STACK="TenantIdentity-shared-pool-multi-tenant"
ALL_ON=(api-gateway agentcore-gateway)
SUFFIXES=()
DEPLOYED_IDENTITY=0
DEPLOYED_MT_IDENTITY=0
DEPLOYED_SAMPLE=0
FAILED=0
RUN="$(date +%s)"
RUN_START_MS="$((RUN * 1000))"
STARTED="$(date -u +%FT%TZ)"
VENDOR_SCOPES=(app/use entitlements/admin)
ADDED_SCOPES=()
LATE_PARAMS=()
LATE_ROWS=()
FILTER_RESTORE=()
SP_API=""
MT_API=""
MT_POOL=""
MT_CLIENT=""
MT_ENABLED=0
OUTPUTS="${LIB_TMP}/outputs.json"
echo '{}' >"$OUTPUTS"

# --------------------------------------------------------------------------
# The step table. Assertions never exit: each records a failure for the
# current step, so the run goes on and the table shows every step. Only
# set-up that later steps cannot do without calls fail().
# --------------------------------------------------------------------------
TABLE="${LIB_TMP}/steps"
: >"$TABLE"
CUR=""
CUR_FAIL=""
CUR_EVIDENCE=""
STEP_OPEN=0

begin() { CUR="$1"; CUR_FAIL=""; CUR_EVIDENCE=""; STEP_OPEN=1; echo "== step $1: $2"; }
check() {
  local msg="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then
    CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }${msg}"
    echo "  FAIL: ${msg}" >&2
  fi
}
note() { CUR_EVIDENCE="${CUR_EVIDENCE:+${CUR_EVIDENCE}; }$*"; echo "  $*"; }
end_step() {
  local result=PASS
  STEP_OPEN=0
  if [[ -n "$CUR_FAIL" ]]; then result=FAIL; FAILED=1; fi
  printf '%s|%s|%s\n' "$CUR" "$result" "${CUR_FAIL:-$CUR_EVIDENCE}" | tr -d '\n' >>"$TABLE"
  echo >>"$TABLE"
}
skip_step() { printf '%s|SKIP|%s\n' "$1" "$2" >>"$TABLE"; echo "== step $1: SKIP ($2)"; }

eq() { [[ "$1" == "$2" ]]; }
ne() { [[ "$1" != "$2" ]]; }
status_is() { [[ "$2" =~ ^(${1})$ ]]; }
contains() { [[ "$1" == *"$2"* ]]; }
absent() { [[ "$1" != *"$2"* ]]; }
nonempty() { [[ -n "$1" ]]; }

# rf [JQ OPTIONS] FILTER -> a field of the agent's first data event, or empty (never fails the shell).
rf() { report_json 2>/dev/null | jq -r "$@" 2>/dev/null || true; }
body_text() { cat "$BODY" 2>/dev/null || true; }

print_table() {
  [[ -s "$TABLE" ]] || return 0
  echo "== results"
  awk -F'|' 'BEGIN { printf "%-28s | %-4s | %s\n", "step", "", "evidence"; print "-----------------------------|------|---------" }
    { printf "%-28s | %-4s | %s\n", $1, $2, $3 }' "$TABLE"
}

# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
output() { jq -r --arg s "${STACK_PREFIX}-$1" --arg k "$2" '.[$s][$k] // empty' "$OUTPUTS"; }
body() { jq -nc --arg c "$1" --arg p "$2" '{conversationId: $c, prompt: $p}'; }
step() { echo "== $1: $2"; }

# claim TOKEN_VAR NAME -> a non-secret claim of a JWT (decoded, not verified): `sub`, `tenant_id`.
claim() {
  local t="${!1}" p
  p="${t#*.}"; p="${p%%.*}"; p="$(printf '%s' "$p" | tr '_-' '/+')"
  while (( ${#p} % 4 )); do p+='='; done
  printf '%s' "$p" | base64 -d 2>/dev/null | jq -r --arg c "$2" '.[$c] // empty' 2>/dev/null || true
}

# issue TENANT USERNAME PREFIX -> issue_token, and remember every token for the log sweep.
issue() {
  issue_token "$1" "$2" "$3"
  remember_token "${3}_ACCESS"; remember_token "${3}_ID"; remember_token "${3}_REFRESH"
}

# fresh_tokens -> new identity tokens for every shared-pool user. A new token
# also misses the api-gateway authoriser cache (60 s, keyed on the token), so
# the next request mints from the current entitlements (spec §4.6).
fresh_tokens() {
  identity_use shared
  issue "$TENANT_A" "$A1_USER" A1
  issue "$TENANT_A" "$A2_USER" A2
  issue "$TENANT_A" "$AA_USER" AA
  issue "$TENANT_B" "$B1_USER" B1
}

# The shared pool's access tokens live 5 minutes (tenant-identity's app
# client), shorter than the stretch from fresh_tokens to step 24 (integ run 7:
# AA's PutUserCut was 401 invalid_token). Every tenant-admin call with AA's
# token re-issues it when it has under 90 s left.
aa_fresh() {
  local exp saved_api="$IDENTITY_API" saved_client="$APP_CLIENT_ID"
  exp="$(claim AA_ACCESS exp)"
  if [[ -z "$exp" ]] || (( exp - $(date +%s) < 90 )); then
    identity_use shared
    issue "$TENANT_A" "$AA_USER" AA
    IDENTITY_API="$saved_api"; APP_CLIENT_ID="$saved_client"
  fi
}
eval "lib_$(declare -f admin_api)"
admin_api() { # as lib.sh's, with AA's token kept fresh
  [[ "${3:-}" == AA_ACCESS ]] && aa_fresh
  lib_admin_api "$@"
}

identity_use() {
  if [[ "$1" == shared ]]; then IDENTITY_API="$SP_API"; APP_CLIENT_ID="$SP_CLIENT"; else IDENTITY_API="$MT_API"; APP_CLIENT_ID="$MT_CLIENT"; fi
}

# list-stack-resources, not describe-stack-resources: describe returns at most
# 100 resources, and the all-on stacks hold more (integ run 7: the interceptor
# log group was past the first 100, so step 15's log check read nothing).
stack_resources() { # STACK JMESPATH_FILTER FIELD -> one value per line
  aws cloudformation list-stack-resources --stack-name "$1" \
    --query "StackResourceSummaries[?$2].$3" --output text 2>/dev/null | tr '\t' '\n'
}
log_groups_of() { # STACK -> the stack's AWS::Logs::LogGroup physical ids
  stack_resources "$1" "ResourceType=='AWS::Logs::LogGroup'" PhysicalResourceId
}
resources_of() { # STACK TYPE -> physical ids
  stack_resources "$1" "ResourceType=='$2'" PhysicalResourceId
}
log_group_like() { # STACK LOGICAL_ID_PART -> the first log group whose logical id contains it
  stack_resources "$1" "ResourceType=='AWS::Logs::LogGroup' && contains(LogicalResourceId, '$2')" PhysicalResourceId | head -1
}
# runtimes_of STACK -> the Runtime ids of every *RuntimeArn output; their log groups live outside CloudFormation.
runtimes_of() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?ends_with(OutputKey, 'RuntimeArn')].OutputValue" --output text 2>/dev/null | tr '\t' '\n' | sed 's#.*/##'
}
RUNTIME_LOG_PREFIX="/aws/bedrock-agentcore/runtimes/"

# log_lines GROUP SINCE_MS PATTERN -> the messages of GROUP since SINCE_MS matching a CloudWatch filter pattern (one per line).
log_lines() {
  aws logs filter-log-events --log-group-name "$1" --start-time "$2" --filter-pattern "$3" \
    --query 'events[].message' --output json 2>/dev/null | jq -r '.[]' 2>/dev/null || true
}
# wait_log GROUP SINCE_MS PATTERN JQ_SELECT -> 0 when a JSON line matching JQ_SELECT appears within 90 s.
wait_log() {
  local deadline=$((SECONDS + 90))
  while [[ $SECONDS -lt $deadline ]]; do
    if log_lines "$1" "$2" "$3" | jq -e -s "map(select($4)) | length > 0" >/dev/null 2>&1; then return 0; fi
    sleep 10
  done
  return 1
}

# --------------------------------------------------------------------------
# 10. Teardown (EXIT trap) and its verification
# --------------------------------------------------------------------------
cleanup() {
  local status=$?
  set +e
  if [[ "$STEP_OPEN" == 1 ]]; then
    CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }the run stopped in this step (exit ${status})"
    end_step
  fi
  begin 10 "destroy and verify nothing is left (ADR-0019, ADR-0040)"
  delete_tenants
  local lp lr r
  for lp in "${LATE_PARAMS[@]:-}"; do [[ -n "$lp" ]] && aws ssm delete-parameter --name "$lp" >/dev/null 2>&1; done
  for lr in "${LATE_ROWS[@]:-}"; do
    [[ -n "$lr" ]] && aws dynamodb delete-item --table-name "${lr%%|*}" --key "{\"PK\":{\"S\":\"${lr#*|}\"},\"SK\":{\"S\":\"#NAME\"}}" >/dev/null 2>&1
  done
  for r in "${FILTER_RESTORE[@]:-}"; do
    [[ -n "$r" ]] && aws lambda update-function-configuration --function-name "${r%%|*}" --environment "${r#*|}" >/dev/null 2>&1
  done
  local groups="${LIB_TMP}/log-groups" runtimes="${LIB_TMP}/runtimes" params="${LIB_TMP}/params" tables="${LIB_TMP}/tables"
  local gateways="${LIB_TMP}/gateways" engines="${LIB_TMP}/engines" keys="${LIB_TMP}/keys" ids="${LIB_TMP}/stack-ids" s
  : >"$groups"; : >"$runtimes"; : >"$params"; : >"$tables"; : >"$gateways"; : >"$engines"; : >"$keys"; : >"$ids"
  if [[ "$DEPLOYED_SAMPLE" == 1 ]]; then
    for s in "${SUFFIXES[@]}"; do
      log_groups_of "${STACK_PREFIX}-${s}" >>"$groups"
      resources_of "${STACK_PREFIX}-${s}" AWS::SSM::Parameter >>"$params"
      resources_of "${STACK_PREFIX}-${s}" AWS::DynamoDB::GlobalTable >>"$tables"
      resources_of "${STACK_PREFIX}-${s}" AWS::BedrockAgentCore::Gateway >>"$gateways"
      resources_of "${STACK_PREFIX}-${s}" AWS::BedrockAgentCore::PolicyEngine >>"$engines"
      resources_of "${STACK_PREFIX}-${s}" AWS::KMS::Key >>"$keys"
      runtimes_of "${STACK_PREFIX}-${s}" >>"$runtimes"
      aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-${s}" --query 'Stacks[0].StackId' --output text 2>/dev/null >>"$ids"
    done
    "${CDK[@]}" destroy --all --force --concurrency 6 >"${LIB_TMP}/destroy.log" 2>&1 \
      || { tail -20 "${LIB_TMP}/destroy.log" >&2; CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }cdk destroy failed"; }
    while read -r rt; do
      [[ -n "$rt" && "$rt" != None ]] || continue
      for g in $(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text); do
        aws logs delete-log-group --log-group-name "$g" >/dev/null 2>&1
      done
    done <"$runtimes"
  fi
  if [[ "$DEPLOYED_MT_IDENTITY" == 1 ]]; then
    (cd "$IDENTITY_DIR" && npx cdk destroy "$MT_IDENTITY_STACK" --context topology=shared-pool-multi-tenant --context publishSharedParameters=false --force >"${LIB_TMP}/mt-destroy.log" 2>&1) \
      || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }destroy ${MT_IDENTITY_STACK} failed"
  fi
  if [[ -n "$SP_API" ]]; then
    IDENTITY_API="$SP_API"
    local sc st
    for sc in "${ADDED_SCOPES[@]:-}"; do
      [[ -n "$sc" ]] || continue
      platform DELETE "platform/scopes/$(jq -rn --arg s "$sc" '$s | @uri')" >/dev/null 2>&1
      st="$(platform GET "platform/scopes/$(jq -rn --arg s "$sc" '$s | @uri')")"
      [[ "$st" == 404 ]] || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }scope ${sc} still in tenant-identity's catalogue (HTTP ${st})"
    done
  fi
  if [[ "$DEPLOYED_IDENTITY" == 1 ]]; then
    (cd "$IDENTITY_DIR" && npx cdk destroy "$IDENTITY_STACK" --context topology=shared-pool --force >"${LIB_TMP}/identity-destroy.log" 2>&1) \
      || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }destroy ${IDENTITY_STACK} failed"
  fi
  local left
  left="$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}-')].StackName" --output text)"
  [[ -z "$left" ]] || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover stacks: $left"
  if [[ "$DEPLOYED_SAMPLE" == 1 ]]; then
    local n=0
    while read -r p; do
      [[ -n "$p" && "$p" != None ]] || continue
      aws ssm get-parameter --name "$p" >/dev/null 2>&1 && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover parameter $p"
    done <"$params"
    while read -r g; do
      [[ -n "$g" && "$g" != None ]] || continue
      aws logs describe-log-groups --log-group-name-prefix "$g" --query "logGroups[?logGroupName=='$g'].logGroupName" --output text | grep -q . \
        && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover log group $g"
    done <"$groups"
    while read -r rt; do
      [[ -n "$rt" && "$rt" != None ]] || continue
      left="$(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text)"
      [[ -z "$left" || "$left" == None ]] || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover runtime log groups ${left}"
    done <"$runtimes"
    while read -r t; do
      [[ -n "$t" && "$t" != None ]] || continue
      aws dynamodb describe-table --table-name "$t" >/dev/null 2>&1 && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover table $t"
    done <"$tables"
    while read -r gw; do
      [[ -n "$gw" && "$gw" != None ]] || continue
      aws bedrock-agentcore-control get-gateway --gateway-identifier "${gw##*/}" >/dev/null 2>&1 && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover Gateway ${gw##*/}"
    done <"$gateways"
    while read -r pe; do
      [[ -n "$pe" && "$pe" != None ]] || continue
      aws bedrock-agentcore-control get-policy-engine --policy-engine-id "${pe##*/}" >/dev/null 2>&1 && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }leftover Policy engine ${pe##*/}"
    done <"$engines"
    while read -r k; do
      [[ -n "$k" && "$k" != None ]] || continue
      local state
      state="$(aws kms describe-key --key-id "$k" --query KeyMetadata.KeyState --output text 2>/dev/null || echo Gone)"
      [[ "$state" == PendingDeletion || "$state" == Gone ]] || CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }KMS key ${k} is ${state}, not PendingDeletion"
      n=$((n + 1))
    done <"$keys"
    # ADR-0040: each target's policy was deleted before the target (stack events of the deleted stacks).
    while read -r sid; do
      [[ -n "$sid" && "$sid" != None ]] || continue
      aws cloudformation describe-stack-events --stack-name "$sid" --output json 2>/dev/null \
        | jq -r '.StackEvents[] | select(.ResourceStatus == "DELETE_COMPLETE") | [.ResourceType, .LogicalResourceId, .Timestamp] | @tsv' >"${LIB_TMP}/events" || true
      for prefix in CrmTools InvoicesTools; do
        local pol tgt
        pol="$(awk -F'\t' -v p="$prefix" '$1 == "Custom::RuntimeIsolationToolPolicy" && index($2, p) == 1 { print $3 }' "${LIB_TMP}/events" | sort | tail -1)"
        tgt="$(awk -F'\t' -v p="$prefix" '$1 == "AWS::BedrockAgentCore::GatewayTarget" && index($2, p) == 1 { print $3 }' "${LIB_TMP}/events" | sort | head -1)"
        if [[ -n "$pol" && -n "$tgt" && ! "$pol" < "$tgt" ]]; then
          CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }${prefix} policy deleted at ${pol}, not before its target (${tgt})"
        fi
      done
    done <"$ids"
    note "no stacks, parameters, log groups, tables, Gateways or Policy engines left; ${n} KMS keys pending deletion; policies deleted before targets"
  fi
  [[ "$status" -ne 0 ]] && CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }the run stopped early (exit ${status})"
  end_step
  print_table
  rm -rf "$LIB_TMP"
  if [[ "$status" -ne 0 ]] || [[ "$FAILED" -ne 0 ]]; then
    echo "integ: FAILED" >&2
    exit 1
  fi
  echo "integ: PASSED"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# tenant-identity: the two deployments
# --------------------------------------------------------------------------
IDENTITY_PREPARED=0
identity_needs_install() {
  [[ ! -d "${IDENTITY_DIR}/node_modules" ]] || [[ "${IDENTITY_DIR}/package-lock.json" -nt "${IDENTITY_DIR}/node_modules" ]]
}
identity_prepare() {
  [[ "$IDENTITY_PREPARED" == 1 ]] && return 0
  if identity_needs_install; then
    (cd "$IDENTITY_DIR" && npm ci --no-audit --no-fund >"${LIB_TMP}/identity-install.log" 2>&1) \
      || { tail -30 "${LIB_TMP}/identity-install.log" >&2; fail "npm ci in ${IDENTITY_DIR}"; }
  fi
  (cd "$IDENTITY_DIR" && npx projen build >"${LIB_TMP}/identity-build.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-build.log" >&2; fail "projen build in ${IDENTITY_DIR}"; }
  IDENTITY_PREPARED=1
}
deploy_identity() { # TOPOLOGY STACK [EXTRA CONTEXT...]
  local topology="$1" stack="$2"
  shift 2
  echo "  deploying ${stack} through its own path (npm ci if needed, projen build, cdk deploy)"
  identity_prepare
  (cd "$IDENTITY_DIR" && npx cdk deploy "$stack" --context "topology=${topology}" "$@" --require-approval never >"${LIB_TMP}/identity-deploy-${topology}.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-deploy-${topology}.log" >&2; fail "deploy ${stack}"; }
}
stack_output() { # STACK KEY
  aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null
}

begin 1 "tenant-identity shared-pool (and shared-pool-multi-tenant for MU)"
if aws ssm get-parameter --name "${IDENTITY_PREFIX}/apiUrl" --query Parameter.Name --output text >/dev/null 2>&1; then
  identity_init
  # What v2 needs from a reused deployment: shared-pool (identity_init checks it) and the
  # scope catalogue, so the tenant admin's token can carry entitlements/admin (spec §6.4).
  status="$(scope_catalogue_status)"
  if [[ "$status" == 200 ]]; then
    note "reusing the published shared-pool tenant-identity (GET /platform/scopes 200)"
  elif stale_identity "$status"; then
    if [[ "${INTEG_REPLACE_STALE_IDENTITY:-0}" != 1 ]]; then
      cat >&2 <<STALE
the published tenant-identity (${IDENTITY_STACK}) is stale for v2: GET /platform/scopes -> HTTP ${status} (no such route).
v2 registers the vendor scopes app/use and entitlements/admin there (spec §6.4), so the tenant admin's identity
token can carry entitlements/admin. To replace it with the current ${IDENTITY_DIR}, rerun with

  INTEG_REPLACE_STALE_IDENTITY=1 AWS_REGION=${REGION} scripts/integ.sh

Replacing it destroys and redeploys the stack, which DELETES the shared Cognito user pool: every tenant and user
other consumers of this deployment created is gone. Do this only in an account this run owns.
STALE
      fail "stale tenant-identity (set INTEG_REPLACE_STALE_IDENTITY=1 to replace it)"
    fi
    note "stale shared-pool replaced (INTEG_REPLACE_STALE_IDENTITY=1)"
    identity_prepare
    (cd "$IDENTITY_DIR" && npx cdk destroy "$IDENTITY_STACK" --context topology=shared-pool --force >"${LIB_TMP}/identity-stale-destroy.log" 2>&1) \
      || { tail -30 "${LIB_TMP}/identity-stale-destroy.log" >&2; fail "destroy the stale ${IDENTITY_STACK}"; }
    deploy_identity shared-pool "$IDENTITY_STACK"
    identity_init
  else
    fail "GET /platform/scopes on the published tenant-identity: HTTP ${status}"
  fi
else
  DEPLOYED_IDENTITY=1
  deploy_identity shared-pool "$IDENTITY_STACK"
  identity_init
  note "deployed ${IDENTITY_STACK}"
fi
SP_API="$IDENTITY_API"
SP_CLIENT="$APP_CLIENT_ID"
for sc in "${VENDOR_SCOPES[@]}"; do
  st="$(platform GET "platform/scopes/$(jq -rn --arg s "$sc" '$s | @uri')")"
  if [[ "$st" == 404 ]]; then
    st="$(platform PUT "platform/scopes/$(jq -rn --arg s "$sc" '$s | @uri')" "$(jq -nc --arg d "runtime-isolation integ ${RUN}" '{description: $d}')")"
    [[ "$st" == 200 ]] || fail "PutScope ${sc}: HTTP ${st}"
    ADDED_SCOPES+=("$sc")
  fi
done
note "vendor scopes registered: ${VENDOR_SCOPES[*]} (added by this run: ${ADDED_SCOPES[*]:-none})"

if [[ "${INTEG_SKIP_MULTI_TENANT:-0}" == 1 ]]; then
  note "shared-pool-multi-tenant skipped (INTEG_SKIP_MULTI_TENANT=1)"
else
  if [[ "$(stack_output "$MT_IDENTITY_STACK" ApiUrl)" == https://* ]]; then
    note "reusing ${MT_IDENTITY_STACK}"
  else
    DEPLOYED_MT_IDENTITY=1
    # Beside the shared-pool deployment, which owns the shared parameters (tenant-identity ADR-0017).
    deploy_identity shared-pool-multi-tenant "$MT_IDENTITY_STACK" --context publishSharedParameters=false
    note "deployed ${MT_IDENTITY_STACK}"
  fi
  MT_API="$(stack_output "$MT_IDENTITY_STACK" ApiUrl)"; [[ "$MT_API" == */ ]] || MT_API="${MT_API}/"
  MT_POOL="$(stack_output "$MT_IDENTITY_STACK" UserPoolId)"
  MT_CLIENT="$(stack_output "$MT_IDENTITY_STACK" AppClientId)"
  [[ -n "$MT_POOL" && "$MT_POOL" != None && -n "$MT_CLIENT" && "$MT_CLIENT" != None ]] || fail "${MT_IDENTITY_STACK} has no UserPoolId/AppClientId outputs"
  MT_ENABLED=1
fi
end_step

# --------------------------------------------------------------------------
# 2. Deploy the stacks, then the fixtures
# --------------------------------------------------------------------------
begin 2 "synth and deploy ${STACK_PREFIX}-*; tenants, users, plan, subscriptions, cuts"
# The api-gateway stack writes the fixed-name published parameters (spec §6.4).
# When any of them already exists (another deployment of the sample, or an
# earlier run's DELETE_FAILED stack) CloudFormation cannot create it, so the
# run deploys with no publisher (INTEG_PUBLISHER=none) and says so; no step
# reads the fixed names.
INTEG_PUBLISHER="${INTEG_PUBLISHER:-api-gateway}"
synth() { # [KEY_GENERATION]
  rm -rf "$OUT"
  INTEG_PUBLISHER="$INTEG_PUBLISHER" INTEG_PREFIX="$STACK_PREFIX" INTEG_MT_USER_POOL_ID="$MT_POOL" INTEG_MT_APP_CLIENT_ID="$MT_CLIENT" INTEG_KEY_GENERATION="${1:-1}" \
    npx cdk synth -q --app "$INTEG_APP" --output "$OUT" >"${LIB_TMP}/synth.log" 2>&1 \
    || { tail -30 "${LIB_TMP}/synth.log" >&2; fail "synth"; }
}
synth
if [[ "$INTEG_PUBLISHER" != none ]]; then
  TAKEN=()
  while read -r n; do
    [[ -n "$n" ]] || continue
    aws ssm get-parameter --name "$n" --query Parameter.Name --output text >/dev/null 2>&1 && TAKEN+=("$n")
  done < <(jq -r '.Resources[] | select(.Type == "AWS::SSM::Parameter") | .Properties.Name | strings' "${OUT}/${STACK_PREFIX}-${INTEG_PUBLISHER}.template.json")
  if (( ${#TAKEN[@]} > 0 )); then
    note "fixed-name parameters already taken (${TAKEN[*]}): deployed with no publisher (INTEG_PUBLISHER=none)"
    INTEG_PUBLISHER=none
    synth
  fi
fi
mapfile -t SUFFIXES < <(find "$OUT" -maxdepth 1 -name "${STACK_PREFIX}-*.template.json" -printf '%f\n' | sed "s/^${STACK_PREFIX}-//; s/\.template\.json$//" | sort)
DEPLOYED_SAMPLE=1
DEPLOY_START=$SECONDS
"${CDK[@]}" deploy --all --require-approval never --concurrency 6 --outputs-file "$OUTPUTS" >"${LIB_TMP}/deploy.log" 2>&1 \
  || { grep -E "FAILED|Error|error" "${LIB_TMP}/deploy.log" | tail -30 >&2; tail -15 "${LIB_TMP}/deploy.log" >&2; fail "deploy"; }
note "deployed ${#SUFFIXES[@]} stacks (${SUFFIXES[*]}) in $((SECONDS - DEPLOY_START))s"

# Tenants and users (shared-pool): A holds app/use and entitlements/admin (its
# admin AA is the tenant admin); A1 and A2 are cut to app/use in tenant-identity,
# so only AA carries entitlements/admin. B holds app/use; B1 is its admin user.
identity_use shared
create_tenant "rtiso-integ-a-${RUN}" "app/use entitlements/admin"; TENANT_A="$TENANT_ID"; AA_USER="$ADMIN_USERNAME"
create_user "$TENANT_A" "rtiso-integ-a1-${RUN}"; A1_USER="$USERNAME"
create_user "$TENANT_A" "rtiso-integ-a2-${RUN}"; A2_USER="$USERNAME"
create_tenant "rtiso-integ-b-${RUN}" "app/use"; TENANT_B="$TENANT_ID"; B1_USER="$ADMIN_USERNAME"
issue "$TENANT_A" "$AA_USER" AA
for who in A1 A2; do
  user_var="${who}_USER"
  set_user_scopes AA_REFRESH "$TENANT_A" "${!user_var}" "app/use"
  [[ "$SET_SCOPES_STATUS" == 200 ]] || fail "AA cuts ${who} to app/use in tenant-identity: HTTP ${SET_SCOPES_STATUS}"
done
fresh_tokens
A1_SUB="$(claim A1_ACCESS sub)"; A2_SUB="$(claim A2_ACCESS sub)"
contains "$(claim AA_ACCESS scope)" entitlements/admin || fail "AA's identity token carries no entitlements/admin"
note "tenant A (A1, A2, AA admin) and B (B1) in shared-pool"

# Multi-tenant fixtures: tenants A', M and B' in shared-pool-multi-tenant;
# MU is a member of A' and M (tenants: [A', M]).
if [[ "$MT_ENABLED" == 1 ]]; then
  identity_use mt
  create_tenant "rtiso-integ-mta-${RUN}" ""; MT_A="$TENANT_ID"
  create_tenant "rtiso-integ-mtm-${RUN}" ""; MT_M="$TENANT_ID"
  create_tenant "rtiso-integ-mtb-${RUN}" ""; MT_B="$TENANT_ID"
  create_user "$MT_A" "rtiso-integ-mu-${RUN}"; MU_USER="$USERNAME"
  st="$(platform PUT "platform/tenants/${MT_M}/users/${MU_USER}/membership")"
  [[ "$st" == 204 ]] || fail "CreateMembership MU -> M: HTTP ${st}"
  note "tenants A', M, B' and MU (tenants A', M) in shared-pool-multi-tenant"
  identity_use shared
fi

# Per-stack entitlements (spec §8 fixtures): each stack has its own store.
put_ok() { # WHAT STATUS
  [[ "$2" =~ ^20[04]$ ]] || { echo "  $1: HTTP $2 $(body_text | head -c 200)" >&2; fail "$1"; }
}
stack_fixtures() { # SUFFIX
  local s="$1"
  ENT_API="$(output "$s" EntitlementsApiUrl)"
  [[ -n "$ENT_API" ]] || fail "stack ${s} has no EntitlementsApiUrl output"
  case "$s" in
    api-gateway | agentcore-gateway)
      put_ok "${s} PutPlan standard" "$(vendor PUT plans/standard '{"agents":["default","billing"],"tools":["crm/*","invoices/*"]}')"
      put_ok "${s} PutTenantSubscription A" "$(vendor PUT "tenants/${TENANT_A}" '{"agents":[],"tools":[],"plan":"standard"}')"
      put_ok "${s} PutTenantSubscription B" "$(vendor PUT "tenants/${TENANT_B}" '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}')"
      put_ok "${s} AA cuts A2 from crm/update_case" "$(admin_api PUT "users/${A2_SUB}/cut" AA_ACCESS '{"cutAgents":[],"cutTools":["crm/update_case"]}')"
      ;;
    multi-tenant)
      put_ok "${s} subscription A'" "$(vendor PUT "tenants/${MT_A}" '{"agents":["default"],"tools":["crm/*"]}')"
      put_ok "${s} subscription M" "$(vendor PUT "tenants/${MT_M}" '{"agents":["default"],"tools":["crm/get_account"]}')"
      put_ok "${s} subscription B'" "$(vendor PUT "tenants/${MT_B}" '{"agents":["default"],"tools":["crm/*"]}')"
      ;;
    *)
      put_ok "${s} subscription A" "$(vendor PUT "tenants/${TENANT_A}" '{"agents":["default"],"tools":["crm/*"]}')"
      put_ok "${s} subscription B" "$(vendor PUT "tenants/${TENANT_B}" '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}')"
      ;;
  esac
}
for s in "${SUFFIXES[@]}"; do stack_fixtures "$s"; done
note "plan standard, subscriptions A (plan), B (direct), M; A2 cut from crm/update_case"

# The demo items (tools and the agent's `read` read them): one per tenant.
seed_item() { # TABLE TENANT LABEL
  aws dynamodb put-item --table-name "$1" --item "$(jq -nc --arg t "TENANT#$2" --arg l "$3" '{
    PK: {S: $t}, note: {S: "integ item"},
    crmAccount: {M: {accountId: {S: ("acc-" + $l)}, name: {S: ("Account " + $l)}}},
    crmCases: {M: {"case-1": {M: {status: {S: "open"}}}}},
    invoices: {M: {"inv-1": {M: {amount: {S: "10.00"}, currency: {S: "EUR"}}}, "inv-2": {M: {amount: {S: "20.00"}, currency: {S: "EUR"}}}}}
  }')" >/dev/null
}
for s in "${ALL_ON[@]}"; do
  seed_item "$(output "$s" DemoTableName)" "$TENANT_A" a
  seed_item "$(output "$s" DemoTableName)" "$TENANT_B" b
done
if [[ "$MT_ENABLED" == 1 && -n "$(output multi-tenant DemoTableName)" ]]; then
  seed_item "$(output multi-tenant DemoTableName)" "$MT_A" mta
  seed_item "$(output multi-tenant DemoTableName)" "$MT_M" mtm
fi
end_step

# --------------------------------------------------------------------------
# Steps on one all-on stack
# --------------------------------------------------------------------------
stack_vars() { # SUFFIX
  local s="$1"
  ENDPOINT="$(output "$s" EndpointUrl)"
  BILLING_URL="$(output "$s" BillingEndpointUrl)"
  RUNTIME_ARN="$(output "$s" RuntimeArn)"
  TENANT_ROLE="$(output "$s" TenantRoleArn)"
  INGRESS_ROLE="$(output "$s" IngressRoleArn)"
  ISSUER="$(output "$s" Issuer)"
  ENT_API="$(output "$s" EntitlementsApiUrl)"
  TOOLS_DEFAULT="$(output "$s" ToolsGatewayUrlDefault)"
  TOOLS_FINANCE="$(output "$s" ToolsGatewayUrlFinance)"
  ENGINE_DEFAULT="$(output "$s" PolicyEngineIdDefault)"
  ENGINE_FINANCE="$(output "$s" PolicyEngineIdFinance)"
  MINT_FN="$(output "$s" MintFunctionName)"
  CRM_FN="$(output "$s" CrmFunctionName)"
  FILTER_FN="$(output "$s" ResponseFilterFunctionName)"
  CRM_TOOL_ROLE="$(output "$s" CrmToolTenantRoleArn)"
  REGISTRY_PREFIX="$(output "$s" RegistryPrefix)"
  [[ "$REGISTRY_PREFIX" == */ ]] || REGISTRY_PREFIX="${REGISTRY_PREFIX}/"
  INTERCEPTOR_LOGS="$(log_group_like "${STACK_PREFIX}-${s}" ToolsGatewayInterceptorLogs)"
  CRM_LOGS="$(log_group_like "${STACK_PREFIX}-${s}" CrmToolsLogs)"
}

# mint_for TENANT SUB AGENT SCOPE GATEWAYS_JSON [EXTRA_JSON] -> a test-mint event.
mint_event() {
  local extra="${6:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -nc --arg t "$1" --arg s "$2" --arg a "$3" --arg sc "$4" --argjson g "$5" --argjson x "$extra" \
    '{tenantId: $t, sub: $s, agent: $a, scope: $sc, gateways: $g} + $x'
}
DEFAULT_SCOPE_A='crm/* default/chat'

run_all_on() { # SUFFIX
  local INGRESS="$1"
  stack_vars "$INGRESS"
  fresh_tokens
  local C1="integConversation${RUN}"
  echo "---- ingress: $INGRESS"

  begin "3 ${INGRESS}" "direct InvokeAgentRuntime with the runner's own credentials is denied (P-1)"
  if aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn "$RUNTIME_ARN" \
      --runtime-session-id "integ-direct-call-$(printf '%032d' "$RUN")" --payload '{"prompt":"report"}' \
      --cli-binary-format raw-in-base64-out "${LIB_TMP}/direct.out" >/dev/null 2>"${LIB_TMP}/direct.err"; then
    check "the runner invoked the Runtime directly" false
  else
    check "direct invoke failed, but not with AccessDenied" grep -q AccessDenied "${LIB_TMP}/direct.err"
    note "direct invoke -> AccessDeniedException"
  fi
  end_step

  begin "4b ${INGRESS}" "session tenant scope: B1 with A1's c1 and unit id lands in B's unit; A2 sending c1 shares A1's (P-2, ADR-0039)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"; check "A1 report HTTP 200 (got ${status})" eq "$status" 200
  A1_UNIT="$(rf .unitId)"; A1_NONCE="$(rf .nonce)"; A1_PREFIX="$(rf .sessionPrefix)"
  check "A1's unit id is s-<prefix>-<conversationId>" eq "$A1_UNIT" "s-${A1_PREFIX}-${C1}"
  check "no vended credentials reached the agent (ADR-0018)" eq "$(rf .credentials)" true
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" report)" "$A1_UNIT")"; check "B1 report HTTP 200 (got ${status})" eq "$status" 200
  check "B1 landed in A1's unit" ne "$(rf .unitId)" "$A1_UNIT"
  check "B1 reached A1's microVM" ne "$(rf .nonce)" "$A1_NONCE"
  status="$(invoke "$ENDPOINT" A2_ACCESS "$(body "$C1" report)")"; check "A2 report HTTP 200 (got ${status})" eq "$status" 200
  check "A2 does not share tenant A's conversation c1 (scope tenant)" eq "$(rf .unitId)" "$A1_UNIT"
  note "B1 own unit and microVM; A2 shares A1's unit"
  end_step

  begin "5 ${INGRESS}" "A1 resumes c1: same microVM"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"
  check "A1 resumed c1 on a different microVM" eq "$(rf .nonce)" "$A1_NONCE"
  note "same nonce"
  end_step

  begin "6 ${INGRESS}" "no token, tampered token, ID token, malformed conversationId: refused (§5.1)"
  status="$(invoke "$ENDPOINT" "" "$(body "$C1" report)")"; check "no token: 401|403 (got ${status})" status_is "401|403" "$status"
  TAMPERED="$(tamper A1_ACCESS)"
  status="$(invoke "$ENDPOINT" TAMPERED "$(body "$C1" report)")"; check "tampered: 401|403 (got ${status})" status_is "401|403" "$status"
  status="$(invoke "$ENDPOINT" A1_ID "$(body "$C1" report)")"; check "ID token: 401|403 (got ${status})" status_is "401|403" "$status"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "bad!" report)")"; check "malformed conversationId: 400|403 (got ${status})" status_is "400|403" "$status"
  note "all refused"
  end_step

  begin "7 ${INGRESS}" "grants: scope, tenant_id, agent, aud and act.sub per caller (spec §8 expected grants)"
  expect_grant() { # WHO URL SCOPE AGENT AUD_JSON TENANT
    local who="$1" url="$2" want="$3" agent="$4" aud="$5" tenant="$6"
    status="$(invoke "$url" "${who}_ACCESS" "$(body "$C1" report)")"
    check "${who} on ${agent}: HTTP 200 (got ${status})" eq "$status" 200
    check "${who} on ${agent}: scope '${want}' (got '$(rf .tokenScope)')" eq "$(rf .tokenScope)" "$want"
    check "${who} on ${agent}: tenant_id" eq "$(rf .tokenTenant)" "$tenant"
    check "${who} on ${agent}: agent claim" eq "$(rf .tokenAgent)" "$agent"
    check "${who} on ${agent}: aud $(jq -c . <<<"$aud") (got $(rf -c .tokenAud))" eq "$(rf -c .tokenAud)" "$(jq -c . <<<"$aud")"
    check "${who} on ${agent}: act.sub is the ingress role" eq "$(rf .tokenActSub)" "$INGRESS_ROLE"
  }
  expect_grant A1 "$ENDPOINT" "$DEFAULT_SCOPE_A" default '["agent:default","tools-gateway:default"]' "$TENANT_A"
  expect_grant A2 "$ENDPOINT" "crm/get_account crm/list_cases default/chat" default '["agent:default","tools-gateway:default"]' "$TENANT_A"
  expect_grant A1 "$BILLING_URL" "billing/invoke billing/read invoices/*" billing '["agent:billing","tools-gateway:finance"]' "$TENANT_A"
  expect_grant B1 "$ENDPOINT" "crm/get_account crm/list_cases default/chat" default '["agent:default","tools-gateway:default"]' "$TENANT_B"
  status="$(invoke "$BILLING_URL" B1_ACCESS "$(body "$C1" report)")"
  check "B1 on billing: 403 (got ${status})" eq "$status" 403
  check "B1 on billing: forbidden: agent_not_subscribed (got '$(body_text | head -c 80)')" contains "$(body_text)" agent_not_subscribed
  note "five rows of the expected grants table match"
  end_step

  begin "8a ${INGRESS}" "TVM: own tenant item read, other tenant's denied in IAM; the runner cannot assume the tenant role"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" "read ${TENANT_A}")")"
  check "A1 reads tenant A (got $(rf .read.result) $(rf .read.error))" eq "$(rf .read.result)" ok
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" "read ${TENANT_B}")")"
  check "A1 read tenant B: $(rf .read.error)" eq "$(rf .read.error)" AccessDeniedException
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" "read ${TENANT_A}")")"
  check "B1 read tenant A: $(rf .read.error)" eq "$(rf .read.error)" AccessDeniedException
  if aws sts assume-role --role-arn "$TENANT_ROLE" --role-session-name integ-negative >/dev/null 2>&1; then check "the runner assumed the tenant role" false; fi
  note "A->A ok, A->B and B->A AccessDeniedException, runner AssumeRole denied"
  end_step

  begin "8b ${INGRESS}" "a model prompt ends with event: usage (P-10, ADR-0018)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" 'In one sentence, what is tenant isolation?')")"
  check "model prompt: event: error $(error_event)" eq "$(error_event)" ""
  u="$(usage_json)"
  check "usage event with token counts (got '${u}')" jq -e '.inputTokens > 0 and .outputTokens > 0' <<<"$u"
  note "usage: ${u}"
  end_step

  begin "9 ${INGRESS}" "latency: 20 report calls with a cold mint cache, 20 warm; TTFB and total p50/p95 (V-12)"
  : >"${LIB_TMP}/cold-ttfb"; : >"${LIB_TMP}/cold-total"; : >"${LIB_TMP}/warm-ttfb"; : >"${LIB_TMP}/warm-total"
  for i in $(seq 1 20); do
    # A version bump changes the mint cache key; a fresh identity token misses the authoriser cache.
    vendor PUT "tenants/${TENANT_B}" '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}' >/dev/null
    issue "$TENANT_B" "$B1_USER" B1
    status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" report)")"
    [[ "$status" == 200 ]] || { check "cold call $i: HTTP ${status}" false; break; }
    timing; echo "$LAST_TTFB" >>"${LIB_TMP}/cold-ttfb"; echo "$LAST_TOTAL" >>"${LIB_TMP}/cold-total"
  done
  invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" report)" >/dev/null
  for i in $(seq 1 20); do
    status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" report)")"
    [[ "$status" == 200 ]] || { check "warm call $i: HTTP ${status}" false; break; }
    timing; echo "$LAST_TTFB" >>"${LIB_TMP}/warm-ttfb"; echo "$LAST_TOTAL" >>"${LIB_TMP}/warm-total"
  done
  note "cold TTFB p50=$(percentile 50 "${LIB_TMP}/cold-ttfb")s p95=$(percentile 95 "${LIB_TMP}/cold-ttfb")s total p50=$(percentile 50 "${LIB_TMP}/cold-total")s p95=$(percentile 95 "${LIB_TMP}/cold-total")s"
  note "warm TTFB p50=$(percentile 50 "${LIB_TMP}/warm-ttfb")s p95=$(percentile 95 "${LIB_TMP}/warm-ttfb")s total p50=$(percentile 50 "${LIB_TMP}/warm-total")s p95=$(percentile 95 "${LIB_TMP}/warm-total")s"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" 'stream 10')")"; timing
  check "stream 10: $(data_events) data events" test "$(data_events)" -ge 6
  note "stream 10: TTFB ${LAST_TTFB}s total ${LAST_TOTAL}s"
  end_step

  begin "9-registry ${INGRESS}" "registry: billing's entry (needs, tools, version); unknown backend; a backend added and drained after the deploy (ADR-0024)"
  local entry
  entry="$(param "${REGISTRY_PREFIX}backends/billing" 2>/dev/null || true)"
  check "backends/billing is active with needs billing/read billing/invoke and tools invoices/*" \
    jq -e '.status == "active" and (.needs | sort) == ["billing/invoke","billing/read"] and .tools == ["invoices/*"] and (.version | type) == "number" and .scopes == null' <<<"$entry"
  entry="$(param "${REGISTRY_PREFIX}backends/default" 2>/dev/null || true)"
  check "backends/default needs default/chat, tools crm/*" jq -e '.needs == ["default/chat"] and .tools == ["crm/*"]' <<<"$entry"
  status="$(invoke "$(backend_url "$ENDPOINT" nosuch)" A1_ACCESS "$(body "$C1" report)")"
  check "unknown backend refused (got ${status})" ne "$status" 200
  note "billing and default entries in the v2 shape; /nosuch HTTP ${status}"
  if [[ "$INGRESS" == api-gateway ]]; then
    local late_param="${REGISTRY_PREFIX}backends/late" late_url table billing_arn
    late_url="$(backend_url "$ENDPOINT" late)"
    table="$(param "${REGISTRY_PREFIX}entitlementsTableName")"
    billing_arn="$(output "$INGRESS" BillingRuntimeArn)"
    LATE_PARAMS+=("$late_param")
    # A vendor write names reserved agents only (spec §5.3): reserve `late` as its AgentBackend would.
    aws dynamodb put-item --table-name "$table" --item '{"PK":{"S":"NAME#late"},"SK":{"S":"#NAME"},"kind":{"S":"agent"},"owner":{"S":"integ-driver"}}' >/dev/null
    LATE_ROWS+=("${table}|NAME#late")
    aws ssm put-parameter --name "$late_param" --type String --overwrite \
      --value "$(jq -nc --arg a "$billing_arn" '{runtimeArn: $a, needs: ["late/run"], tools: [], status: "active", version: 1}')" >/dev/null
    issue "$TENANT_A" "$A1_USER" A1
    status="$(invoke "$late_url" A1_ACCESS "$(body "$C1" report)")"
    check "late before tenant A subscribes: 403 agent_not_subscribed (got ${status} '$(body_text | head -c 60)')" contains "$(body_text)" agent_not_subscribed
    put_ok "subscribe tenant A to late" "$(vendor PUT "tenants/${TENANT_A}" '{"agents":["late"],"tools":[],"plan":"standard"}')"
    local deadline=$((SECONDS + 90)) served=""
    while [[ $SECONDS -lt $deadline ]]; do
      issue "$TENANT_A" "$A1_USER" A1
      status="$(invoke "$late_url" A1_ACCESS "$(body "$C1" report)")"
      if [[ "$status" == 200 ]]; then served=$((SECONDS - deadline + 90)); break; fi
      sleep 5
    done
    check "late was not served within 90 s of the registry write and the subscription" nonempty "$served"
    note "late served ${served:-never}s after the subscription"
    end_step

    # 12 (needs only): the late agent is served; it can reach no tools gateway (aud names none).
    begin "12-late ${INGRESS}" "an agent with needs only is served; its token names no tools gateway (spec §5.1 no_tools_granted)"
    check "late scope is late/run (got '$(rf .tokenScope)')" eq "$(rf .tokenScope)" late/run
    check "late aud is agent:late only (got $(rf -c .tokenAud))" eq "$(rf -c .tokenAud)" '["agent:late"]'
    status="$(invoke "$late_url" A1_ACCESS "$(tool_call_body "$C1" crm/get_account '{}')")"
    check "late's tool call is HTTP 200 at the ingress (got ${status})" eq "$status" 200
    check "late's tool call reaches no gateway (got '$(error_event)')" contains "$(error_event)" NoToolsGateway
    note "served, scope late/run, aud [agent:late]; a tool call has no gateway (step 17 shows the gateway refusing such a token)"
    end_step

    begin "9-drain ${INGRESS}" "late draining is refused within 90 s"
    aws ssm put-parameter --name "$late_param" --type String --overwrite \
      --value "$(jq -nc --arg a "$billing_arn" '{runtimeArn: $a, needs: ["late/run"], tools: [], status: "draining", version: 2}')" >/dev/null
    deadline=$((SECONDS + 90)); local drained=""
    while [[ $SECONDS -lt $deadline ]]; do
      issue "$TENANT_A" "$A1_USER" A1
      status="$(invoke "$late_url" A1_ACCESS "$(body "$C1" report)")"
      if [[ "$status" =~ ^(403|404)$ ]]; then drained=$((SECONDS - deadline + 90)); break; fi
      sleep 5
    done
    check "late still served 90 s after draining" nonempty "$drained"
    note "drained after ${drained:-never}s (HTTP ${status})"
    aws ssm delete-parameter --name "$late_param" >/dev/null 2>&1
    put_ok "unsubscribe tenant A from late" "$(vendor PUT "tenants/${TENANT_A}" '{"agents":[],"tools":[],"plan":"standard"}')"
    aws dynamodb delete-item --table-name "$table" --key '{"PK":{"S":"NAME#late"},"SK":{"S":"#NAME"}}' >/dev/null
    LATE_PARAMS=(); LATE_ROWS=()
  fi
  end_step

  fresh_tokens

  begin "11 ${INGRESS}" "the identity token stays at the ingress (P-14): header names, typ txn+jwt, iss the ingress issuer; the tool's context holds no token"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"
  local names
  names="$(rf '.headerNames | join(" ")')"
  check "the transaction-token header reached the agent (headers: ${names})" eq "$(rf .transactionToken)" true
  check "no ...-custom-user-token header (headers: ${names})" absent "$names" custom-user-token
  check "token typ is txn+jwt (got '$(rf .tokenTyp)')" eq "$(rf .tokenTyp)" "txn+jwt"
  check "token iss is the ingress issuer" eq "$(rf .tokenIss)" "$ISSUER"
  check "every JWT-shaped header is a txn+jwt from the ingress issuer: no identity token reached the agent ($(rf -c .jwtHeaders))" \
    jq -e --arg i "$ISSUER" '.jwtHeaders | length > 0 and all(.typ == "txn+jwt" and .iss == $i)' <<<"$(report_json)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_call_body "$C1" crm/get_account '{}')")"
  local payload
  payload="$(tool_payload)"
  check "crm/get_account served with a verified context (got '${payload:0:120}' $(probe_error))" jq -e '.contextVerified == true' <<<"$payload"
  check "the context's claims are names only, no token" jq -e '.contextClaims == ["agent","exp","sub","tenantId","tool","txn","user"]' <<<"$payload"
  note "headers: ${names}; tool context claims $(jq -c .contextClaims <<<"$payload" 2>/dev/null)"
  end_step

  begin "12 ${INGRESS}" "agent subscription: B1 on billing 403; AA cuts A1 from billing (next request 403), deletes the cut (200)"
  status="$(invoke "$BILLING_URL" B1_ACCESS "$(body "$C1" report)")"
  check "B1 on billing: 403 agent_not_subscribed (got ${status})" contains "$(body_text)" agent_not_subscribed
  put_ok "AA cuts A1 from billing" "$(admin_api PUT "users/${A1_SUB}/cut" AA_ACCESS '{"cutAgents":["billing"],"cutTools":[]}')"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" report)")"
  check "A1 on billing after the cut: 403 agent_not_subscribed (got ${status})" contains "$(body_text)" agent_not_subscribed
  put_ok "AA deletes A1's cut" "$(admin_api DELETE "users/${A1_SUB}/cut" AA_ACCESS)"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" report)")"
  check "A1 on billing after the cut is removed: 200 (got ${status})" eq "$status" 200
  note "cut lands on the next request and is lifted on the next"
  end_step

  begin "13 ${INGRESS}" "tenant tool subscription: B1 lists all three crm tools on default (target grain) and nothing of finance; B1's crm/update_case refused by the interceptor"
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" tools)")"
  check "B1 lists crm___get_account crm___list_cases crm___update_case on default (got '$(probe_tools default)')" \
    eq "$(probe_tools default)" "crm___get_account crm___list_cases crm___update_case"
  check "B1's token names no finance gateway" eq "$(rf '.result | has("finance")')" false
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(tool_call_body "$C1" crm/update_case '{"caseId":"case-1"}')")"
  check "B1 crm/update_case: forbidden: tool_not_granted (got '$(probe_error)')" eq "$(probe_error)" "forbidden: tool_not_granted"
  check "shape: an interceptor refusal reaches the agent as HTTP 403 (got $(probe_status); the spike saw 200 with the JSON-RPC error)" eq "$(probe_status)" 403
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" tools)")"
  check "A1 lists all three crm tools (got '$(probe_tools default)')" eq "$(probe_tools default)" "crm___get_account crm___list_cases crm___update_case"
  note "refusal surface: HTTP $(probe_status), message forbidden: tool_not_granted"
  end_step

  begin "14 ${INGRESS}" "agent product bound: default's token cannot reach finance; with finance in aud the interceptor refuses; A1 on billing is served"
  local tok_default tok_both
  mint tok_default "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]')"
  status="$(mcp "$TOOLS_FINANCE" tok_default tools/list)"
  check "finance refuses default's token at the authoriser: 403 (got ${status})" eq "$status" 403
  status="$(mcp "$TOOLS_FINANCE" tok_default tools/call '{"name":"invoices___get_invoice","arguments":{"invoiceId":"inv-1"}}')"
  check "finance refuses default's invoices call at the authoriser: 403 (got ${status})" eq "$status" 403
  mint tok_both "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default","finance"]')"
  status="$(mcp "$TOOLS_FINANCE" tok_both tools/call '{"name":"invoices___get_invoice","arguments":{"invoiceId":"inv-1"}}')"
  check "with finance in aud the interceptor refuses invoices/get_invoice (got ${status} '$(mcp_error)')" eq "$(mcp_error)" "forbidden: tool_not_granted"
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(tool_call_body "$C1" invoices/get_invoice '{"invoiceId":"inv-1"}')")"
  payload="$(tool_payload)"
  check "A1 on billing: invoices/get_invoice served with tenant A's inv-1 (got '${payload:0:120}' $(probe_error))" \
    jq -e --arg t "$TENANT_A" '.tenantId == $t and .invoice.invoiceId == "inv-1" and .invoice.amount == "10.00"' <<<"$payload"
  tok_default=""; tok_both=""
  end_step

  begin "15 ${INGRESS}" "cross-tenant: an altered tenant_id is 403 at the Gateway; a client _ri_ctx for B is overwritten; B1 gets B's data"
  local tok_tampered forged since
  mint tok_tampered "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]' "$(jq -nc --arg b "$TENANT_B" '{tamperTenantId: $b}')")"
  status="$(mcp "$TOOLS_DEFAULT" tok_tampered tools/list)"
  check "tenant_id altered after signing: 403 insufficient_scope at the Gateway (got ${status}; ADR-0040)" eq "$status" 403
  mint forged "$MINT_FN" "$(mint_event "$TENANT_B" "$(claim B1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]' '{"forgeContext":{"tenantId":"'"$TENANT_B"'","tool":"crm/get_account"}}')" context
  since="$(( $(date +%s) * 1000 ))"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_call_body "$C1" crm/get_account "$(jq -nc --arg c "$forged" --arg b "$TENANT_B" '{_ri_ctx: $c, tenantId: $b}')")")"
  payload="$(tool_payload)"
  check "A1 with a forged context and tenantId B gets tenant A's account (got '${payload:0:160}' $(probe_error))" \
    jq -e --arg t "$TENANT_A" '.tenantId == $t and .argsTenantId == $t and .account.accountId == "acc-a"' <<<"$payload"
  check "the interceptor logged the client context and tenant as overwritten" \
    wait_log "$INTERCEPTOR_LOGS" "$since" '"tool admitted"' '.clientContextOverwritten == true and .clientTenantOverwritten == true'
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(tool_call_body "$C1" crm/get_account '{}')")"
  payload="$(tool_payload)"
  check "B1 gets tenant B's account only (got '${payload:0:120}')" jq -e --arg t "$TENANT_B" '.tenantId == $t and .account.accountId == "acc-b"' <<<"$payload"
  tok_tampered=""; forged=""
  note "altered token 403; forged context overwritten; A and B each see their own account"
  end_step

  begin "16 ${INGRESS}" "a cut lands at once for new mints, and at exp for a token in flight"
  local tok_old
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_call_body "$C1" crm/update_case '{"caseId":"case-1","status":"closed"}')")"
  check "A1 crm/update_case served before the cut (got '$(tool_payload | head -c 100)' $(probe_error))" jq -e '.updated == true' <<<"$(tool_payload)"
  # 150 s: the Gateway refuses a token with 60 s or less left (integ run 7), so the
  # in-flight call below has 90 s to land; the after-exp check waits past exp.
  mint tok_old "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]' '{"ttlSeconds":150}')"
  local old_exp=$(( $(date +%s) + 150 ))
  put_ok "AA cuts A1 from crm/update_case" "$(admin_api PUT "users/${A1_SUB}/cut" AA_ACCESS '{"cutAgents":[],"cutTools":["crm/update_case"]}')"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"
  check "A1's next scope drops crm/update_case (got '$(rf .tokenScope)')" eq "$(rf .tokenScope)" "crm/get_account crm/list_cases default/chat"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_call_body "$C1" crm/update_case '{"caseId":"case-1"}')")"
  check "A1 crm/update_case after the cut: forbidden: tool_not_granted (got '$(probe_error)')" eq "$(probe_error)" "forbidden: tool_not_granted"
  status="$(mcp "$TOOLS_DEFAULT" tok_old tools/call '{"name":"crm___update_case","arguments":{"caseId":"case-1","status":"open"}}')"
  check "the token minted before the cut is still served until 60 s before exp (got ${status} '$(mcp_error)')" eq "$(mcp_error)" ""
  sleep $(( old_exp - $(date +%s) + 20 > 0 ? old_exp - $(date +%s) + 20 : 0 ))
  status="$(mcp "$TOOLS_DEFAULT" tok_old tools/list)"
  check "after exp the old token is 403 insufficient_scope (got ${status}; ADR-0040)" eq "$status" 403
  put_ok "AA deletes A1's cut" "$(admin_api DELETE "users/${A1_SUB}/cut" AA_ACCESS)"
  issue "$TENANT_A" "$A1_USER" A1
  tok_old=""
  note "new mint cut at once; the in-flight token served until exp, then 403"
  end_step

  begin "17 ${INGRESS}" "interceptor and Gateway checks on minted tokens (act, aud, foreign gateway, identity token)"
  local t17 sub_a
  sub_a="$(claim A1_ACCESS sub)"
  local call='{"name":"crm___get_account","arguments":{}}'
  mint t17 "$MINT_FN" "$(mint_event "$TENANT_A" "$sub_a" default "$DEFAULT_SCOPE_A" '["default"]' '{"claims":{"act":null}}')"
  status="$(mcp "$TOOLS_DEFAULT" t17 tools/call "$call")"
  check "no act: forbidden: act_missing (got ${status} '$(mcp_error)')" eq "$(mcp_error)" "forbidden: act_missing"
  mint t17 "$MINT_FN" "$(mint_event "$TENANT_A" "$sub_a" default "$DEFAULT_SCOPE_A" '["default"]' '{"claims":{"act":{"sub":"arn:aws:iam::000000000000:role/NotTheIngress"}}}')"
  status="$(mcp "$TOOLS_DEFAULT" t17 tools/call "$call")"
  check "act.sub another role: forbidden: act_missing (got ${status} '$(mcp_error)')" eq "$(mcp_error)" "forbidden: act_missing"
  mint t17 "$MINT_FN" "$(mint_event "$TENANT_A" "$sub_a" default "$DEFAULT_SCOPE_A" '[]')"
  status="$(mcp "$TOOLS_DEFAULT" t17 tools/call "$call")"
  check "aud agent:default only: 403 insufficient_scope at the Gateway (got ${status})" eq "$status" 403
  mint t17 "$MINT_FN" "$(mint_event "$TENANT_A" "$sub_a" default "$DEFAULT_SCOPE_A" '["default"]' '{"claims":{"aud":["agent:billing","tools-gateway:default"]}}')"
  status="$(mcp "$TOOLS_DEFAULT" t17 tools/call "$call")"
  check "aud for another agent: forbidden: aud_mismatch (got ${status} '$(mcp_error)')" eq "$(mcp_error)" "forbidden: aud_mismatch"
  mint t17 "$MINT_FN" "$(mint_event "$TENANT_A" "$sub_a" default "$DEFAULT_SCOPE_A" '["finance"]')"
  status="$(mcp "$TOOLS_DEFAULT" t17 tools/call "$call")"
  check "a token for gateway finance on default: refused at the authoriser, 403 (got ${status})" eq "$status" 403
  status="$(mcp "$TOOLS_DEFAULT" A1_ACCESS tools/list)"
  check "an identity token as bearer: 403 insufficient_scope (wrong iss; got ${status})" eq "$status" 403
  t17=""
  note "act_missing x2, aud_mismatch, Gateway 403 for aud, foreign gateway and identity token"
  end_step

  begin "18 ${INGRESS}" "the ingress refuses its own transaction token as an identity token (P-14)"
  local t18
  mint t18 "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]')"
  status="$(invoke "$ENDPOINT" t18 "$(body "$C1" report)")"
  check "transaction token at /invocations: 401|403 (got ${status})" status_is "401|403" "$status"
  t18=""
  note "HTTP ${status}"
  end_step

  begin "19-tenant_id ${INGRESS}" "A1 (a tenant_id token) with X-Tenant-Id B: 403 tenant_not_allowed"
  # A fresh token on both sides: on a single-tenant ingress X-Tenant-Id is not an
  # authoriser identity source, so a cached decision for the token would answer
  # this request, and this Deny would answer A1's next header-less request for the
  # cache TTL (integ run 7, step 20).
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)" "" "$TENANT_B")"
  check "A1 with X-Tenant-Id B: 403 (got ${status})" eq "$status" 403
  check "body names tenant_not_allowed (got '$(body_text | head -c 60)')" contains "$(body_text)" tenant_not_allowed
  # New tokens for every user: this Deny is cached for A1's token, and the
  # 5-minute identity tokens from before step 11 would expire during 20 to 24.
  fresh_tokens
  end_step

  begin "20 ${INGRESS}" "tool data isolation: the crm Lambda without a context assumes no role; the tool's credentials cannot read tenant B (P-15)"
  T20_START="$(( $(date +%s) * 1000 ))"
  aws lambda invoke --function-name "$CRM_FN" --cli-binary-format raw-in-base64-out --payload '{"accountId":"acc-a"}' "${LIB_TMP}/crm-direct.out" >/dev/null 2>&1 || true
  check "direct invoke without _ri_ctx: context_invalid (got '$(head -c 80 "${LIB_TMP}/crm-direct.out")')" jq -e '.error == "context_invalid"' "${LIB_TMP}/crm-direct.out"
  T20_END="$(( $(date +%s) * 1000 + 5000 ))"
  echo "${CRM_TOOL_ROLE}|${T20_START}|${T20_END}" >>"${LIB_TMP}/cloudtrail-windows"
  sleep 20
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_call_body "$C1" crm/get_account "$(jq -nc --arg b "$TENANT_B" '{probeTenantId: $b}')")")"
  payload="$(tool_payload)"
  check "A1's get_account reads tenant A (got '${payload:0:120}')" jq -e --arg t "$TENANT_A" '.tenantId == $t and .account.accountId == "acc-a"' <<<"$payload"
  check "the same credentials reading tenant B: AccessDeniedException (got $(jq -c .probe <<<"$payload" 2>/dev/null))" \
    jq -e '.probe.result == "error" and .probe.error == "AccessDeniedException"' <<<"$payload"
  note "context_invalid; probe AccessDeniedException; no AssumeRole in the window is checked in step 20-cloudtrail"
  end_step

  begin "22 ${INGRESS}" "partial-target grant: A2 served crm/get_account, refused crm/update_case by the interceptor (decision deny, reason scope); the crm Lambda is not invoked"
  status="$(invoke "$ENDPOINT" A2_ACCESS "$(tool_call_body "$C1" crm/get_account '{}')")"
  check "A2 crm/get_account served (got '$(tool_payload | head -c 80)' $(probe_error))" jq -e '.account.accountId == "acc-a"' <<<"$(tool_payload)"
  since="$(( $(date +%s) * 1000 ))"
  status="$(invoke "$ENDPOINT" A2_ACCESS "$(tool_call_body "$C1" crm/update_case '{"caseId":"case-1"}')")"
  check "A2 crm/update_case: forbidden: tool_not_granted (got '$(probe_error)')" eq "$(probe_error)" "forbidden: tool_not_granted"
  check "a tool admitted line with decision deny, tenant A, gateway default, reason scope" \
    wait_log "$INTERCEPTOR_LOGS" "$since" '"tool admitted"' ".decision == \"deny\" and .tenantId == \"${TENANT_A}\" and .gateway == \"default\" and .reason == \"scope\" and .tool == \"crm/update_case\""
  check "the crm Lambda served no crm/update_case for A2" eq "$(log_lines "$CRM_LOGS" "$since" '"tool served"' | jq -s 'map(select(.tool == "crm/update_case")) | length')" 0
  local t22 ctx22
  mint t22 "$MINT_FN" "$(mint_event "$TENANT_A" "$A2_SUB" default 'crm/get_account default/chat' '["default"]')"
  mint ctx22 "$MINT_FN" "$(mint_event "$TENANT_A" "$A2_SUB" default 'crm/get_account default/chat' '["default"]' '{"forgeContext":{"tenantId":"'"$TENANT_A"'","tool":"crm/update_case"}}')" context
  status="$(mcp "$TOOLS_DEFAULT" t22 tools/call "$(jq -nc --arg c "$ctx22" '{name: "crm___update_case", arguments: {caseId: "case-1", _ri_ctx: $c}}')")"
  check "scope crm/get_account with a forged update_case context: forbidden: tool_not_granted (got ${status} '$(mcp_error)')" eq "$(mcp_error)" "forbidden: tool_not_granted"
  t22=""; ctx22=""
  end_step

  begin "23 ${INGRESS}" "one policy per target: the star permit of crm on default, of invoices on finance; time to ACTIVE recorded (ADR-0041)"
  local pair engine target policies
  for pair in "default:${ENGINE_DEFAULT}:crm" "finance:${ENGINE_FINANCE}:invoices"; do
    engine="$(cut -d: -f2 <<<"$pair")"; target="$(cut -d: -f3 <<<"$pair")"
    policies="$(aws bedrock-agentcore-control list-policies --policy-engine-id "$engine" --output json 2>/dev/null || echo '{}')"
    check "gateway ${pair%%:*} holds exactly one policy (got $(jq '.policies | length' <<<"$policies" 2>/dev/null))" jq -e '.policies | length == 1' <<<"$policies"
    local pid
    pid="$(jq -r '.policies[0].policyId // empty' <<<"$policies")"
    local def
    def="$(aws bedrock-agentcore-control get-policy --policy-engine-id "$engine" --policy-id "$pid" --output json 2>/dev/null || echo '{}')"
    check "gateway ${pair%%:*}: the policy is ACTIVE and permits action in AgentCore::Action::\"${target}\"" \
      jq -e --arg t "$target" '.status == "ACTIVE" and (.definition.cedar.statement | contains("action in AgentCore::Action::\"" + $t + "\""))' <<<"$def"
  done
  note "crm ACTIVE in $(output "$INGRESS" CrmPolicySecondsToActive)s, invoices in $(output "$INGRESS" InvoicesPolicySecondsToActive)s (custom resource, CreatePolicy to ACTIVE)"
  end_step

  begin "24 ${INGRESS}" "list filter on finance: a cut list_invoices disappears from A1's list, comes back without the cut; a failing filter lists nothing, the call is still served"
  put_ok "AA cuts A1 from invoices/list_invoices" "$(admin_api PUT "users/${A1_SUB}/cut" AA_ACCESS '{"cutAgents":[],"cutTools":["invoices/list_invoices"]}')"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" tools)")"
  check "shape: with the cut, finance lists invoices___get_invoice only (got '$(probe_tools finance)' $(probe_gateway_error finance); an empty list means the request headers did not reach the RESPONSE interceptor)" \
    eq "$(probe_tools finance)" "invoices___get_invoice"
  put_ok "AA deletes A1's cut" "$(admin_api DELETE "users/${A1_SUB}/cut" AA_ACCESS)"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" tools)")"
  check "without the cut, finance lists both tools (got '$(probe_tools finance)')" eq "$(probe_tools finance)" "invoices___get_invoice invoices___list_invoices"
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" tools)")"
  check "default (filter off) still lists all three crm tools for B1 (got '$(probe_tools default)')" eq "$(probe_tools default)" "crm___get_account crm___list_cases crm___update_case"
  local env_json forced
  env_json="$(aws lambda get-function-configuration --function-name "$FILTER_FN" --query Environment --output json)"
  FILTER_RESTORE+=("${FILTER_FN}|${env_json}")
  forced="$(jq -c '.Variables.RI_RESPONSE_FILTER_FORCE_ERROR = "true"' <<<"$env_json")"
  aws lambda update-function-configuration --function-name "$FILTER_FN" --environment "$forced" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FILTER_FN" 2>/dev/null || aws lambda wait function-updated --function-name "$FILTER_FN"
  issue "$TENANT_A" "$A1_USER" A1
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" tools)")"
  check "a failing filter: finance lists no tools (got '$(probe_tools finance)')" eq "$(probe_tools finance)" ""
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(tool_call_body "$C1" invoices/get_invoice '{"invoiceId":"inv-1"}')")"
  check "a failing filter: invoices/get_invoice still served (got '$(tool_payload | head -c 80)' $(probe_error))" jq -e '.invoice.invoiceId == "inv-1"' <<<"$(tool_payload)"
  aws lambda update-function-configuration --function-name "$FILTER_FN" --environment "$env_json" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FILTER_FN" 2>/dev/null || aws lambda wait function-updated --function-name "$FILTER_FN"
  FILTER_RESTORE=()
  note "filtered to the grant; fail-closed list; call wall unaffected"
  end_step
}

for INGRESS in "${ALL_ON[@]}"; do run_all_on "$INGRESS"; done

# --------------------------------------------------------------------------
# The single-purpose stacks
# --------------------------------------------------------------------------
fresh_tokens
ENDPOINT="$(output session-off EndpointUrl)"
begin 4a "session off: conversationId is 400; two requests land in two units (P-2)"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"; check "conversationId with session off: 400 (got ${status})" eq "$status" 400
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"report"}')"; check "first request 200 (got ${status})" eq "$status" 200
U1="$(rf .unitId)"; N1="$(rf .nonce)"
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"report"}' "$U1")"
check "the second request reused the first unit" ne "$(rf .unitId)" "$U1"
check "the second request reached the first microVM" ne "$(rf .nonce)" "$N1"
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"Say hello in three words."}')"
check "default model-only tenant role: a model prompt ends with usage (got '$(error_event)')" nonempty "$(usage_json)"
note "two units, two microVMs; default role model call usage $(usage_json)"
end_step

ENDPOINT="$(output session-user EndpointUrl)"
begin 4b-user "session scope user: A2 sending A1's c1 lands in its own unit (P-2)"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"; check "A1 200 (got ${status})" eq "$status" 200
U1="$(rf .unitId)"
status="$(invoke "$ENDPOINT" A2_ACCESS "$(body "integConversation${RUN}" report)" "$U1")"; check "A2 200 (got ${status})" eq "$status" 200
check "A2 landed in A1's unit under scope user" ne "$(rf .unitId)" "$U1"
note "own unit"
end_step

ENDPOINT="$(output limits EndpointUrl)"
begin limits "per-tenant limit, 5 requests a minute (ADR-0020): A limited, B served; the floor app/use admits both"
limited=0
for i in $(seq 1 12); do
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"
  if [[ "$status" == 429 ]]; then limited=$i; break; fi
  [[ "$status" == 200 ]] || { check "limit probe call $i: HTTP ${status} (the floor app/use?)" false; break; }
done
check "tenant A was never limited in 12 calls" test "$limited" -gt 0
check "429 body is the fixed text (got '$(body_text | head -c 40)')" eq "$(body_text)" "too many requests"
status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "integConversation${RUN}" report)")"; check "tenant B while A is limited: 200 (got ${status})" eq "$status" 200
note "A 429 on call ${limited}; B 200"
end_step

if [[ "$MT_ENABLED" == 1 ]]; then
  ENDPOINT="$(output multi-tenant EndpointUrl)"
  identity_use mt
  issue "$MT_A" "$MU_USER" MU
  identity_use shared
  begin 19 "multi-tenant user MU (tenants A', M): no header refused, B' not allowed, M and A' each their own grant and data (ADR-0038)"
  mu_tenants="$(claim MU_ACCESS tenants | jq -c 'sort' 2>/dev/null || true)"
  check "MU's token carries tenants [A', M] (got ${mu_tenants})" eq "$mu_tenants" "$(jq -nc --arg a "$MT_A" --arg m "$MT_M" '[$a, $m] | sort')"
  status="$(invoke "$ENDPOINT" MU_ACCESS "$(body "integConversation${RUN}" report)")"
  # api-gateway: a missing identity source (X-Tenant-Id) is API Gateway's own 401 before the authoriser runs.
  check "MU without X-Tenant-Id: refused, tenant_required where the ingress code answers (got ${status} '$(body_text | head -c 60)')" status_is "400|401|403" "$status"
  status="$(invoke "$ENDPOINT" MU_ACCESS "$(body "integConversation${RUN}" report)" "" "$MT_B")"
  check "MU with B': 403 tenant_not_allowed (got ${status} '$(body_text | head -c 60)')" contains "$(body_text)" tenant_not_allowed
  status="$(invoke "$ENDPOINT" MU_ACCESS "$(body "integConversation${RUN}" report)" "" "$MT_M")"
  check "MU with M: scope crm/get_account default/chat (got '$(rf .tokenScope)')" eq "$(rf .tokenScope)" "crm/get_account default/chat"
  check "MU with M: tenant M" eq "$(rf .tokenTenant)" "$MT_M"
  status="$(invoke "$ENDPOINT" MU_ACCESS "$(tool_call_body "integConversation${RUN}" crm/get_account '{}')" "" "$MT_M")"
  check "MU with M: the tool returns M's account (got '$(tool_payload | head -c 100)' $(probe_error))" jq -e --arg m "$MT_M" '.tenantId == $m and .account.accountId == "acc-mtm"' <<<"$(tool_payload)"
  status="$(invoke "$ENDPOINT" MU_ACCESS "$(body "integConversation${RUN}" report)" "" "$MT_A")"
  check "MU with A': A's grant crm/* default/chat (got '$(rf .tokenScope)')" eq "$(rf .tokenScope)" "$DEFAULT_SCOPE_A"
  note "no header HTTP ${status}; B' 403; M and A' each their own grant"
  end_step
else
  skip_step 19 "INTEG_SKIP_MULTI_TENANT=1: no shared-pool-multi-tenant deployment (the tenant_id half ran as 19-tenant_id)"
fi

# --------------------------------------------------------------------------
# 21. Key rotation on the api-gateway stack
# --------------------------------------------------------------------------
stack_vars api-gateway
fresh_tokens
begin "21 api-gateway" "key rotation: keyGeneration 2; the JWKS lists both kids; the old token is still accepted until exp; new tokens carry the new kid (spec §6.2.3)"
tok21=""
mint tok21 "$MINT_FN" "$(mint_event "$TENANT_A" "$(claim A1_ACCESS sub)" default "$DEFAULT_SCOPE_A" '["default"]' '{"ttlSeconds":900}')"
OLD_KID="$MINT_KID"
ROTATE_START=$SECONDS
synth 2
"${CDK[@]}" deploy "${STACK_PREFIX}-api-gateway" --exclusively --require-approval never --outputs-file "${LIB_TMP}/outputs-rotated.json" >"${LIB_TMP}/rotate.log" 2>&1 \
  || { tail -20 "${LIB_TMP}/rotate.log" >&2; check "redeploy with keyGeneration 2" false; }
jwks="$(curl -s "${ISSUER}/.well-known/jwks.json")"
check "the JWKS lists two keys, the old kid among them (got $(jq -c '[.keys[].kid]' <<<"$jwks" 2>/dev/null))" jq -e --arg k "$OLD_KID" '(.keys | length) == 2 and any(.keys[]; .kid == $k)' <<<"$jwks"
status="$(mcp "$TOOLS_DEFAULT" tok21 tools/list)"
check "the token signed by the old key is still accepted at the tools gateway (got ${status})" eq "$status" 200
issue "$TENANT_A" "$A1_USER" A1
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"
NEW_KID="$(rf .tokenKid)"
check "a new A1 request carries a new kid (got '${NEW_KID}', old '${OLD_KID}')" ne "$NEW_KID" "$OLD_KID"
check "the new kid is in the JWKS" jq -e --arg k "$NEW_KID" 'any(.keys[]; .kid == $k)' <<<"$jwks"
tok21=""
note "rotated in $((SECONDS - ROTATE_START))s; JWKS $(jq -c '[.keys[].kid] | length' <<<"$jwks" 2>/dev/null) keys"
end_step

# --------------------------------------------------------------------------
# 20 (CloudTrail half): no AssumeRole on the tool tenant role in the direct-invoke windows
# --------------------------------------------------------------------------
begin 20-cloudtrail "no AssumeRole on the crm tool tenant role for the direct invoke (positive control: the role's other AssumeRole events arrive)"
while IFS='|' read -r role from to; do
  [[ -n "$role" ]] || continue
  deadline=$((SECONDS + 900)); seen_any=""
  while [[ $SECONDS -lt $deadline ]]; do
    events="$(aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue="$role" \
      --start-time "$(date -u -d "@$(( RUN - 60 ))" +%FT%TZ)" --output json 2>/dev/null | jq '[.Events[] | select(.EventName == "AssumeRole")]' 2>/dev/null || echo '[]')"
    if [[ "$(jq length <<<"$events")" -gt 0 ]]; then seen_any=1; break; fi
    sleep 60
  done
  check "positive control: CloudTrail shows AssumeRole events on ${role##*/} within 15 min" nonempty "$seen_any"
  # EventTime is epoch seconds or an ISO 8601 string, depending on the CLI's cli_timestamp_format.
  in_window="$(jq --argjson f "$((from / 1000))" --argjson t "$((to / 1000))" '
    def epoch: if type == "number" then floor else (sub("\\.[0-9]+"; "") | sub("(\\+00:00|Z)$"; "Z") | fromdateiso8601) end;
    [.[] | (.EventTime | epoch) as $e | select($e >= $f and $e <= $t)] | length' <<<"$events" 2>/dev/null || echo error)"
  check "an AssumeRole on ${role##*/} in the direct-invoke window" eq "$in_window" 0
done <"${LIB_TMP}/cloudtrail-windows"
note "no AssumeRole in the direct-invoke windows"
end_step

# --------------------------------------------------------------------------
# The log sweep (spec §8, v1 V-7 method)
# --------------------------------------------------------------------------
begin sweep "no token, signature segment or _ri_ctx value in any log group on the path"
sweep_file="${LIB_TMP}/sweep"
: >"$sweep_file"
chmod 600 "$sweep_file"
groups_file="${LIB_TMP}/sweep-groups"
: >"$groups_file"
for s in "${SUFFIXES[@]}"; do
  log_groups_of "${STACK_PREFIX}-${s}" >>"$groups_file"
  for rt in $(runtimes_of "${STACK_PREFIX}-${s}"); do
    aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text | tr '\t' '\n' >>"$groups_file"
  done
  for api in $(resources_of "${STACK_PREFIX}-${s}" AWS::ApiGateway::RestApi); do
    aws logs describe-log-groups --log-group-name-prefix "API-Gateway-Execution-Logs_${api}" --query 'logGroups[].logGroupName' --output text | tr '\t' '\n' >>"$groups_file"
  done
done
swept=0
while read -r g; do
  [[ -n "$g" && "$g" != None ]] || continue
  aws logs filter-log-events --log-group-name "$g" --start-time "$RUN_START_MS" --query 'events[].message' --output json 2>/dev/null | jq -r '.[]' >>"$sweep_file" 2>/dev/null || true
  swept=$((swept + 1))
done < <(sort -u "$groups_file")
hits_eyj="$(grep -c 'eyJ' "$sweep_file" || true)"
hits_sig="$(grep -c -F -f "$SECRETS" "$sweep_file" || true)"
hits_ctx="$(grep -c -E '_ri_ctx"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_-]{8,}' "$sweep_file" || true)"
check "${hits_eyj} log lines hold eyJ" eq "$hits_eyj" 0
check "${hits_sig} log lines hold a signature segment of a token or context this run used" eq "$hits_sig" 0
check "${hits_ctx} log lines hold an _ri_ctx value" eq "$hits_ctx" 0
: >"$sweep_file"
note "${swept} log groups, $(wc -l <"$SECRETS") signature segments: 0 hits"
end_step

# --------------------------------------------------------------------------
# 8b (metrics). The EMF records reach CloudWatch metrics within minutes.
# --------------------------------------------------------------------------
begin 8b-metrics "per-tenant ModelOutputTokens for tenant A on api-gateway; none on agentcore-gateway (perTenantMetrics off, ADR-0021)"
found=0
for _ in $(seq 1 20); do
  sum="$(aws cloudwatch get-metric-statistics --namespace RuntimeIsolation --metric-name ModelOutputTokens \
    --dimensions Name=TenantId,Value="$TENANT_A" Name=Ingress,Value=api-gateway --statistics Sum --period 3600 \
    --start-time "$STARTED" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null || echo 0)"
  if [[ "$sum" != None && "$sum" != 0 && "$sum" != 0.0 ]]; then found=1; break; fi
  sleep 15
done
check "no ModelOutputTokens datapoint for tenant A after 5 minutes" eq "$found" 1
left="$(aws cloudwatch list-metrics --namespace RuntimeIsolation --metric-name Requests \
  --dimensions Name=TenantId,Value="$TENANT_A" Name=Ingress,Value=agentcore-gateway --query 'length(Metrics)' --output text)"
check "agentcore-gateway emitted per-tenant metrics with perTenantMetrics off" eq "$left" 0
note "ModelOutputTokens=${sum:-0}"
end_step

echo "== steps complete in ${SECONDS}s"
