#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo (docs/sample-standard.md §7.6) against a deployed
# runtime-isolation stack and a deployed tenant-identity shared-pool.
#
#   AWS_REGION=eu-central-1 scripts/demo.sh
#
# Reads the endpoint and ingress from this sample's published parameters
# (/application-plane/shared/agent-runtime/*) and the identity provider from
# tenant-identity's (/application-plane/shared/identity/*). Deploy the demo
# with every module on for the full walk:
#
#   npx cdk deploy --context ingress=api-gateway --context session=user \
#     --context requiredScopes=tenant-api/read --context forwardUserToken=true --context tvm=true
#
# Walks: two tenants and three users; the session follows the token, not the
# request; resume; refusals; the forwarded scope; a cross-tenant read refused
# by IAM; streaming; and per-tenant cost (the usage event and the metric).
# Steps whose module is off are skipped with a note. Creates two tenants and
# deletes them on exit, also on failure. Conventions: scripts/CONVENTIONS.md.
#
# Needs: bash, aws (v2), curl >= 7.75 (--aws-sigv4), jq. The AWS credentials
# need execute-api:Invoke on tenant-identity's platform API, ssm:GetParameter,
# dynamodb:PutItem/DeleteItem on the demo table and cloudwatch:GetMetricStatistics.

set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
: "${REGION:?Set AWS_REGION to the Region the stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_TMP="$(mktemp -d)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ENDPOINT="$(param "${PARAM_PREFIX}/endpointUrl")" || fail "parameter ${PARAM_PREFIX}/endpointUrl not found; deploy this sample first"
INGRESS="$(param "${PARAM_PREFIX}/ingress")"
RUNTIME_ARN="$(param "${PARAM_PREFIX}/runtimeArn")"
identity_init

# The stack that published the parameters, for the optional table and for module discovery.
STACK="$(aws cloudformation describe-stack-resources --physical-resource-id "${PARAM_PREFIX}/ingress" \
  --query 'StackResources[0].StackName' --output text 2>/dev/null || true)"
TABLE=""
if [[ -n "$STACK" && "$STACK" != None ]]; then
  TABLE="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='DemoTableName'].OutputValue" --output text)"
  [[ "$TABLE" == None ]] && TABLE=""
fi
echo "ingress=${INGRESS} stack=${STACK:-unknown} (endpoint and identifiers resolved from SSM; not printed)"

RUN="$(date +%s)"
SEEDED=()
cleanup() {
  local code=$?
  set +e
  for key in "${SEEDED[@]:-}"; do
    [[ -n "$key" ]] && aws dynamodb delete-item --table-name "$TABLE" --key "{\"PK\":{\"S\":\"${key}\"}}" >/dev/null 2>&1
  done
  delete_tenants
  [[ "$code" -eq 0 ]] || echo "demo: FAILED (tenants and seeded items removed)" >&2
  rm -rf "$LIB_TMP"
  exit "$code"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
C1="demoConversation${RUN}"

step "1. Two tenants and three users (tenant-identity shared-pool, platform API)"
create_tenant "rtiso-demo-a-${RUN}"; TENANT_A="$TENANT_ID"; issue_token "$TENANT_A" "$ADMIN_USERNAME" A1
create_user "$TENANT_A" "rtiso-demo-a2-${RUN}"; issue_token "$TENANT_A" "$USERNAME" A2
create_tenant "rtiso-demo-b-${RUN}"; TENANT_B="$TENANT_ID"; issue_token "$TENANT_B" "$ADMIN_USERNAME" B1
echo "tenant A=${TENANT_A} (users A1, A2), tenant B=${TENANT_B} (user B1)"

step "2. A1 opens conversation c1; the agent reports its session prefix and microVM nonce"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(jq -nc --arg c "$C1" '{conversationId: $c, prompt: "report"}')")"
if [[ "$status" == 400 ]]; then
  SESSION=off
  echo "  the session module is off on this deployment: conversationId is refused (HTTP 400); re-asking without it"
  status="$(invoke "$ENDPOINT" A1_ACCESS '{"prompt":"report"}')"
else
  SESSION=on
fi
expect_status 200 "$status" "A1 report"
A1_UNIT="$(report_field .unitId)"; A1_NONCE="$(report_field .nonce)"
echo "  A1: prefix=$(report_field .sessionPrefix) nonce=${A1_NONCE}"
FORWARDED="$(report_field .forwardedToken)"

with_c1() { if [[ "$SESSION" == on ]]; then jq -nc --arg c "$C1" --arg p "$1" '{conversationId: $c, prompt: $p}'; else jq -nc --arg p "$1" '{prompt: $p}'; fi; }

step "3. A2 and B1 send the same conversationId and A1's unit id in the session header"
for who in A2 B1; do
  status="$(invoke "$ENDPOINT" "${who}_ACCESS" "$(with_c1 report)" "$A1_UNIT")"
  expect_status 200 "$status" "${who} report"
  unit="$(report_field .unitId)"
  [[ "$unit" != "$A1_UNIT" ]] || fail "${who} landed in A1's unit"
  echo "  ${who}: prefix=$(report_field .sessionPrefix) nonce=$(report_field .nonce) (own unit: the header was overwritten)"
done

step "4. A1 resumes c1"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 report)")"
expect_status 200 "$status" "A1 resume"
if [[ "$SESSION" == on ]]; then
  [[ "$(report_field .nonce)" == "$A1_NONCE" ]] || fail "A1 resumed c1 on a different microVM"
  echo "  same unit, same nonce: the conversation stays on A1's microVM"
else
  echo "  session off: a new unit per request (nonce=$(report_field .nonce))"
fi

step "5. Refusals: no token, a tampered token, an ID token"
status="$(invoke "$ENDPOINT" "" "$(with_c1 report)")"
expect_status "401|403" "$status" "no Authorization header"
TAMPERED="$(tamper A1_ACCESS)"
status="$(invoke "$ENDPOINT" TAMPERED "$(with_c1 report)")"
expect_status "401|403" "$status" "tampered signature"
status="$(invoke "$ENDPOINT" A1_ID "$(with_c1 report)")"
expect_status "401|403" "$status" "ID token instead of an access token"

step "6. Delegation: the scope the agent received"
if [[ "$FORWARDED" == true ]]; then
  narrow A1_REFRESH "$TENANT_A" tenant-api/read A1_READ; status="$NARROW_STATUS"
  expect_status 200 "$status" "narrow A1 to tenant-api/read"
  status="$(invoke "$ENDPOINT" A1_READ "$(with_c1 report)")"
  expect_status "200|403" "$status" "A1 with the narrowed token"
  [[ "$status" == 200 ]] && echo "  forwarded scope: $(report_field .forwardedScope)"
else
  echo "  forwardUserToken is off on this deployment: skipped"
fi

step "7. TVM: A1 reads tenant A's item, then tenant B's (IAM decides, P-8)"
if [[ -n "$TABLE" ]]; then
  for t in "$TENANT_A" "$TENANT_B"; do
    aws dynamodb put-item --table-name "$TABLE" \
      --item "{\"PK\":{\"S\":\"TENANT#${t}\"},\"note\":{\"S\":\"demo item for ${t}\"}}" >/dev/null
    SEEDED+=("TENANT#${t}")
  done
  for t in "$TENANT_A" "$TENANT_B"; do
    status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 "read ${t}")")"
    expect_status 200 "$status" "A1 read ${t}"
    echo "  read ${t}: $(report_field '.read | if .result == "ok" then "ok" else "error " + .error end')"
  done
  echo "  agent ran as: $(report_field '.callerArn | split("/") | .[1:] | join("/")')"
else
  echo "  no demo table on this deployment (deploy with --context tvm=true): skipped"
fi

step "8. Streaming: 'stream 10' arrives as text/event-stream"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 'stream 10')")"
expect_status 200 "$status" "A1 stream 10"
timing
echo "  $(data_events) data events, first byte after ${LAST_TTFB}s, done after ${LAST_TOTAL}s"

step "9. Cost per tenant: a model prompt ends with the usage event (P-10, ADR-0018)"
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 'In one sentence, what is tenant isolation?')")"
expect_status 200 "$status" "A1 model prompt"
if [[ -n "$(error_event)" ]]; then
  fail "the model call returned event: error $(error_event)"
fi
echo "  answer: $(grep '^data: ' "$BODY" | sed 's/^data: //' | jq -rj 'select(.text) | .text' | head -c 300)"
echo "  usage event: $(usage_json)"
if [[ "$INGRESS" == api-gateway ]]; then
  echo "  the ingress meters it per tenant; the RuntimeIsolation metrics land within a few minutes:"
  echo "  aws cloudwatch get-metric-statistics --namespace RuntimeIsolation --metric-name ModelOutputTokens \\"
  echo "    --dimensions Name=TenantId,Value=${TENANT_A} Name=Ingress,Value=${INGRESS} --statistics Sum --period 300 \\"
  echo "    --start-time \$(date -u -d '-30 min' +%FT%TZ) --end-time \$(date -u +%FT%TZ)"
else
  echo "  the agentcore-gateway ingress meters requests only (ADR-0017); the model call is billed to the tenant role in CUR 2.0"
fi
echo "  in CUR 2.0 the Bedrock line items carry iamPrincipal/TenantId=${TENANT_A} (ADR-0018)"

step "Demo complete (runtime ${RUNTIME_ARN##*/})"
