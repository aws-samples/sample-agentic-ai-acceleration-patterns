#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo (docs/sample-standard.md §7.6) against a deployed
# RuntimeIsolation-<ingress> stack and a published tenant-identity shared-pool.
#
#   AWS_REGION=eu-central-1 scripts/demo.sh
#
# Reads the ingress's one published document (/application-plane/shared/
# agent-runtime/ingress, ADR-0042), the stack's outputs, and tenant-identity's
# parameters (/application-plane/shared/identity/*). Deploy the demo with every
# module on for the full walk (README, "Build and deploy the demo"):
#
#   npx cdk deploy --context ingress=api-gateway --context session=tenant \
#     --context tvm=true --context billingBackend=true --context requiredScopes=app/use
#
# The vendor scopes app/use and entitlements/admin must be registered in
# tenant-identity's scope catalogue (README, Deploy, Prerequisites).
#
# Walks: tenants, a plan, subscriptions and a cut written through the
# Entitlements API; the transaction token the agent receives instead of the
# identity token; the session follows the token; resume; refusals; the grant
# A.needs ∪ (A.tools ∩ T.tools ∩ U.tools) per caller; the tools gateways; tool
# data isolation; change lag; streaming; per-tenant cost. A step whose module
# is off is skipped with a note.
#
# Creates two tenants (A with app/use and entitlements/admin, B with app/use),
# users A1 and A2 in A, the plan demo-standard and two subscriptions, and demo
# table items; deletes all of them on exit, also on failure. Prints statuses,
# ids and timings, never a token, credential or header value.
# Conventions: scripts/CONVENTIONS.md.
#
# Needs: bash, aws (AWS CLI v2), curl >= 7.75 (--aws-sigv4), jq, base64. The AWS
# credentials need execute-api:Invoke on tenant-identity's platform API and on
# the Entitlements API, ssm:GetParameter, cloudformation:DescribeStacks and
# DescribeStackResources, and dynamodb:PutItem/DeleteItem on the demo table.

# Token variables are passed to the helpers by NAME and read there as ${!name}.
# shellcheck disable=SC2034

set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
: "${REGION:?Set AWS_REGION to the Region the stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_TMP="$(mktemp -d)"
PLAN="demo-standard"
TABLE=""
ENT_API=""
SEEDED=()
SUBSCRIBED=()
PLAN_WRITTEN=0

# Deletes what this run wrote, in dependency order: the subscriptions (each
# delete also removes the tenant's cuts), then the plan (409 while a tenant
# names it), the demo items, the tenants.
cleanup() {
  local code=$? t key st
  set +e
  if declare -F vendor >/dev/null && [[ -n "$ENT_API" ]]; then
    for t in "${SUBSCRIBED[@]:-}"; do
      [[ -n "$t" ]] || continue
      st="$(vendor DELETE "tenants/${t}")"
      [[ "$st" =~ ^20[04]$ ]] || echo "cleanup: DeleteTenantSubscription ${t}: HTTP ${st}" >&2
    done
    if [[ "$PLAN_WRITTEN" == 1 ]]; then
      st="$(vendor DELETE "plans/${PLAN}")"
      [[ "$st" =~ ^20[04]$ ]] || echo "cleanup: DeletePlan ${PLAN}: HTTP ${st}" >&2
    fi
  fi
  if [[ -n "$TABLE" ]]; then
    for key in "${SEEDED[@]:-}"; do
      [[ -n "$key" ]] && aws dynamodb delete-item --table-name "$TABLE" --key "{\"PK\":{\"S\":\"${key}\"}}" >/dev/null 2>&1
    done
  fi
  declare -F delete_tenants >/dev/null && delete_tenants
  [[ "$code" -eq 0 ]] || echo "demo: FAILED (tenants, subscriptions, plan and demo items removed)" >&2
  rm -rf "$LIB_TMP"
  exit "$code"
}
trap cleanup EXIT
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# invoke_with_headers: invoke (lib.sh) that also keeps the response headers, for content_type.
HEADERS="${LIB_TMP}/headers"
invoke_with_headers() {
  local endpoint="$1" token_var="$2" json="$3" config="" out status ttfb total
  [[ -n "$token_var" ]] && config="header = \"Authorization: Bearer ${!token_var}\""
  printf '%s' "$json" >"$REQ"
  : >"$HEADERS"; chmod 600 "$HEADERS"
  out="$(curl -s -N --max-time 180 -D "$HEADERS" -o "$BODY" -w '%{http_code} %{time_starttransfer} %{time_total}' -X POST "$endpoint" \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' --data-binary "@$REQ" --config - <<<"$config")"
  read -r status ttfb total <<<"$out"
  printf '%s %s\n' "$ttfb" "$total" >"${LIB_TMP}/timing"
  echo "$status"
}
# content_type: the media type of the last invoke_with_headers response, without parameters.
content_type() { awk 'tolower($1)=="content-type:"{sub(/;.*/,"",$2); gsub(/\r/,"",$2); ct=$2} END{print ct}' "$HEADERS"; }
# tick_events: the `stream N` probe's timed events, {"t": n}, one per two seconds plus t=0.
tick_events() { grep '^data: ' "$BODY" | sed 's/^data: //' | jq -s '[.[] | select(has("t"))] | length'; }

# rf [JQ OPTIONS] FILTER -> a field of the agent's first data event, or empty.
rf() { report_json 2>/dev/null | jq -r "$@" 2>/dev/null || true; }
# expect_eq WHAT WANT GOT -> fails unless GOT is WANT.
expect_eq() {
  [[ "$3" == "$2" ]] || fail "$1: expected '$2', got '$3'"
  echo "  $1: $3"
}
# put_ok WHAT STATUS -> fails unless an Entitlements API write answered 200 or 204.
put_ok() {
  [[ "$2" =~ ^20[04]$ ]] || fail "$1: HTTP $2 $(jq -c . "$BODY" 2>/dev/null | head -c 200)"
  echo "  $1 -> HTTP $2"
}
body_has() { grep -q "$1" "$BODY" 2>/dev/null; }

# issue TENANT USERNAME WHO -> issue_token, remembering tenant and user so fresh() can re-issue.
issue() {
  issue_token "$1" "$2" "$3"
  printf -v "${3}_TENANT" '%s' "$1"
  printf -v "${3}_USERNAME" '%s' "$2"
}
# fresh WHO... -> re-issue each identity token with under 90 s left (shared-pool access tokens live 5 minutes).
fresh() {
  local who exp t u
  for who in "$@"; do
    t="${who}_TENANT"; u="${who}_USERNAME"
    exp="$(jwt_claim "${who}_ACCESS" exp)"
    if [[ -z "$exp" ]] || (( exp - $(date +%s) < 90 )); then issue_token "${!t}" "${!u}" "$who"; fi
  done
}

# -- Discovery --------------------------------------------------------------
# The ingress publishes one JSON document (ADR-0042); the rest are stack outputs.
PUBLISHED="$(param "${PARAM_PREFIX}/ingress")" || fail "parameter ${PARAM_PREFIX}/ingress not found; deploy this sample first"
[[ "$(jq -r '.version // empty' <<<"$PUBLISHED" 2>/dev/null)" == 2 ]] || fail "parameter ${PARAM_PREFIX}/ingress is not a version 2 document (ADR-0042); redeploy this sample"
ENDPOINT="$(jq -r '.endpointUrl' <<<"$PUBLISHED")"
INGRESS="$(jq -r '.ingress' <<<"$PUBLISHED")"
ISSUER="$(jq -r '.issuer // empty' <<<"$PUBLISHED")"
ENT_API="$(jq -r '.entitlementsApiUrl // empty' <<<"$PUBLISHED")"
[[ -n "$ISSUER" && -n "$ENT_API" ]] || fail "the published document has no issuer or entitlementsApiUrl; redeploy this sample"
identity_init

# The stack that published the document, for the module outputs.
STACK="$(aws cloudformation describe-stack-resources --physical-resource-id "${PARAM_PREFIX}/ingress" \
  --query 'StackResources[0].StackName' --output text 2>/dev/null || true)"
OUTPUTS='[]'
if [[ -n "$STACK" && "$STACK" != None ]]; then
  OUTPUTS="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json 2>/dev/null || echo '[]')"
fi
output() { jq -r --arg k "$1" '[.[]? | select(.OutputKey == $k) | .OutputValue][0] // empty' <<<"$OUTPUTS"; }
TABLE="$(output DemoTableName)"
BILLING_URL="$(output BillingEndpointUrl)"
RUNTIME_ARN="$(output RuntimeArn)"
echo "ingress=${INGRESS} stack=${STACK:-unknown} tvm=$([[ -n "$TABLE" ]] && echo on || echo off) billing=$([[ -n "$BILLING_URL" ]] && echo on || echo off) (URLs and identifiers resolved; not printed)"

# The vendor scopes must be in tenant-identity's catalogue (README, Deploy, Prerequisites).
for sc in app/use entitlements/admin; do
  st="$(platform GET "platform/scopes/$(jq -rn --arg s "$sc" '$s | @uri')")"
  if stale_identity "$st"; then fail "tenant-identity has no scope catalogue (GET /platform/scopes/... HTTP ${st}); redeploy it (README, Deploy, Prerequisites)"; fi
  [[ "$st" == 200 ]] || fail "vendor scope ${sc} is not registered in tenant-identity (HTTP ${st}); register it as README, Deploy, Prerequisites shows"
done

RUN="$(date +%s)"
C1="demoConversation${RUN}"
SESSION=on
step() { printf '\n== %s\n' "$*"; }
# with_c1 PROMPT -> the invoke body on conversation c1 (no conversationId when the session module is off).
with_c1() { if [[ "$SESSION" == on ]]; then jq -nc --arg c "$C1" --arg p "$1" '{conversationId: $c, prompt: $p}'; else jq -nc --arg p "$1" '{prompt: $p}'; fi; }
# tool_c1 TOOL ARGS_JSON -> the `tool` probe body on c1.
tool_c1() { with_c1 "tool $1 $2"; }

# --------------------------------------------------------------------------
step "1. Tenants, users, plan, subscriptions and a cut (tenant-identity platform API; Entitlements API)"
create_tenant "rtiso-demo-a-${RUN}" "app/use entitlements/admin"; TENANT_A="$TENANT_ID"; AA_USER="$ADMIN_USERNAME"
create_user "$TENANT_A" "rtiso-demo-a1-${RUN}"; A1_USER="$USERNAME"
create_user "$TENANT_A" "rtiso-demo-a2-${RUN}"; A2_USER="$USERNAME"
create_tenant "rtiso-demo-b-${RUN}" "app/use"; TENANT_B="$TENANT_ID"; B1_USER="$ADMIN_USERNAME"
issue "$TENANT_A" "$AA_USER" AA
issue "$TENANT_A" "$A1_USER" A1
issue "$TENANT_A" "$A2_USER" A2
issue "$TENANT_B" "$B1_USER" B1
A1_SUB="$(jwt_claim A1_ACCESS sub)"; A2_SUB="$(jwt_claim A2_ACCESS sub)"
[[ " $(jwt_claim AA_ACCESS scope) " == *" entitlements/admin "* ]] || fail "tenant A's admin token carries no entitlements/admin"
echo "  tenant A=${TENANT_A} (admin AA with app/use entitlements/admin; users A1, A2); tenant B=${TENANT_B} (user B1, app/use)"

# Never overwrite a plan this run did not write.
st="$(vendor GET "plans/${PLAN}")"
[[ "$st" == 404 ]] || fail "plan ${PLAN} already exists (GetPlan HTTP ${st}); another run or vendor owns it, so this demo does not overwrite it"
put_ok "vendor PutPlan ${PLAN} (agents default billing; tools crm/* invoices/*)" \
  "$(vendor PUT "plans/${PLAN}" '{"agents":["default","billing"],"tools":["crm/*","invoices/*"]}')"
PLAN_WRITTEN=1
SUBSCRIBED+=("$TENANT_A")
put_ok "vendor PutTenantSubscription A (plan ${PLAN})" "$(vendor PUT "tenants/${TENANT_A}" "$(jq -nc --arg p "$PLAN" '{agents: [], tools: [], plan: $p}')")"
SUBSCRIBED+=("$TENANT_B")
put_ok "vendor PutTenantSubscription B (default; crm/get_account crm/list_cases)" \
  "$(vendor PUT "tenants/${TENANT_B}" '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}')"
put_ok "AA PutUserCut A2 (cutTools crm/update_case; bearer + X-Tenant-Id)" \
  "$(admin_api PUT "users/${A2_SUB}/cut" AA_ACCESS '{"cutAgents":[],"cutTools":["crm/update_case"]}' "$TENANT_A")"

# --------------------------------------------------------------------------
step "2. A1 opens conversation c1: unit prefix, nonce, and the transaction token's claims (never the token)"
fresh A1
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 report)")"
if [[ "$status" == 400 ]]; then
  SESSION=off
  echo "  the session module is off on this deployment: conversationId is refused (HTTP 400); re-asking without it"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 report)")"
fi
expect_status 200 "$status" "A1 report"
A1_UNIT="$(rf .unitId)"; A1_NONCE="$(rf .nonce)"
echo "  A1: prefix=$(rf .sessionPrefix) nonce=${A1_NONCE}"
expect_eq "transaction token reached the agent" true "$(rf .transactionToken)"
expect_eq "tokenTyp" "txn+jwt" "$(rf .tokenTyp)"
[[ "$(rf .tokenIss)" == "$ISSUER" ]] || fail "tokenIss is not the ingress issuer"
echo "  tokenIss: the ingress issuer (the published issuer)"
[[ "$(rf .tokenSub)" == "${TENANT_A}#${A1_SUB}" ]] || fail "tokenSub is not <tenant A>#<A1's sub>"
[[ "$(rf .tokenUser)" == "$A1_SUB" ]] || fail "tokenUser is not A1's sub"
echo "  tokenSub: <tenant A>#<A1's sub>; tokenUser: A1's sub"
NAMES="$(rf '.headerNames | join(" ")')"
[[ "$NAMES" != *custom-user-token* ]] || fail "an identity-token header reached the agent"
report_json | jq -e --arg i "$ISSUER" '.jwtHeaders | length > 0 and all(.typ == "txn+jwt" and .iss == $i)' >/dev/null \
  || fail "a JWT-shaped header that is not the ingress's transaction token reached the agent"
echo "  header names: ${NAMES}"
echo "  every JWT-shaped header is a txn+jwt from the ingress issuer: the identity token stayed at the ingress (P-14)"
TXN_ISS="$(rf .tokenIss)"

# --------------------------------------------------------------------------
step "3. Session scope tenant: A2 sending c1 lands in A1's unit; B1 sending c1 (and A1's unit id) gets its own"
if [[ "$SESSION" == off ]]; then
  echo "  session module off on this deployment (deploy with --context session=tenant): skipped"
else
  fresh A2 B1
  status="$(invoke "$ENDPOINT" A2_ACCESS "$(with_c1 report)")"; expect_status 200 "$status" "A2 report on c1"
  if [[ "$(rf .unitId)" == "$A1_UNIT" ]]; then
    echo "  A2: same unit as A1 (prefix=$(rf .sessionPrefix)): one conversation per tenant (ADR-0039)"
  else
    echo "  A2: own unit (prefix=$(rf .sessionPrefix)): this deployment runs session=user, not tenant"
  fi
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(with_c1 report)" "$A1_UNIT")"; expect_status 200 "$status" "B1 report on c1 with A1's unit id in the session header"
  [[ "$(rf .unitId)" != "$A1_UNIT" ]] || fail "B1 landed in A1's unit"
  [[ "$(rf .nonce)" != "$A1_NONCE" ]] || fail "B1 reached A1's microVM"
  echo "  B1: prefix=$(rf .sessionPrefix) nonce=$(rf .nonce) (own unit: the header was overwritten)"
fi

# --------------------------------------------------------------------------
step "4. A1 resumes c1"
fresh A1
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 report)")"; expect_status 200 "$status" "A1 resume"
if [[ "$SESSION" == on ]]; then
  [[ "$(rf .nonce)" == "$A1_NONCE" ]] || fail "A1 resumed c1 on a different microVM"
  echo "  same nonce: the conversation stays on its microVM"
else
  echo "  session off: a new unit per request (nonce=$(rf .nonce))"
fi

# --------------------------------------------------------------------------
step "5. Refusals: no token, a tampered token, an ID token, the transaction token's issuer"
status="$(invoke "$ENDPOINT" "" "$(with_c1 report)")"; expect_status "401|403" "$status" "no Authorization header"
TAMPERED="$(tamper A1_ACCESS)"
status="$(invoke "$ENDPOINT" TAMPERED "$(with_c1 report)")"; expect_status "401|403" "$status" "tampered signature"
TAMPERED=""
status="$(invoke "$ENDPOINT" A1_ID "$(with_c1 report)")"; expect_status "401|403" "$status" "ID token instead of an access token"
[[ -n "$TXN_ISS" && "$TXN_ISS" != "$(jwt_claim A1_ACCESS iss)" ]] || fail "the transaction token's iss is the identity provider's"
echo "  transaction token: iss is the ingress issuer, typ txn+jwt, not the identity provider's iss (step 2's claims)."
echo "  The ingress refuses its own iss and typ txn+jwt as an identity token (How it works, step 1); the agent never"
echo "  echoes the token, so the demo shows the claims only (integ.sh step 18 presents a minted one: 401|403)"

# --------------------------------------------------------------------------
step "6. Grants: A.needs ∪ (A.tools ∩ T.tools ∩ U.tools) if agent ∈ T.agents ∩ U.agents"
# expect_grant WHO URL AGENT SCOPE AUD_JSON
expect_grant() {
  local who="$1" url="$2" agent="$3" want="$4" aud="$5"
  fresh "$who"
  status="$(invoke "$url" "${who}_ACCESS" "$(with_c1 report)")"; expect_status 200 "$status" "${who} on ${agent}"
  [[ "$(rf .tokenAgent)" == "$agent" ]] || fail "${who} on ${agent}: agent claim $(rf .tokenAgent)"
  expect_eq "${who} on ${agent}: scope" "$want" "$(rf .tokenScope)"
  expect_eq "${who} on ${agent}: aud" "$(jq -c . <<<"$aud")" "$(rf -c .tokenAud)"
}
expect_grant A1 "$ENDPOINT" default "crm/* default/chat" '["agent:default","tools-gateway:default"]'
expect_grant A2 "$ENDPOINT" default "crm/get_account crm/list_cases default/chat" '["agent:default","tools-gateway:default"]'
echo "  A2: the tenant admin's cut removed crm/update_case; crm/* was expanded and cut, and a cut target stays an explicit list (ADR-0032)"
expect_grant B1 "$ENDPOINT" default "crm/get_account crm/list_cases default/chat" '["agent:default","tools-gateway:default"]'
if [[ -n "$BILLING_URL" ]]; then
  fresh B1
  status="$(invoke "$BILLING_URL" B1_ACCESS "$(with_c1 report)")"; expect_status 403 "$status" "B1 on billing"
  body_has agent_not_subscribed || fail "B1 on billing: expected forbidden: agent_not_subscribed"
  echo "  B1 on billing: forbidden: agent_not_subscribed (tenant B is not subscribed to billing)"
  expect_grant A1 "$BILLING_URL" billing "billing/invoke billing/read invoices/*" '["agent:billing","tools-gateway:finance"]'
else
  echo "  no billing agent on this deployment (deploy with --context billingBackend=true): billing rows skipped"
fi

# --------------------------------------------------------------------------
step "7. Tools gateways: the agent calls them with its transaction token"
CRM_TOOLS="crm___get_account crm___list_cases crm___update_case"
fresh A1 A2 B1
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 tools)")"; expect_status 200 "$status" "A1 tools"
expect_eq "A1 lists on default" "$CRM_TOOLS" "$(probe_tools default)"
status="$(invoke "$ENDPOINT" A2_ACCESS "$(tool_c1 crm/update_case '{"caseId":"case-1"}')")"; expect_status 200 "$status" "A2 tool crm/update_case"
expect_eq "A2 crm/update_case (the interceptor, per tool)" "forbidden: tool_not_granted" "$(probe_error)"
status="$(invoke "$ENDPOINT" A2_ACCESS "$(tool_c1 crm/get_account '{}')")"; expect_status 200 "$status" "A2 tool crm/get_account"
[[ -z "$(probe_error)" ]] || fail "A2 crm/get_account refused: $(probe_error)"
tool_payload | jq -e --arg t "$TENANT_A" '.tenantId == $t' >/dev/null || fail "A2 crm/get_account did not answer for tenant A ($(tool_payload | head -c 200))"
echo "  A2 crm/get_account: served for tenant ${TENANT_A} (no item seeded yet; step 8 reads data)"
status="$(invoke "$ENDPOINT" B1_ACCESS "$(with_c1 tools)")"; expect_status 200 "$status" "B1 tools"
expect_eq "B1 lists on default" "$CRM_TOOLS" "$(probe_tools default)"
[[ "$(rf '.result | has("finance")')" == false ]] || fail "B1's token names the finance gateway"
echo "  default runs without responseFilter: tools/list is at target grain, so B1 sees all of crm; each call is still"
echo "  checked per tool (B1's crm/update_case would be tool_not_granted). B1's token names no finance gateway."
if [[ -n "$BILLING_URL" ]]; then
  status="$(invoke "$BILLING_URL" A1_ACCESS "$(with_c1 tools)")"; expect_status 200 "$status" "A1 tools on billing"
  expect_eq "A1 lists on finance (RESPONSE filter on)" "invoices___get_invoice invoices___list_invoices" "$(probe_tools finance)"
fi

# --------------------------------------------------------------------------
step "8. Tool data isolation: each tool call assumes the tool tenant role for the context's tenant (P-15)"
if [[ -n "$TABLE" ]]; then
  for pair in "${TENANT_A}:a" "${TENANT_B}:b"; do
    t="${pair%%:*}"; l="${pair##*:}"
    SEEDED+=("TENANT#${t}")
    aws dynamodb put-item --table-name "$TABLE" --item "$(jq -nc --arg t "TENANT#${t}" --arg l "$l" '{
      PK: {S: $t}, note: {S: "demo item"},
      crmAccount: {M: {accountId: {S: ("acc-" + $l)}, name: {S: ("Account " + $l)}}},
      crmCases: {M: {"case-1": {M: {status: {S: "open"}}}}},
      invoices: {M: {"inv-1": {M: {amount: {S: "10.00"}, currency: {S: "EUR"}}}}}
    }')" >/dev/null
  done
  fresh A1 B1
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(tool_c1 crm/get_account '{}')")"; expect_status 200 "$status" "A1 tool crm/get_account"
  tool_payload | jq -e --arg t "$TENANT_A" '.tenantId == $t and .account.accountId == "acc-a"' >/dev/null \
    || fail "A1 crm/get_account did not return tenant A's account ($(probe_error))"
  echo "  A1: tenant ${TENANT_A}, account acc-a"
  status="$(invoke "$ENDPOINT" B1_ACCESS "$(tool_c1 crm/get_account '{}')")"; expect_status 200 "$status" "B1 tool crm/get_account"
  tool_payload | jq -e --arg t "$TENANT_B" '.tenantId == $t and .account.accountId == "acc-b"' >/dev/null \
    || fail "B1 crm/get_account did not return tenant B's account ($(probe_error))"
  echo "  B1: tenant ${TENANT_B}, account acc-b"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 "read ${TENANT_A}")")"; expect_status 200 "$status" "A1 read ${TENANT_A}"
  [[ "$(rf '.read.result // empty')" == ok ]] || fail "A1 could not read its own tenant's item: $(rf '.read.error // "no read result"')"
  echo "  A1 read ${TENANT_A}: ok (positive control)"
  status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 "read ${TENANT_B}")")"; expect_status 200 "$status" "A1 read ${TENANT_B}"
  err="$(rf '.read.error // empty')"
  [[ "$(rf '.read.result // empty')" == error && "$err" =~ AccessDenied ]] \
    || fail "A1 reading tenant B's item was not refused by IAM (result=$(rf '.read.result // "none"') error=${err:-none})"
  echo "  A1 read ${TENANT_B}: error ${err} (IAM refused the cross-tenant read)"
else
  echo "  no demo table on this deployment (deploy with --context tvm=true): skipped"
fi

# --------------------------------------------------------------------------
step "9. Change lag: the vendor removes crm/list_cases from tenant B; B1's next request carries the smaller scope"
put_ok "vendor PutTenantSubscription B (default; crm/get_account)" \
  "$(vendor PUT "tenants/${TENANT_B}" '{"agents":["default"],"tools":["crm/get_account"]}')"
echo "  a fresh identity token for B1: the api-gateway authoriser caches its decision per token for up to 60 s (ADR-0043);"
echo "  the subscription's new version changes the mint cache key, so the next mint sees it (ADR-0036)"
issue_token "$TENANT_B" "$B1_USER" B1
status="$(invoke "$ENDPOINT" B1_ACCESS "$(with_c1 report)")"; expect_status 200 "$status" "B1 report"
expect_eq "B1 on default: scope" "crm/get_account default/chat" "$(rf .tokenScope)"

# --------------------------------------------------------------------------
step "10. Streaming: 'stream 10' arrives as text/event-stream"
fresh A1
status="$(invoke_with_headers "$ENDPOINT" A1_ACCESS "$(with_c1 'stream 10')")"; expect_status 200 "$status" "A1 stream 10"
ct="$(content_type)"
[[ "$ct" == text/event-stream ]] || fail "stream 10: expected Content-Type text/event-stream, got ${ct:-none}"
ticks="$(tick_events)"
[[ "$ticks" -ge 6 ]] || fail "stream 10: expected at least 6 timed events (t=0 to t=10, every 2 s), got ${ticks}"
[[ -n "$(usage_json)" ]] || fail "stream 10: no usage event at the end of the stream"
timing
echo "  Content-Type ${ct}; ${ticks} timed events ($(data_events) data events with the usage event), first byte after ${LAST_TTFB}s, done after ${LAST_TOTAL}s"

# --------------------------------------------------------------------------
step "11. Cost per tenant: a model prompt ends with the usage event (P-10, ADR-0018)"
fresh A1
status="$(invoke "$ENDPOINT" A1_ACCESS "$(with_c1 'Reply with the single word OK.')")"; expect_status 200 "$status" "A1 model prompt"
[[ -z "$(error_event)" ]] || fail "the model call returned event: error $(error_event)"
echo "  answer: $(grep '^data: ' "$BODY" | sed 's/^data: //' | jq -rj 'select(.text) | .text' | head -c 300)"
[[ -n "$(usage_json)" ]] || fail "no usage event"
echo "  usage event: $(usage_json)"
if [[ "$INGRESS" == api-gateway ]]; then
  echo "  the ingress meters it per tenant; with perTenantMetrics on, RuntimeIsolation ModelOutputTokens for TenantId=${TENANT_A} lands within minutes"
else
  echo "  the agentcore-gateway ingress meters requests only (ADR-0017); the model call is billed to the tenant role in CUR 2.0"
fi
echo "  in CUR 2.0 the Bedrock line items carry iamPrincipal/TenantId=${TENANT_A} (ADR-0018)"

RUNTIME_NAME="${RUNTIME_ARN##*/}"
step "Demo complete (runtime ${RUNTIME_NAME:-unknown}); cleanup removes the tenants, subscriptions, plan and demo items"
