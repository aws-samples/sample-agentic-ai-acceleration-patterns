#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §8, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# Flow:
#   1. tenant-identity (shared-pool): reuse a published deployment, else
#      deploy it through its own path and destroy it at the end (ADR-0004,
#      tenant-identity ADR-0017). Create tenants A and B, users A1, A2, B1.
#   2. Synthesise test/integ.runtime.ts and deploy its four stacks at once.
#   3..9 on both all-on stacks (api-gateway, agentcore-gateway).
#   9-registry (ADR-0024) on both: the second backend `billing` and its scope,
#      an unknown backend name; on api-gateway also a backend added and
#      drained through a registry write after the deploy.
#   4a on the session-off stack (also a model call on the default role).
#   8 (narrowed) and the per-tenant limit (ADR-0020) on the narrowed stack.
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

# The scope the demo's second backend `billing` requires on top of the
# ingress floor (ADR-0024). MUST match BILLING_SCOPE exported by
# src/demo.cdk.ts. tenant-identity shared-pool issues only tenant-api/read
# and tenant-api/write, and the floor is tenant-api/read, so write is the
# only scope the identity provider can narrow a token to for this check.
BILLING_SCOPE="tenant-api/write"
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
      aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-${s}" \
        --query "Stacks[0].Outputs[?OutputKey=='RuntimeArn'].OutputValue" --output text 2>/dev/null | sed 's#.*/##' >>"$runtimes"
    done
    "${CDK[@]}" destroy --all --force --concurrency 4 >"${LIB_TMP}/destroy.log" 2>&1 \
      || { echo "destroy failed: ${STACK_PREFIX} stacks (see cdk output above)" >&2; tail -20 "${LIB_TMP}/destroy.log" >&2; FAILED=1; }
    # The Runtime writes its own log groups outside CloudFormation.
    while read -r rt; do
      [[ -n "$rt" && "$rt" != None ]] || continue
      for g in $(aws logs describe-log-groups --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/${rt}" \
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

# backend_url ENDPOINT_URL NAME -> the URL of one backend's route (ADR-0024).
# Tolerates either shape of the published endpointUrl: the ingress base
# (https://<api>/prod) or the default backend's full URL
# (https://<api>/prod/invocations, https://<gw>/agent/invocations).
backend_url() {
  local base="${1%/}"
  base="${base%/invocations}"; base="${base%/agent}"
  echo "${base}/$2/invocations"
}

# registry_entry RUNTIME_ARN SCOPES_JSON STATUS -> the entry JSON (src/shared/registry.ts schema).
registry_entry() { jq -nc --arg a "$1" --argjson s "$2" --arg st "$3" '{runtimeArn: $a, requiredScopes: $s, status: $st}'; }

# --------------------------------------------------------------------------
# 1. tenant-identity (shared-pool), reused or deployed
# --------------------------------------------------------------------------
step 1 "tenant-identity shared-pool"
if aws ssm get-parameter --name "${IDENTITY_PREFIX}/apiUrl" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "  reusing the published tenant-identity deployment"
else
  echo "  deploying ${IDENTITY_STACK} through its own path (projen build, cdk deploy)"
  DEPLOYED_IDENTITY=1
  (cd "$IDENTITY_DIR" && npx projen build >"${LIB_TMP}/identity-build.log" 2>&1 \
    && npx cdk deploy "$IDENTITY_STACK" --context topology=shared-pool --require-approval never >"${LIB_TMP}/identity-deploy.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-deploy.log" "${LIB_TMP}/identity-build.log" >&2 2>/dev/null; fail "deploy ${IDENTITY_STACK}"; }
fi
identity_init
create_tenant "rtiso-integ-a-${RUN}"; TENANT_A="$TENANT_ID"; issue_token "$TENANT_A" "$ADMIN_USERNAME" A1
create_user "$TENANT_A" "rtiso-integ-a2-${RUN}"; issue_token "$TENANT_A" "$USERNAME" A2
create_tenant "rtiso-integ-b-${RUN}"; TENANT_B="$TENANT_ID"; issue_token "$TENANT_B" "$ADMIN_USERNAME" B1
echo "  tenant A=${TENANT_A} (A1, A2), tenant B=${TENANT_B} (B1)"
narrow A1_REFRESH "$TENANT_A" tenant-api/read A1_READ; status="$NARROW_STATUS"; expect_status 200 "$status" "narrow A1 to tenant-api/read"
narrow A1_REFRESH "$TENANT_A" tenant-api/write A1_WRITE; status="$NARROW_STATUS"; expect_status 200 "$status" "narrow A1 to tenant-api/write"

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

  step 7 "requiredScopes: a token narrowed to tenant-api/write only is refused"
  status="$(invoke "$ENDPOINT" A1_WRITE "$(body "$C1" report)")"; expect_status 403 "$status" "tenant-api/write only"

  step 8 "forwarding on: the agent reports the forwarded token's scope"
  status="$(invoke "$ENDPOINT" A1_READ "$(body "$C1" report)")"; expect_status 200 "$status" "narrowed to tenant-api/read"
  [[ "$(report_field .forwardedToken)" == true ]] || fail "no user token reached the agent"
  [[ "$(report_field .forwardedScope)" == tenant-api/read ]] || fail "forwarded scope is $(report_field .forwardedScope)"
  [[ "$(report_field .forwardedTenant)" == "$TENANT_A" ]] || fail "forwarded tenant is not A"
  echo "  forwarded scope=tenant-api/read tenant=A"

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
  # 9-registry (ADR-0024): two backends behind one ingress
  # ------------------------------------------------------------------------
  step 9-registry "backend registry: billing scope, unknown name, a backend added and drained after the deploy"
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
  jq -e --arg s "$BILLING_SCOPE" '.status == "active" and (.requiredScopes | index($s) != null)' <<<"$BILLING_ENTRY" >/dev/null \
    || fail "backends/billing is not active with requiredScopes containing ${BILLING_SCOPE} (BILLING_SCOPE must match src/demo.cdk.ts)"
  echo "  registry prefix ${REGISTRY_PREFIX}: billing is active, its own Runtime, requires ${BILLING_SCOPE}"

  # (ii) the floor-scope token reaches the default backend only; the billing scope opens billing
  status="$(invoke "$ENDPOINT" A1_READ "$(body "$C1" report)")"; expect_status 200 "$status" "floor-scope token on the default backend"
  status="$(invoke "$BILLING_URL" A1_READ "$(body "$C1" report)")"; expect_status 403 "$status" "floor-scope token on billing"
  narrow A1_REFRESH "$TENANT_A" "tenant-api/read ${BILLING_SCOPE}" A1_BILLING; status="$NARROW_STATUS"; expect_status 200 "$status" "narrow A1 to the floor plus ${BILLING_SCOPE}"
  status="$(invoke "$BILLING_URL" A1_BILLING "$(body "$C1" report)")"; expect_status 200 "$status" "billing-scope token on billing"
  [[ "$(report_field .credentials)" == true ]] || fail "no vended credentials reached the billing backend"
  BILLING_NONCE="$(report_field .nonce)"
  status="$(invoke "$ENDPOINT" A1_BILLING "$(body "$C1" report)")"; expect_status 200 "$status" "billing-scope token on the default backend"
  [[ "$(report_field .nonce)" != "$BILLING_NONCE" ]] || fail "the default backend and billing answered from the same microVM"
  echo "  the same conversationId on two backends is two units"

  # (iii) an unknown backend name. On api-gateway the authoriser resolves the
  # name; its Deny surfaces as API Gateway's own 403, and a design that lets
  # the integration Lambda answer gives 404 instead. Either is a refusal
  # before the Runtime; which one is recorded, not asserted. The Gateway
  # refuses a target it does not have by itself, with its own status.
  status="$(invoke "$(backend_url "$PUBLISHED_ENDPOINT" nosuch)" A1_BILLING "$(body "$C1" report)")"
  if [[ "$INGRESS" == api-gateway ]]; then
    expect_status "403|404" "$status" "unknown backend /nosuch"
  else
    [[ "$status" != 200 ]] || fail "unknown backend /nosuch: the Gateway served it"
    echo "  unknown backend /nosuch -> HTTP ${status} (the Gateway's own refusal)"
  fi
  echo "${INGRESS} registry: billing 403 floor/200 scoped, unknown backend HTTP ${status}" >>"$RESULTS"

  # (iv) a backend added by a registry write after the ingress deploy, then
  # drained. api-gateway only: on agentcore-gateway a backend is also a
  # Gateway target, which the registry alone cannot create. The entry points
  # `late` at billing's Runtime with no extra scopes, so the floor token must
  # reach it through the tag-conditioned grant (ADR-0024) once the ingress's
  # registry cache (registryTtl, 60 s) has turned over. Each poll mints a
  # fresh token: the API Gateway authoriser caches its result per token (300
  # s, ADR-0015), so a Deny cached on the first poll, or an Allow cached
  # before the drain, would otherwise hide the change for longer than the
  # registry TTL. Agent B decides whether the cache key also carries the
  # path; a fresh token is correct under either choice.
  if [[ "$INGRESS" == api-gateway ]]; then
    LATE_PARAM="${REGISTRY_PREFIX}backends/late"
    LATE_URL="$(backend_url "$PUBLISHED_ENDPOINT" late)"
    LATE_PARAMS+=("$LATE_PARAM")
    aws ssm put-parameter --name "$LATE_PARAM" --type String --overwrite \
      --value "$(registry_entry "$BILLING_RUNTIME_ARN" '[]' active)" >/dev/null
    deadline=$((SECONDS + 90)); served=""
    while [[ $SECONDS -lt $deadline ]]; do
      narrow A1_REFRESH "$TENANT_A" tenant-api/read A1_LATE; [[ "$NARROW_STATUS" == 200 ]] || fail "narrow A1 for the late probe: HTTP ${NARROW_STATUS}"
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
      --value "$(registry_entry "$BILLING_RUNTIME_ARN" '[]' draining)" >/dev/null
    deadline=$((SECONDS + 90)); drained=""
    while [[ $SECONDS -lt $deadline ]]; do
      narrow A1_REFRESH "$TENANT_A" tenant-api/read A1_LATE; [[ "$NARROW_STATUS" == 200 ]] || fail "narrow A1 for the drain probe: HTTP ${NARROW_STATUS}"
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
status="$(invoke "$ENDPOINT" A1_ACCESS "$(body "integConversation${RUN}" report)")"; expect_status 403 "$status" "un-narrowed token"
status="$(invoke "$ENDPOINT" A1_READ "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "narrowed token"
[[ "$(report_field .forwardedScope)" == tenant-api/read ]] || fail "narrowed: forwarded scope $(report_field .forwardedScope)"

step limits "per-tenant limit, 5 requests/min (ADR-0020): tenant A is limited, tenant B is not"
narrow B1_REFRESH "$TENANT_B" tenant-api/read B1_READ; status="$NARROW_STATUS"; expect_status 200 "$status" "narrow B1 to tenant-api/read"
limited=0
for i in $(seq 1 12); do
  status="$(invoke "$ENDPOINT" A1_READ "$(body "integConversation${RUN}" report)")"
  if [[ "$status" == 429 ]]; then limited=$i; break; fi
  [[ "$status" == 200 ]] || fail "limit probe call $i: HTTP $status"
done
[[ "$limited" -gt 0 ]] || fail "tenant A was never limited in 12 calls"
[[ "$(cat "$BODY")" == "too many requests" ]] || fail "429 body is not the fixed text"
echo "  tenant A: 429 on call ${limited}"
status="$(invoke "$ENDPOINT" B1_READ "$(body "integConversation${RUN}" report)")"; expect_status 200 "$status" "tenant B while A is limited"
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
