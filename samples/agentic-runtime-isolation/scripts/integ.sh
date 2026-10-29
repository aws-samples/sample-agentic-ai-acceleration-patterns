#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §8, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# Flow:
#   1. tenant-identity (shared-pool): reuse a published deployment when it
#      has the scope catalogue (GET /platform/scopes, ADR-0025); a published
#      one without it is stale and is destroyed and redeployed from
#      ../tenant-identity (and left in place, republished); none at all is
#      deployed and destroyed at the end (ADR-0004, tenant-identity
#      ADR-0017). Create tenant A entitled to every demo scope and tenant B
#      to default/chat; users A1 (admin), A2, B1; A1 cuts A2 to default/chat
#      and billing/read through the tenant API; check what each can narrow to.
#   2. Synthesise test/integ.runtime.ts and deploy its four stacks at once.
#   3..9 on both all-on stacks (api-gateway, agentcore-gateway).
#   9-registry (ADR-0024, ADR-0025) on both: the second backend `billing`
#      and its scopes (any one admits), an unknown backend name; on
#      api-gateway also a backend added and drained through a registry write
#      after the deploy.
#   4a on the session-off stack (also a model call on the default role).
#   8 (narrowed), the floor plus the backend scopes, and the per-tenant
#      limit (ADR-0020) on the narrowed stack.
#   8b per-tenant metrics; then scripts/demo.sh against the published stack.
#  10. Destroy from the EXIT trap (also on failure); assert nothing is left.
#
# Deploys into the account of the ambient AWS credentials, which must be
# CDK-bootstrapped in AWS_REGION. Conventions: scripts/CONVENTIONS.md.

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)}"
export AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq npx; do
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
STACK_PREFIX="RuntimeIsolationInteg"
IDENTITY_STACK="TenantIdentity-shared-pool"
SUFFIXES=(api-gateway agentcore-gateway session-off narrowed)
DEPLOYED_IDENTITY=0
DEPLOYED_SAMPLE=0
FAILED=0
RUN="$(date +%s)"
STARTED="$(date -u +%FT%TZ)"
RESULTS="${LIB_TMP}/results"
: >"$RESULTS"

# The demo scopes (DEFAULT_SCOPE, BILLING_READ_SCOPE, BILLING_INVOKE_SCOPE)
# come from lib.sh and MUST match src/demo.cdk.ts (ADR-0025).
# Registry entries this script wrote (step 9-registry); removed in cleanup.
LATE_PARAMS=()

log_groups_of() { # STACK -> the stack's AWS::Logs::LogGroup physical ids
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text 2>/dev/null | tr '\t' '\n'
}

params_of() { # STACK -> the stack's AWS::SSM::Parameter names
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId" --output text 2>/dev/null | tr '\t' '\n'
}

# runtimes_of STACK -> the Runtime ids of every *RuntimeArn output (RuntimeArn,
# BillingRuntimeArn, ... one per AgentBackend, ADR-0024). Each Runtime writes
# its own log groups under /aws/bedrock-agentcore/runtimes/<id> outside
# CloudFormation, so the destroy leaves them and cleanup must know every id.
runtimes_of() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?ends_with(OutputKey, 'RuntimeArn')].OutputValue" --output text 2>/dev/null | tr '\t' '\n' | sed 's#.*/##'
}
RUNTIME_LOG_PREFIX="/aws/bedrock-agentcore/runtimes/"

cleanup() {
  local status=$?
  set +e
  echo "== step 10: teardown"
  delete_tenants
  # The registry entry step 9-registry wrote belongs to this script, not to a
  # stack, so the stack destroy would leave it (CONVENTIONS.md).
  local lp
  for lp in "${LATE_PARAMS[@]:-}"; do
    [[ -n "$lp" ]] && aws ssm delete-parameter --name "$lp" >/dev/null 2>&1
  done
  local groups="${LIB_TMP}/log-groups" runtimes="${LIB_TMP}/runtimes" params="${LIB_TMP}/params" s
  : >"$groups"; : >"$runtimes"; : >"$params"
  if [[ "$DEPLOYED_SAMPLE" == 1 ]]; then
    for s in "${SUFFIXES[@]}"; do
      log_groups_of "${STACK_PREFIX}-${s}" >>"$groups"
      params_of "${STACK_PREFIX}-${s}" >>"$params"
      runtimes_of "${STACK_PREFIX}-${s}" >>"$runtimes"
    done
    "${CDK[@]}" destroy --all --force --concurrency 4 >"${LIB_TMP}/destroy.log" 2>&1 \
      || { echo "destroy failed: ${STACK_PREFIX} stacks (see cdk output above)" >&2; tail -20 "${LIB_TMP}/destroy.log" >&2; FAILED=1; }
    # Every Runtime (default and billing) writes its own log groups outside CloudFormation.
    while read -r rt; do
      [[ -n "$rt" && "$rt" != None ]] || continue
      for g in $(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" \
        --query 'logGroups[].logGroupName' --output text); do
        aws logs delete-log-group --log-group-name "$g" >/dev/null 2>&1
      done
    done <"$runtimes"
  fi
  if [[ "$DEPLOYED_IDENTITY" == 1 ]]; then
    (cd "$IDENTITY_DIR" && npx cdk destroy "$IDENTITY_STACK" --context topology=shared-pool --force >"${LIB_TMP}/identity-destroy.log" 2>&1) \
      || { echo "destroy failed: ${IDENTITY_STACK}" >&2; FAILED=1; }
  fi
  local left
  left="$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}')].StackName" --output text)"
  if [[ -n "$left" ]]; then echo "leftover stacks: $left" >&2; FAILED=1; fi
  if [[ "$DEPLOYED_SAMPLE" == 1 ]]; then
    # Only the parameters this run's stacks wrote. Another deployment (a demo
    # or a parallel run) may own parameters under the same prefix.
    while read -r p; do
      [[ -n "$p" && "$p" != None ]] || continue
      if aws ssm get-parameter --name "$p" --query Parameter.Name --output text >/dev/null 2>&1; then
        echo "leftover parameter: $p" >&2; FAILED=1
      fi
    done <"$params"
    while read -r g; do
      [[ -n "$g" ]] || continue
      if aws logs describe-log-groups --log-group-name-prefix "$g" --query "logGroups[?logGroupName=='$g'].logGroupName" --output text | grep -q .; then
        echo "leftover log group (recreated by a writer after delete): $g" >&2; FAILED=1
      fi
    done <"$groups"
    # The Runtimes' own log-group prefixes, for every Runtime id collected above.
    while read -r rt; do
      [[ -n "$rt" && "$rt" != None ]] || continue
      left="$(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text)"
      if [[ -n "$left" && "$left" != None ]]; then
        echo "leftover runtime log groups under ${RUNTIME_LOG_PREFIX}${rt}: $left" >&2; FAILED=1
      fi
    done <"$runtimes"
  fi
  [[ -s "$RESULTS" ]] && { echo "== results"; cat "$RESULTS"; }
  rm -rf "$LIB_TMP"
  if [[ "$status" -ne 0 ]] || [[ "$FAILED" -ne 0 ]]; then
    echo "integ: FAILED" >&2
    exit 1
  fi
  echo "integ: PASSED"
}
trap cleanup EXIT

step() { echo "== step $1: $2"; }
output() { jq -r --arg s "${STACK_PREFIX}-$1" --arg k "$2" '.[$s][$k] // empty' "${LIB_TMP}/outputs.json"; }
body() { jq -nc --arg c "$1" --arg p "$2" '{conversationId: $c, prompt: $p}'; }

# registry_entry RUNTIME_ARN SCOPES_JSON STATUS -> the entry JSON (src/shared/registry.ts schema).
registry_entry() { jq -nc --arg a "$1" --argjson s "$2" --arg st "$3" '{runtimeArn: $a, scopes: $s, status: $st}'; }

# identity_prepare -> npm ci (when node_modules is missing) and projen build
# in ../tenant-identity, once per run. Every cdk command there, destroy
# included, synthesises the app, which reads the Smithy-generated OpenAPI
# under its gitignored src/smithy/ that only the build produces.
IDENTITY_PREPARED=0
identity_prepare() {
  [[ "$IDENTITY_PREPARED" == 1 ]] && return 0
  (cd "$IDENTITY_DIR" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund >"${LIB_TMP}/identity-install.log" 2>&1; }) \
    || { tail -30 "${LIB_TMP}/identity-install.log" >&2; fail "npm ci in ${IDENTITY_DIR}"; }
  (cd "$IDENTITY_DIR" && npx projen build >"${LIB_TMP}/identity-build.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-build.log" >&2; fail "projen build in ${IDENTITY_DIR}"; }
  IDENTITY_PREPARED=1
}

# deploy_identity -> builds and deploys TenantIdentity-shared-pool from ../tenant-identity (its own path).
deploy_identity() {
  echo "  deploying ${IDENTITY_STACK} through its own path (npm ci if needed, projen build, cdk deploy)"
  identity_prepare
  (cd "$IDENTITY_DIR" \
    && npx cdk deploy "$IDENTITY_STACK" --context topology=shared-pool --require-approval never >"${LIB_TMP}/identity-deploy.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-deploy.log" >&2; fail "deploy ${IDENTITY_STACK}"; }
}

# --------------------------------------------------------------------------
# 1. tenant-identity (shared-pool): reused, republished when stale, or deployed
# --------------------------------------------------------------------------
step 1 "tenant-identity shared-pool"
if aws ssm get-parameter --name "${IDENTITY_PREFIX}/apiUrl" --query Parameter.Name --output text >/dev/null 2>&1; then
  identity_init
  # A published deployment from before the scope catalogue has no
  # /platform/scopes route; API Gateway answers "Missing Authentication
  # Token" for it. The backends' ScopeRegistration would fail against it, so
  # it is replaced by the current ../tenant-identity, which stays published.
  status="$(scope_catalogue_status)"
  if [[ "$status" == 200 ]]; then
    echo "  reusing the published tenant-identity deployment (GET /platform/scopes -> HTTP 200)"
  elif stale_identity "$status"; then
    echo "  the published tenant-identity is stale (GET /platform/scopes -> HTTP ${status}, no such route): destroying and redeploying it from ${IDENTITY_DIR}"
    identity_prepare
    (cd "$IDENTITY_DIR" && npx cdk destroy "$IDENTITY_STACK" --context topology=shared-pool --force >"${LIB_TMP}/identity-stale-destroy.log" 2>&1) \
      || { tail -30 "${LIB_TMP}/identity-stale-destroy.log" >&2; fail "destroy the stale ${IDENTITY_STACK}"; }
    deploy_identity
    identity_init
    status="$(scope_catalogue_status)"; expect_status 200 "$status" "GET /platform/scopes on the redeployed tenant-identity"
  else
    fail "GET /platform/scopes on the published tenant-identity: HTTP ${status} (neither the catalogue nor a missing route)"
  fi
else
  DEPLOYED_IDENTITY=1
  deploy_identity
  identity_init
fi

# Tenant A is entitled to every demo scope, tenant B to default/chat only
# (CreateTenant.scopes, tenant-identity ADR-0035). The admin of A then cuts
# A2 to default/chat and billing/read through the tenant API (ADR-0036).
create_tenant "rtiso-integ-a-${RUN}" "$ALL_DEMO_SCOPES"; TENANT_A="$TENANT_ID"; A1_USER="$ADMIN_USERNAME"; issue_token "$TENANT_A" "$A1_USER" A1
create_user "$TENANT_A" "rtiso-integ-a2-${RUN}"; A2_USER="$USERNAME"; issue_token "$TENANT_A" "$A2_USER" A2
create_tenant "rtiso-integ-b-${RUN}" "$DEFAULT_SCOPE"; TENANT_B="$TENANT_ID"; B1_USER="$ADMIN_USERNAME"; issue_token "$TENANT_B" "$B1_USER" B1
echo "  tenant A=${TENANT_A} (A1, A2) holds ${ALL_DEMO_SCOPES}; tenant B=${TENANT_B} (B1) holds ${DEFAULT_SCOPE}"
set_user_scopes A1_REFRESH "$TENANT_A" "$A2_USER" "${DEFAULT_SCOPE} ${BILLING_READ_SCOPE}"
expect_status 200 "$SET_SCOPES_STATUS" "A1 (tenant admin) cuts A2 to ${DEFAULT_SCOPE} ${BILLING_READ_SCOPE} via PATCH /tenant/users/{A2}"
# A2's next token reflects the cut (tokens are minted per ingress below too).
issue_token "$TENANT_A" "$A2_USER" A2

# What each user can narrow to (ADR-0025): the issuer refuses a scope the
# tenant is not entitled to, or the admin cut, with 400 invalid_scope.
narrow A1_REFRESH "$TENANT_A" "$DEFAULT_SCOPE" A1_CHAT; expect_status 200 "$NARROW_STATUS" "narrow A1 to ${DEFAULT_SCOPE}"
narrow A1_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A1_INVOKE; expect_status 200 "$NARROW_STATUS" "narrow A1 to ${BILLING_INVOKE_SCOPE}"
narrow A2_REFRESH "$TENANT_A" "$BILLING_READ_SCOPE" A2_READ; expect_status 200 "$NARROW_STATUS" "narrow A2 to ${BILLING_READ_SCOPE} (kept by the admin)"
narrow A2_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A2_INVOKE; expect_invalid_scope "narrow A2 to ${BILLING_INVOKE_SCOPE} (cut by the admin)"
narrow B1_REFRESH "$TENANT_B" "$BILLING_READ_SCOPE" B1_READ; expect_invalid_scope "narrow B1 to ${BILLING_READ_SCOPE} (tenant B is not entitled)"
narrow B1_REFRESH "$TENANT_B" "$DEFAULT_SCOPE" B1_CHAT; expect_status 200 "$NARROW_STATUS" "narrow B1 to ${DEFAULT_SCOPE}"
echo "scopes: A1 ${DEFAULT_SCOPE}/${BILLING_INVOKE_SCOPE} 200; A2 ${BILLING_READ_SCOPE} 200, ${BILLING_INVOKE_SCOPE} invalid_scope; B1 ${BILLING_READ_SCOPE} invalid_scope" >>"$RESULTS"

# --------------------------------------------------------------------------
# 2. Deploy the four stacks
# --------------------------------------------------------------------------
step 2 "synth and deploy ${STACK_PREFIX}-{$(printf '%s,' "${SUFFIXES[@]}" | sed 's/,$//')}"
rm -rf "$OUT"
npx cdk synth -q --app "npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.runtime.ts" --output "$OUT" >"${LIB_TMP}/synth.log" 2>&1 \
  || { tail -30 "${LIB_TMP}/synth.log" >&2; fail "synth"; }
DEPLOYED_SAMPLE=1
DEPLOY_START=$SECONDS
"${CDK[@]}" deploy --all --require-approval never --concurrency 4 --outputs-file "${LIB_TMP}/outputs.json" >"${LIB_TMP}/deploy.log" 2>&1 \
  || { grep -E "FAILED|Error|error" "${LIB_TMP}/deploy.log" | grep -v "^\s*$" | tail -30 >&2; fail "deploy"; }
echo "  deployed in $((SECONDS - DEPLOY_START))s"
for s in api-gateway agentcore-gateway; do
  table="$(output "$s" DemoTableName)"
  for t in "$TENANT_A" "$TENANT_B"; do
    aws dynamodb put-item --table-name "$table" --item "{\"PK\":{\"S\":\"TENANT#${t}\"},\"note\":{\"S\":\"integ item\"}}" >/dev/null
  done
done

# --------------------------------------------------------------------------
# 3..9 on both all-on stacks
# --------------------------------------------------------------------------
for INGRESS in api-gateway agentcore-gateway; do
  echo "---- ingress: $INGRESS"
  # Access tokens live 300s (tenant-identity). The api-gateway authoriser
  # caches its Allow per token for 300s (ADR-0015), so a token that expires
  # mid-run keeps being served there; the AgentCore Gateway re-validates the
  # token on every request and refuses an expired one. A full run outlives
  # 300s, so mint this iteration's tokens fresh here rather than reuse step
  # 1's (first integ 2026-10-28: the gateway 403'd a step-1 token by the time
  # its loop ran). Refresh tokens are long-lived, so the narrowed tokens come
  # from the refresh tokens.
  issue_token "$TENANT_A" "$A1_USER" A1
  issue_token "$TENANT_A" "$A2_USER" A2
  issue_token "$TENANT_B" "$B1_USER" B1
  narrow A1_REFRESH "$TENANT_A" "$DEFAULT_SCOPE" A1_CHAT; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A1 to ${DEFAULT_SCOPE}: HTTP ${NARROW_STATUS}"
  narrow A1_REFRESH "$TENANT_A" "$BILLING_READ_SCOPE" A1_READ; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A1 to ${BILLING_READ_SCOPE}: HTTP ${NARROW_STATUS}"
  narrow A1_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A1_INVOKE; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A1 to ${BILLING_INVOKE_SCOPE}: HTTP ${NARROW_STATUS}"
  narrow A2_REFRESH "$TENANT_A" "$BILLING_READ_SCOPE" A2_READ; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A2 to ${BILLING_READ_SCOPE}: HTTP ${NARROW_STATUS}"
  ENDPOINT="$(output "$INGRESS" EndpointUrl)"
  RUNTIME_ARN="$(output "$INGRESS" RuntimeArn)"
  TENANT_ROLE="$(output "$INGRESS" TenantRoleArn)"
  : "${ENDPOINT:?missing EndpointUrl output}" "${RUNTIME_ARN:?missing RuntimeArn output}" "${TENANT_ROLE:?missing TenantRoleArn output}"
  C1="integConversation${RUN}"

  step 3 "direct InvokeAgentRuntime with the runner's own credentials is denied (P-1)"
  if aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn "$RUNTIME_ARN" \
      --runtime-session-id "integ-direct-call-$(printf '%032d' "$RUN")" --payload '{"prompt":"report"}' \
      --cli-binary-format raw-in-base64-out "${LIB_TMP}/direct.out" >/dev/null 2>"${LIB_TMP}/direct.err"; then
    fail "the runner invoked the Runtime directly"
  fi
  grep -q AccessDenied "${LIB_TMP}/direct.err" || { head -c 300 "${LIB_TMP}/direct.err" >&2; fail "direct invoke failed, but not with AccessDenied"; }
  echo "  direct invoke -> AccessDeniedException"

  step 4b "A1 opens c1; A2 and B1 send c1 and A1's unit id in the session header: own units (P-2)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"; expect_status 200 "$status" "A1 report"
  A1_UNIT="$(report_field .unitId)"; A1_NONCE="$(report_field .nonce)"; A1_PREFIX="$(report_field .sessionPrefix)"
  [[ "$A1_UNIT" == "s-${A1_PREFIX}-${C1}" ]] || fail "A1's unit id is not s-<prefix>-<conversationId>"
  [[ "$(report_field .credentials)" == true ]] || fail "no vended credentials reached the agent (ADR-0018)"
  for who in A2 B1; do
    status="$(invoke "$ENDPOINT" "${who}_ACCESS" "$(body "$C1" report)" "$A1_UNIT")"; expect_status 200 "$status" "${who} report"
    [[ "$(report_field .unitId)" != "$A1_UNIT" ]] || fail "${who} landed in A1's unit"
    [[ "$(report_field .sessionPrefix)" != "$A1_PREFIX" ]] || fail "${who} got A1's session prefix"
    [[ "$(report_field .nonce)" != "$A1_NONCE" ]] || fail "${who} landed on A1's microVM"
    echo "  ${who}: prefix=$(report_field .sessionPrefix), own microVM"
  done

  step 5 "A1 resumes c1: same nonce"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"; expect_status 200 "$status" "A1 resume"
  [[ "$(report_field .nonce)" == "$A1_NONCE" ]] || fail "A1 resumed c1 on a different microVM"
  echo "  same microVM"

  step 6 "no token, tampered token, ID token, malformed conversationId: refused"
  status="$(invoke "$ENDPOINT" "" "$(body "$C1" report)")"; expect_status "401|403" "$status" "no token"
  TAMPERED="$(tamper A1_ACCESS)"
  status="$(invoke "$ENDPOINT" TAMPERED "$(body "$C1" report)")"; expect_status "401|403" "$status" "tampered signature"
  status="$(invoke "$ENDPOINT" A1_ID "$(body "$C1" report)")"; expect_status "401|403" "$status" "ID token"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "bad!" report)")"; expect_status "400|403" "$status" "malformed conversationId"

  step 7 "backend scopes (ADR-0025): a token narrowed to ${BILLING_READ_SCOPE} only is refused on the default backend"
  status="$(invoke "$ENDPOINT" A1_READ "$(body "$C1" report)")"; expect_status 403 "$status" "${BILLING_READ_SCOPE} only on the default backend"

  step 8 "forwarding on: the agent reports the forwarded token's scope"
  status="$(invoke "$ENDPOINT" A1_CHAT "$(body "$C1" report)")"; expect_status 200 "$status" "narrowed to ${DEFAULT_SCOPE}"
  [[ "$(report_field .forwardedToken)" == true ]] || fail "no user token reached the agent"
  [[ "$(report_field .forwardedScope)" == "$DEFAULT_SCOPE" ]] || fail "forwarded scope is $(report_field .forwardedScope)"
  [[ "$(report_field .forwardedTenant)" == "$TENANT_A" ]] || fail "forwarded tenant is not A"
  echo "  forwarded scope=${DEFAULT_SCOPE} tenant=A"

  step 8a "TVM: A1 reads tenant A (ok) and tenant B (denied); the runner cannot assume the tenant role"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" "read ${TENANT_A}")")"; expect_status 200 "$status" "read A"
  [[ "$(report_field .read.result)" == ok && "$(report_field .read.item.note)" == "integ item" ]] || fail "A1 could not read tenant A: $(report_field .read.error)"
  [[ "$(report_field '.callerArn')" == *"/tenant-${TENANT_A}"* || "$(report_field '.callerArn')" == *"${TENANT_A}"* ]] \
    || echo "  note: session name does not carry the tenant id ($(report_field '.callerArn | split("/") | .[2]'))"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" "read ${TENANT_B}")")"; expect_status 200 "$status" "read B"
  [[ "$(report_field .read.error)" == AccessDeniedException ]] || fail "A1 read tenant B: $(report_field .read)"
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(body "$C1" "read ${TENANT_A}")")"; expect_status 200 "$status" "B1 read A"
  [[ "$(report_field .read.error)" == AccessDeniedException ]] || fail "B1 read tenant A: $(report_field .read)"
  if aws sts assume-role --role-arn "$TENANT_ROLE" --role-session-name integ-negative >/dev/null 2>&1; then
    fail "the runner assumed the tenant role"
  fi
  echo "  A->A ok, A->B AccessDeniedException, B->A AccessDeniedException, runner AssumeRole denied"

  step 8b "cost attribution: a model prompt ends with event: usage (P-10, ADR-0018)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" 'In one sentence, what is tenant isolation?')")"; expect_status 200 "$status" "model prompt"
  [[ -z "$(error_event)" ]] || fail "model prompt: event: error $(error_event)"
  u="$(usage_json)"
  [[ -n "$u" ]] || fail "no usage event on the ${INGRESS} stream"
  jq -e '.inputTokens > 0 and .outputTokens > 0' <<<"$u" >/dev/null || fail "usage event without token counts: $u"
  echo "  usage: $u"
  echo "${INGRESS} usage event: $u" >>"$RESULTS"

  step 9 "latency probe: 20 'report' invocations, TTFB and total"
  : >"${LIB_TMP}/ttfb"; : >"${LIB_TMP}/total"
  for i in $(seq 1 20); do
    status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"
    [[ "$status" == 200 ]] || fail "latency probe call $i: HTTP $status"
    timing
    echo "$LAST_TTFB" >>"${LIB_TMP}/ttfb"; echo "$LAST_TOTAL" >>"${LIB_TMP}/total"
  done
  line="$(printf '%-18s TTFB p50=%ss p95=%ss  total p50=%ss p95=%ss' "$INGRESS" \
    "$(percentile 50 "${LIB_TMP}/ttfb")" "$(percentile 95 "${LIB_TMP}/ttfb")" \
    "$(percentile 50 "${LIB_TMP}/total")" "$(percentile 95 "${LIB_TMP}/total")")"
  echo "  $line"
  echo "latency $line" >>"$RESULTS"

  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" 'stream 10')")"; expect_status 200 "$status" "stream 10"; timing
  [[ "$(data_events)" -ge 6 && -n "$(usage_json)" ]] || fail "stream 10: $(data_events) data events"
  echo "  stream 10: $(data_events) data events, TTFB ${LAST_TTFB}s, total ${LAST_TOTAL}s"
  echo "${INGRESS} stream 10: TTFB ${LAST_TTFB}s total ${LAST_TOTAL}s" >>"$RESULTS"

  # ------------------------------------------------------------------------
  # 9-registry (ADR-0024, ADR-0025): two backends behind one ingress, each
  # owning its scopes
  # ------------------------------------------------------------------------
  step 9-registry "backend registry: billing scopes (any one admits), entitlement, unknown name, a backend added and drained after the deploy"
  # Each ingress publishes under its own registryPrefix (two ingresses in one
  # account collide on the default). The stack says which; the default is the
  # publisher's.
  REGISTRY_PREFIX="$(output "$INGRESS" RegistryPrefix)"
  [[ -n "$REGISTRY_PREFIX" ]] || REGISTRY_PREFIX="${PARAM_PREFIX}/"
  [[ "$REGISTRY_PREFIX" == */ ]] || REGISTRY_PREFIX="${REGISTRY_PREFIX}/"
  PUBLISHED_ENDPOINT="$(param "${REGISTRY_PREFIX}endpointUrl")" || fail "parameter ${REGISTRY_PREFIX}endpointUrl not found"
  BILLING_URL="$(backend_url "$PUBLISHED_ENDPOINT" billing)"
  BILLING_ENTRY="$(param "${REGISTRY_PREFIX}backends/billing")" || fail "registry entry ${REGISTRY_PREFIX}backends/billing not found"
  BILLING_RUNTIME_ARN="$(jq -r .runtimeArn <<<"$BILLING_ENTRY")"
  [[ "$BILLING_RUNTIME_ARN" == arn:*:bedrock-agentcore:*:runtime/* ]] || fail "backends/billing has no Runtime ARN"
  [[ "$BILLING_RUNTIME_ARN" != "$RUNTIME_ARN" ]] || fail "billing's registry entry names the default backend's Runtime"
  jq -e --arg r "$BILLING_READ_SCOPE" --arg i "$BILLING_INVOKE_SCOPE" '.status == "active" and (.scopes | index($r) != null) and (.scopes | index($i) != null) and (.requiredScopes == null)' <<<"$BILLING_ENTRY" >/dev/null \
    || fail "backends/billing is not active with scopes ${BILLING_READ_SCOPE} and ${BILLING_INVOKE_SCOPE} (the demo scopes must match src/demo.cdk.ts)"
  DEFAULT_ENTRY="$(param "${REGISTRY_PREFIX}backends/default")" || fail "registry entry ${REGISTRY_PREFIX}backends/default not found"
  jq -e --arg s "$DEFAULT_SCOPE" '.scopes == [$s]' <<<"$DEFAULT_ENTRY" >/dev/null || fail "backends/default does not own exactly ${DEFAULT_SCOPE}"
  echo "  registry prefix ${REGISTRY_PREFIX}: billing is active, its own Runtime, owns ${BILLING_READ_SCOPE} and ${BILLING_INVOKE_SCOPE}; default owns ${DEFAULT_SCOPE}"

  # (i-b) the catalogue holds the three scopes the two backends registered (ADR-0025)
  status="$(scope_catalogue_status)"; expect_status 200 "$status" "GET /platform/scopes"
  for s in $ALL_DEMO_SCOPES; do
    jq -e --arg s "$s" '.scopes | map(.name) | index($s) != null' "$BODY" >/dev/null || fail "scope ${s} is not in tenant-identity's catalogue (ScopeRegistration)"
  done
  jq -e '.scopes | map(select(.name | startswith("billing/"))) | all(.owner == "billing")' "$BODY" >/dev/null || fail "the billing scopes are not owned by billing in the catalogue"
  echo "  the catalogue lists ${ALL_DEMO_SCOPES}, owners default and billing"

  # (ii) any one of billing's scopes opens billing (OR); default/chat alone does not;
  # the entitlement is the issuer's: B cannot narrow to billing at all, A2 only to billing/read
  status="$(invoke "$ENDPOINT" A1_CHAT "$(body "$C1" report)")"; expect_status 200 "$status" "${DEFAULT_SCOPE} token on the default backend"
  status="$(invoke "$BILLING_URL" A1_CHAT "$(body "$C1" report)")"; expect_status 403 "$status" "${DEFAULT_SCOPE} token on billing"
  status="$(invoke "$BILLING_URL" A1_INVOKE "$(body "$C1" report)")"; expect_status 200 "$status" "A1 narrowed to ${BILLING_INVOKE_SCOPE} on billing"
  [[ "$(report_field .credentials)" == true ]] || fail "no vended credentials reached the billing backend"
  [[ "$(report_field .forwardedScope)" == "$BILLING_INVOKE_SCOPE" ]] || fail "billing saw forwarded scope $(report_field .forwardedScope)"
  BILLING_NONCE="$(report_field .nonce)"
  status="$(invoke "$BILLING_URL" A2_READ "$(body "$C1" report)")"; expect_status 200 "$status" "A2 (cut to ${BILLING_READ_SCOPE} by the tenant admin) on billing"
  [[ "$(report_field .forwardedScope)" == "$BILLING_READ_SCOPE" ]] || fail "billing saw forwarded scope $(report_field .forwardedScope) for A2"
  status="$(invoke "$ENDPOINT" A1_INVOKE "$(body "$C1" report)")"; expect_status 403 "$status" "${BILLING_INVOKE_SCOPE} token on the default backend"
  narrow B1_REFRESH "$TENANT_B" "$BILLING_READ_SCOPE" B1_READ; expect_invalid_scope "B1 narrowed to ${BILLING_READ_SCOPE} (tenant B holds ${DEFAULT_SCOPE} only)"
  narrow A2_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A2_INVOKE; expect_invalid_scope "A2 narrowed to ${BILLING_INVOKE_SCOPE} (cut by the admin)"
  # The same conversationId on two backends is two units: billing answered A1 from one microVM, the default backend from another.
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "$C1" report)")"; expect_status 200 "$status" "A1's un-narrowed token on the default backend"
  [[ "$(report_field .nonce)" != "$BILLING_NONCE" ]] || fail "the default backend and billing answered from the same microVM"
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(body "$C1" report)")"; expect_status 200 "$status" "A1's un-narrowed token (all three scopes) on billing"
  [[ "$(report_field .nonce)" == "$BILLING_NONCE" ]] || fail "billing did not resume A1's conversation on the same microVM"
  echo "  any one billing scope opens billing, default/chat does not; B and the cut A2 are refused by the issuer; two backends, two units"

  # (iii) an unknown backend name. On api-gateway the authoriser resolves the
  # name; its Deny surfaces as API Gateway's own 403, and a design that lets
  # the integration Lambda answer gives 404 instead. Either is a refusal
  # before the Runtime; which one is recorded, not asserted. The Gateway
  # refuses a target it does not have by itself, with its own status.
  status="$(invoke "$(backend_url "$PUBLISHED_ENDPOINT" nosuch)" A1_ACCESS "$(body "$C1" report)")"
  if [[ "$INGRESS" == api-gateway ]]; then
    expect_status "403|404" "$status" "unknown backend /nosuch"
  else
    [[ "$status" != 200 ]] || fail "unknown backend /nosuch: the Gateway served it"
    echo "  unknown backend /nosuch -> HTTP ${status} (the Gateway's own refusal)"
  fi
  echo "${INGRESS} registry: billing 403 default/chat, 200 billing/invoke (A1), 200 billing/read (A2); unknown backend HTTP ${status}" >>"$RESULTS"

  # (iv) a backend added by a registry write after the ingress deploy, then
  # drained. api-gateway only: on agentcore-gateway a backend is also a
  # Gateway target, which the registry alone cannot create. The entry points
  # `late` at billing's Runtime and names billing's scopes (an entry must
  # carry scopes, ADR-0025; `late/*` would be refused by the issuer), so the
  # billing/invoke token must reach it through the tag-conditioned grant
  # (ADR-0024) once the ingress's registry cache (registryTtl, 60 s) has
  # turned over. Each poll mints a
  # fresh token: the API Gateway authoriser caches its result per token (300
  # s, ADR-0015), so a Deny cached on the first poll, or an Allow cached
  # before the drain, would otherwise hide the change for longer than the
  # registry TTL. Agent B decides whether the cache key also carries the
  # path; a fresh token is correct under either choice.
  if [[ "$INGRESS" == api-gateway ]]; then
    LATE_PARAM="${REGISTRY_PREFIX}backends/late"
    LATE_URL="$(backend_url "$PUBLISHED_ENDPOINT" late)"
    LATE_PARAMS+=("$LATE_PARAM")
    LATE_SCOPES="$(scopes_json "$BILLING_INVOKE_SCOPE")"
    aws ssm put-parameter --name "$LATE_PARAM" --type String --overwrite \
      --value "$(registry_entry "$BILLING_RUNTIME_ARN" "$LATE_SCOPES" active)" >/dev/null
    deadline=$((SECONDS + 90)); served=""
    while [[ $SECONDS -lt $deadline ]]; do
      narrow A1_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A1_LATE; [[ "$NARROW_STATUS" == 200 ]] || fail "narrow A1 for the late probe: HTTP ${NARROW_STATUS}"
      status="$(invoke "$LATE_URL" A1_LATE "$(body "$C1" report)")"
      if [[ "$status" == 200 ]]; then served=$((SECONDS - deadline + 90)); break; fi
      [[ "$status" =~ ^(403|404)$ ]] || fail "late backend probe: HTTP ${status}"
      sleep 5
    done
    [[ -n "$served" ]] || fail "backends/late was not served within 90 s of the registry write"
    # Same Runtime, same claims, same conversationId: the same microVM as the
    # billing call above, which shows the entry's runtimeArn picked the Runtime.
    [[ "$(report_field .nonce)" == "$BILLING_NONCE" ]] || fail "late backend did not answer from billing's Runtime (nonce differs)"
    echo "  /late served ${served}s after the registry write, on billing's microVM, with no ingress deploy"
    aws ssm put-parameter --name "$LATE_PARAM" --type String --overwrite \
      --value "$(registry_entry "$BILLING_RUNTIME_ARN" "$LATE_SCOPES" draining)" >/dev/null
    deadline=$((SECONDS + 90)); drained=""
    while [[ $SECONDS -lt $deadline ]]; do
      narrow A1_REFRESH "$TENANT_A" "$BILLING_INVOKE_SCOPE" A1_LATE; [[ "$NARROW_STATUS" == 200 ]] || fail "narrow A1 for the drain probe: HTTP ${NARROW_STATUS}"
      status="$(invoke "$LATE_URL" A1_LATE "$(body "$C1" report)")"
      if [[ "$status" =~ ^(403|404)$ ]]; then drained=$((SECONDS - deadline + 90)); break; fi
      [[ "$status" == 200 ]] || fail "draining backend probe: HTTP ${status}"
      sleep 5
    done
    [[ -n "$drained" ]] || fail "backends/late still served 90 s after status draining"
    echo "  /late refused with HTTP ${status} ${drained}s after status draining"
    aws ssm delete-parameter --name "$LATE_PARAM" >/dev/null
    LATE_PARAMS=()
    echo "${INGRESS} registry: late backend served after ${served}s, drained after ${drained}s (HTTP ${status})" >>"$RESULTS"
  else
    echo "  add-and-drain not run on ${INGRESS}: a backend there is also a Gateway target"
  fi
done

# --------------------------------------------------------------------------
# 4a. session off (and the default model-only tenant role, ADR-0018)
# --------------------------------------------------------------------------
echo "---- stack: session-off"
ENDPOINT="$(output session-off EndpointUrl)"
step 4a "session off: conversationId in the body is 400; two requests land in two units"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"; expect_status 400 "$status" "conversationId with session off"
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"report"}')"; expect_status 200 "$status" "first request"
U1="$(report_field .unitId)"; N1="$(report_field .nonce)"
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"report"}' "$U1")"; expect_status 200 "$status" "second request with the first's unit id in the header"
[[ "$(report_field .unitId)" != "$U1" ]] || fail "session off: the second request reused the first unit"
[[ "$(report_field .nonce)" != "$N1" ]] || fail "session off: the second request reached the first microVM"
[[ "$(report_field .forwardedToken)" == false ]] || fail "session-off stack forwarded the user token"
echo "  two units, two microVMs"
step 4a-model "default TenantModelRole: a model prompt is signed by a tenant-tagged role (ADR-0018)"
status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"Say hello in three words."}')"; expect_status 200 "$status" "model prompt"
[[ -z "$(error_event)" && -n "$(usage_json)" ]] || fail "default role model prompt: $(error_event)"
echo "  usage: $(usage_json)"

# --------------------------------------------------------------------------
# 8. requireNarrowedToken
# --------------------------------------------------------------------------
echo "---- stack: narrowed"
ENDPOINT="$(output narrowed EndpointUrl)"
step 8-narrowed "requireNarrowedToken: un-narrowed refused, narrowed accepted"
narrow A1_REFRESH "$TENANT_A" "$DEFAULT_SCOPE" A1_CHAT; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A1 to ${DEFAULT_SCOPE}: HTTP ${NARROW_STATUS}"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"; expect_status 403 "$status" "un-narrowed token"
status="$(invoke "$ENDPOINT" A1_CHAT "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "narrowed token"
[[ "$(report_field .forwardedScope)" == "$DEFAULT_SCOPE" ]] || fail "narrowed: forwarded scope $(report_field .forwardedScope)"

step floor "ingress-wide floor ${DEFAULT_SCOPE} (AND, ADR-0005) plus the backend's own scopes (OR, ADR-0025) on the narrowed stack"
NARROWED_BILLING_URL="$(backend_url "$ENDPOINT" billing)"
status="$(invoke "$NARROWED_BILLING_URL" A1_CHAT "$(body "integConversation${RUN}" report)")"; expect_status 403 "$status" "floor-only token on billing"
narrow A1_REFRESH "$TENANT_A" "$BILLING_READ_SCOPE" A1_READ; [[ "$NARROW_STATUS" == 200 ]] || fail "re-narrow A1 to ${BILLING_READ_SCOPE}: HTTP ${NARROW_STATUS}"
status="$(invoke "$NARROWED_BILLING_URL" A1_READ "$(body "integConversation${RUN}" report)")"; expect_status 403 "$status" "${BILLING_READ_SCOPE} without the floor on billing"
narrow A1_REFRESH "$TENANT_A" "${DEFAULT_SCOPE} ${BILLING_READ_SCOPE}" A1_FLOOR_READ; [[ "$NARROW_STATUS" == 200 ]] || fail "narrow A1 to the floor plus ${BILLING_READ_SCOPE}: HTTP ${NARROW_STATUS}"
status="$(invoke "$NARROWED_BILLING_URL" A1_FLOOR_READ "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "floor plus ${BILLING_READ_SCOPE} on billing"
status="$(invoke "$ENDPOINT" A1_FLOOR_READ "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "floor plus ${BILLING_READ_SCOPE} on the default backend"
echo "narrowed stack floor: 403 floor-only on billing, 403 billing/read without the floor, 200 with both" >>"$RESULTS"

step limits "per-tenant limit, 5 requests/min (ADR-0020): tenant A is limited, tenant B is not"
narrow B1_REFRESH "$TENANT_B" "$DEFAULT_SCOPE" B1_CHAT; status="$NARROW_STATUS"; expect_status 200 "$status" "narrow B1 to ${DEFAULT_SCOPE}"
limited=0
for i in $(seq 1 12); do
  status="$(invoke "$ENDPOINT" A1_CHAT "$(body "integConversation${RUN}" report)")"
  if [[ "$status" == 429 ]]; then limited=$i; break; fi
  [[ "$status" == 200 ]] || fail "limit probe call $i: HTTP $status"
done
[[ "$limited" -gt 0 ]] || fail "tenant A was never limited in 12 calls"
[[ "$(cat "$BODY")" == "too many requests" ]] || fail "429 body is not the fixed text"
echo "  tenant A: 429 on call ${limited}"
status="$(invoke "$ENDPOINT" B1_CHAT "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "tenant B while A is limited"
echo "limits narrowed stack: tenant A 429 on call ${limited}, tenant B 200" >>"$RESULTS"

# --------------------------------------------------------------------------
# 8b (metrics). The EMF records reach CloudWatch metrics within minutes.
# --------------------------------------------------------------------------
step 8b-metrics "RuntimeIsolation ModelOutputTokens and BackendInvokeSeconds for tenant A on api-gateway"
found=0
for _ in $(seq 1 20); do
  sum="$(aws cloudwatch get-metric-statistics --namespace RuntimeIsolation --metric-name ModelOutputTokens \
    --dimensions Name=TenantId,Value="$TENANT_A" Name=Ingress,Value=api-gateway --statistics Sum --period 3600 \
    --start-time "$STARTED" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null || echo 0)"
  if [[ "$sum" != None && "$sum" != 0 && "$sum" != 0.0 ]]; then found=1; break; fi
  sleep 15
done
[[ "$found" == 1 ]] || fail "no ModelOutputTokens datapoint for tenant A after 5 minutes"
secs="$(aws cloudwatch get-metric-statistics --namespace RuntimeIsolation --metric-name BackendInvokeSeconds \
  --dimensions Name=TenantId,Value="$TENANT_A" Name=Ingress,Value=api-gateway --statistics Sum --period 3600 \
  --start-time "$STARTED" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --query 'sum(Datapoints[].Sum)' --output text)"
echo "  tenant A on api-gateway: ModelOutputTokens=${sum} BackendInvokeSeconds=${secs}"
echo "metrics tenant A api-gateway: ModelOutputTokens=${sum} BackendInvokeSeconds=${secs}" >>"$RESULTS"
left="$(aws cloudwatch list-metrics --namespace RuntimeIsolation --metric-name Requests \
  --dimensions Name=TenantId,Value="$TENANT_A" Name=Ingress,Value=agentcore-gateway --query 'length(Metrics)' --output text)"
[[ "$left" == 0 ]] || fail "agentcore-gateway stack emitted per-tenant metrics with perTenantMetrics off (ADR-0021)"
echo "  agentcore-gateway (perTenantMetrics off): no per-tenant metrics"

# --------------------------------------------------------------------------
# The demo, against the stack that published the parameters
# --------------------------------------------------------------------------
step demo "scripts/demo.sh against ${STACK_PREFIX}-api-gateway"
"${SAMPLE_DIR}/scripts/demo.sh" >"${LIB_TMP}/demo.log" 2>&1 || { tail -30 "${LIB_TMP}/demo.log" >&2; fail "demo.sh"; }
echo "  demo.sh passed"

echo "== steps complete in $((SECONDS))s"
