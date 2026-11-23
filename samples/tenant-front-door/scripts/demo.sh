#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo of the tenant front door in host mode, against the
# deployment an integration test run keeps up (TFD_INTEG_KEEP=1,
# integration-test.md). That deployment holds the front door, two demo
# cells (A and B) and two tenants, a in cell A and b in cell B, each with
# its own host name below the app domain.
#
#   scripts/demo.sh <run id>
#
# Walks one tenant's path and the edge's refusals, with the expected answer
# of each step printed next to the real one:
#   1. both tenants are set active, and each tenant's own address answers
#      and names the tenant;
#   2. each tenant signs in (the IssueToken test aid of tenant-identity,
#      as the integration test does);
#   3. each tenant reaches only its own cell;
#   4. a's token on b's address and b's token on a's address are refused,
#      and a client-sent route hint naming b is ignored;
#   5. b is suspended: b's address answers 503 with Retry-After while a is
#      still served;
#   6. b is resumed and served again.
#
# Needs: bash 4.4 or later, aws (v2), curl 7.75 or later, jq, the checkout
# that ran the integration test (it reads .integ/<run id>/), and credentials
# of the same role in the run's edge account. The run id is the one the
# integration test printed. All data is synthetic: the run's own tenants.
# Nothing is created that outlives the demo. It sets both tenants active
# (the host test leaves b suspended) and suspends b for step 5; the
# suspension is undone from the EXIT trap on every exit.
#
# Hygiene (scripts/CONVENTIONS.md): tokens stay in shell variables and 0600
# files, reach curl on stdin, and are never printed. The script prints
# tenant ids, host names, HTTP status codes and cell names.

set -euo pipefail
cd "$(dirname "$0")/.."

RUN_ID="${1:-}"
[[ "$RUN_ID" =~ ^[a-z0-9]{1,10}$ ]] || { echo "usage: scripts/demo.sh <run id>" >&2; exit 2; }
for tool in aws curl jq; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 2; }
done

# shellcheck source=integ/lib.sh
source scripts/integ/lib.sh
die() { echo "demo: $*" >&2; exit 1; }

RUN_DIR="$PWD/.integ/$RUN_ID"
[[ -s "$RUN_DIR/context.json" && -s "$RUN_DIR/state.env" ]] \
  || die "no kept run ${RUN_ID} here: run the integration test with TFD_INTEG_KEEP=1 first (integration-test.md)"
state_load
: "${TENANT_A:?run ${RUN_ID} has no tenant a}" "${TENANT_B:?run ${RUN_ID} has no tenant b}"
: "${TI_USER_A:?run ${RUN_ID} has no user of tenant a}" "${TI_USER_B:?run ${RUN_ID} has no user of tenant b}"
REGION="$(jq -er .region "$RUN_DIR/context.json")"
IDENTITY_REGION="$(jq -er .identity.region "$RUN_DIR/context.json")"
APP_DOMAIN="$(jq -er .appDomain "$RUN_DIR/context.json")"
EDGE_ACCOUNT="$(jq -er .edgeAccount "$RUN_DIR/context.json")"
export AWS_REGION="$REGION"

TMP="$(mktemp -d)"
BODY="$TMP/body"; HEAD="$TMP/head"; REQ="$TMP/req"
: >"$BODY"; : >"$HEAD"; : >"$REQ"; chmod 600 "$BODY" "$HEAD" "$REQ"
A_TOKEN=""; B_TOKEN=""; EDGE_OPERATOR=""; REGISTRAR=""
SUSPENDED=no

# Armed before the first change: resumes b if the run stops while b is
# suspended, then removes the temp files.
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "$SUSPENDED" == yes ]]; then
    if [[ "$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}/status" '{"status":"active"}' 2>/dev/null)" == 200 ]]; then
      echo "Cleanup: resumed tenant b"
    else
      echo "Cleanup: could not resume tenant b; scripts/integ.sh teardown ${RUN_ID} host removes the run, tenant b included" >&2
      (( rc != 0 )) || rc=1
    fi
  fi
  rm -f "$TMP"/*
  rmdir "$TMP" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

# As host_of in integ/steps.sh, which the demo does not source.
host_of() { echo "${1,,}.${APP_DOMAIN}"; }
say() { printf '\n== %s\n   expect: %s\n' "$1" "$2"; }
# poll NAME WANT HOST TOKEN_VAR: a request every 6 s until three answers in a row are WANT, for at most 90 s.
# It leaves the last answer in $BODY and $HEAD; the checks after it read them.
# Not wait_status of lib.sh: its 2 s interval would pass the 50 requests per 5 minutes that the integration
# test's deployment allows one client IP on /api/* of one tenant host (a second demo run needs a 5 minute gap).
# Budget: b's host gets at most 46 such requests per run (1 fixed plus three polls of at most 15).
poll() {
  local st run=0 start
  start=$(date +%s)
  while (( $(elapsed "$start") < 90 )); do
    st="$(edge GET "$3" /api/whoami "$4")"
    if [[ "$st" == "$2" ]]; then run=$((run + 1)); (( run >= 3 )) && break; else run=0; fi
    sleep 6
  done
  check "$1 (after $(elapsed "$start") s)" "$2" "$st"
}
status_of() { as "$EDGE_OPERATOR" PUT "tenants/${1}/status" "{\"status\":\"$2\"}"; }

# -- 0. The deployment ---------------------------------------------------------------------
say "0. Read run ${RUN_ID}'s front door" "the credentials are the run's edge account; the front door is in host mode"
CALLER="$(aws sts get-caller-identity --query Account --output text)" || die "no working AWS credentials (sts get-caller-identity failed)"
[[ "$CALLER" == "$EDGE_ACCOUNT" ]] || die "the credentials point at another account than run ${RUN_ID}'s edge account"
EDGE_PARAM="$(aws ssm get-parameter --region "$REGION" --name /application-plane/shared/front-door/edge --query Parameter.Value --output text)" \
  || die "no front door in ${REGION}: the run's stacks are gone (scripts/integ.sh teardown removes what is left)"
check "the front door serves ${APP_DOMAIN} in host mode" "host:${APP_DOMAIN}" "$(jq -r '"\(.addressing):\(.appDomain)"' <<<"$EDGE_PARAM")"
(( FAILS == 0 )) || die "the front door here is not run ${RUN_ID}'s, or it is not in host mode"
REGISTRAR="$(jq -r .registrarUrl <<<"$EDGE_PARAM")"; [[ "$REGISTRAR" == */ ]] || REGISTRAR="$REGISTRAR/"
EDGE_OPERATOR="$(stack_out "TfdInteg-${RUN_ID}-support" EdgeOperatorRoleArn)" \
  || die "cannot read run ${RUN_ID}'s support stack in ${REGION}"
IDENTITY_API="$(aws ssm get-parameter --region "$IDENTITY_REGION" --name /application-plane/shared/identity/apiUrl --query Parameter.Value --output text)" \
  || die "cannot read tenant-identity's apiUrl parameter in ${IDENTITY_REGION}"
[[ "$IDENTITY_API" == */ ]] || IDENTITY_API="$IDENTITY_API/"
HOST_A="$(host_of "$TENANT_A")"; HOST_B="$(host_of "$TENANT_B")"
echo "   tenant a: ${HOST_A}"
echo "   tenant b: ${HOST_B}"

# -- 1. Both tenants active ----------------------------------------------------------------
say "1. Set both tenants active (the edge operator role, registrar UpdateTenantRouteStatus)" "HTTP 200 each; the edge serves both once the route reaches it (about a minute at most)"
check "a set active" 200 "$(status_of "$TENANT_A" active)"
check "b set active" 200 "$(status_of "$TENANT_B" active)"
# Each check below reads the answer the last request of its wait or poll left in $BODY, not a new
# request: while a route change spreads, a new request can reach an edge location that has not seen it.
wait_status "a's address answers /config.json" 200 "$HOST_A" /config.json "" 150
check "a's address names tenant a" "$TENANT_A" "$(body_tenant)"
wait_status "b's address answers /config.json" 200 "$HOST_B" /config.json "" 150
check "b's address names tenant b" "$TENANT_B" "$(body_tenant)"

# -- 2. Each tenant signs in ----------------------------------------------------------------------
say "2. Each tenant signs in (tenant-identity's IssueToken test aid)" "a token is issued for each; none is shown"
token_for a A_TOKEN
token_for b B_TOKEN
check "a signed in (token not shown)" yes "$([[ -n "$A_TOKEN" ]] && echo yes || echo no)"
check "b signed in (token not shown)" yes "$([[ -n "$B_TOKEN" ]] && echo yes || echo no)"
(( FAILS == 0 )) || die "a step failed; stopping before the suspension"

# -- 3. Each tenant reaches only its own cell ----------------------------------------------------
say "3. Each tenant calls /api/whoami on its own address" "a is answered by cell-a, b by cell-b, each naming its own tenant id"
poll "a is served on its address" 200 "$HOST_A" A_TOKEN
check "a's last answer: tenant, cell" "${TENANT_A}:cell-a" "$(body_tenant):$(body_cell)"
poll "b is served on its address" 200 "$HOST_B" B_TOKEN
check "b's last answer: tenant, cell" "${TENANT_B}:cell-b" "$(body_tenant):$(body_cell)"

# -- 4. The other tenant's address and route hint ----------------------------------------------
say "4. a tries b's address, and sends b's route hint" "a's token on b's address 403; the hint header is ignored and cell-a answers"
check "a's token on b's address" 403 "$(edge GET "$HOST_B" /api/whoami A_TOKEN)"
check "b's token on a's address" 403 "$(edge GET "$HOST_A" /api/whoami B_TOKEN)"
check "a with x-tenant-route naming b: HTTP, tenant, cell" "200:${TENANT_A}:cell-a" \
  "$(edge GET "$HOST_A" /api/whoami A_TOKEN -H "x-tenant-route: ${TENANT_B,,}"):$(body_tenant):$(body_cell)"

# -- 5. Suspend b ----------------------------------------------------------------------------------
say "5. Suspend b (edge operator role)" "HTTP 200; then b's address answers 503 with Retry-After 300 while a is still served"
SUSPENDED=yes
suspended="$(status_of "$TENANT_B" suspended)"
check "b suspended" 200 "$suspended"
[[ "$suspended" == 200 ]] || die "b was not suspended; stopping"
poll "b's address answers 503" 503 "$HOST_B" B_TOKEN
check "b's 503 carries Retry-After" 300 "$(header retry-after)"
check "a is still served" "200:${TENANT_A}:cell-a" "$(edge GET "$HOST_A" /api/whoami A_TOKEN):$(body_tenant):$(body_cell)"

# -- 6. Resume b ------------------------------------------------------------------------------------
say "6. Resume b" "HTTP 200; then b's address is answered by cell-b again"
resumed="$(status_of "$TENANT_B" active)"
check "b resumed" 200 "$resumed"
if [[ "$resumed" == 200 ]]; then SUSPENDED=no; fi
poll "b's address answers 200" 200 "$HOST_B" B_TOKEN
check "b's last answer: tenant, cell" "${TENANT_B}:cell-b" "$(body_tenant):$(body_cell)"

echo
if (( FAILS == 0 )); then
  echo "demo complete: ${PASS} checks passed (run ${RUN_ID}; the run's stacks stay up: scripts/integ.sh teardown ${RUN_ID} host removes them)"
else
  echo "demo FAILED: ${PASS} passed, ${FAILS} failed" >&2
  exit 1
fi
