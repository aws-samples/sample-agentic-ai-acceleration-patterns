#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Demo walk-through against a deployed demo stack (README "End-to-end demo").
#
#   AWS_REGION=eu-central-1 DEMO_TENANT=<tenantId> DEMO_TOKEN_FILE=<file with an access token> scripts/demo.sh
#
# 1. CreateTenantKey for DEMO_TENANT (vendor-key) over SigV4: 201 and
#    keyStatus ACTIVE. A 409 means the key already exists; the demo uses it
#    and does not offboard it unless DEMO_OFFBOARD=1.
# 2. CreateDelivery with a synthetic 2-page PDF (201), PUT it with the
#    returned headers (200), poll GetDelivery every 5 s until terminal:
#    ACCEPTED.
# 3. The same with a 5-page PDF: REJECTED, reason pdf-pages:TOO_MANY_PAGES
#    (the pdf-pages validator's limit is 3).
# 4. On exit, also on failure: DeleteTenantKey (202) when this run created
#    the key, or DEMO_OFFBOARD=1 is set. Offboarding is the only way to
#    remove deliveries: it deletes the tenant's objects under both prefixes
#    and schedules the key for deletion. KEEP=1 keeps everything.
#
# The access token comes from a file (mode 0600) the operator made with
# tenant-identity; it is read into a variable and never printed. Tokens live
# five minutes, so issue one just before the run.
# Conventions: scripts/CONVENTIONS.md.

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION}"
: "${DEMO_TENANT:?Set DEMO_TENANT to the tenant id (spec §7.0 grammar)}"
: "${DEMO_TOKEN_FILE:?Set DEMO_TOKEN_FILE to a file holding a tenant-identity access token with ingestion/deliver and ingestion/read}"
for tool in aws curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_TMP="$(mktemp -d)"
# What this run created, for the EXIT trap.
CREATED_KEY=0
DELIVERIES=()

cleanup() {
  local code=$? st
  set +e
  if [[ "${KEEP:-0}" == 1 ]]; then
    echo "== cleanup: KEEP=1, leaving the tenant key and ${#DELIVERIES[@]} deliveries (${DELIVERIES[*]:-none})"
  elif [[ -z "${INGESTION_API:-}" ]]; then
    : # failed before the stack was found: nothing was created
  elif [[ "$CREATED_KEY" == 1 || "${DEMO_OFFBOARD:-0}" == 1 ]]; then
    echo "== cleanup: DeleteTenantKey ${DEMO_TENANT}"
    st="$(platform DELETE "platform/tenants/${DEMO_TENANT}/key")"
    if [[ "$st" == 202 ]]; then
      echo "  ok: DeleteTenantKey -> HTTP 202 (deliveries ${DELIVERIES[*]:-none} removed with the tenant's objects)"
    else
      echo "  WARNING: DeleteTenantKey -> HTTP ${st} code=$(jq -r '.code // "-"' "$BODY" 2>/dev/null); offboard ${DEMO_TENANT} by hand" >&2
      [[ "$code" != 0 ]] || code=1
    fi
  elif [[ ${#DELIVERIES[@]} -gt 0 ]]; then
    echo "== cleanup: the key existed before this run; not offboarding it. Deliveries left: ${DELIVERIES[*]} (DEMO_OFFBOARD=1 removes them with the key)"
  fi
  rm -rf "$LIB_TMP"
  exit "$code"
}
trap cleanup EXIT

# shellcheck source=lib.sh
source "${SAMPLE_DIR}/scripts/lib.sh"
ingestion_init
# shellcheck disable=SC2034 # read by name in tenant_call
TOKEN="$(<"$DEMO_TOKEN_FILE")"

echo "== 1: CreateTenantKey ${DEMO_TENANT}"
status="$(platform POST "platform/tenants/${DEMO_TENANT}/key" '{"tier":"vendor-key"}')"
case "$status" in
  201)
    CREATED_KEY=1
    key_status="$(jq -r '.key.keyStatus // "-"' "$BODY")"
    [[ "$key_status" == ACTIVE ]] || fail "CreateTenantKey: expected keyStatus ACTIVE, got ${key_status}"
    echo "  ok: CreateTenantKey -> HTTP 201 keyStatus=ACTIVE"
    ;;
  409)
    echo "  CreateTenantKey -> HTTP 409: the key exists; checking it"
    expect_status 200 "$(platform GET "platform/tenants/${DEMO_TENANT}/key")" "GetTenantKey"
    key_status="$(jq -r '.key.keyStatus // "-"' "$BODY")"
    [[ "$key_status" == ACTIVE ]] || fail "GetTenantKey: expected keyStatus ACTIVE, got ${key_status}"
    echo "  ok: existing key keyStatus=ACTIVE"
    ;;
  *)
    fail "CreateTenantKey: expected HTTP 201 (or 409), got ${status} code=$(jq -r '.code // "-"' "$BODY")"
    ;;
esac

# deliver PAGES LABEL EXPECTED_STATUS [EXPECTED_REASON]
deliver() {
  local pages="$1" label="$2" want="$3" want_reason="${4:-}"
  local file="${LIB_TMP}/doc.pdf" size id st reason
  synthetic_pdf "$pages" "$file"
  size="$(wc -c <"$file" | tr -d ' ')"
  st="$(tenant_call POST tenant/deliveries TOKEN "$(jq -nc --arg n "synthetic-${label}.pdf" --argjson s "$size" '{fileName: $n, contentType: "application/pdf", sizeBytes: $s}')")"
  expect_status 201 "$st" "CreateDelivery ${label}"
  id="$(jq -r .deliveryId "$BODY")"
  DELIVERIES+=("$id")
  expect_status 200 "$(upload "$file")" "PUT ${label}"
  st=AWAITING_UPLOAD
  for _ in $(seq 36); do
    sleep 5
    expect_status 200 "$(tenant_call GET "tenant/deliveries/${id}" TOKEN)" "GetDelivery ${id}" >/dev/null
    st="$(jq -r .delivery.status "$BODY")"
    [[ "$st" == AWAITING_UPLOAD || "$st" == PROCESSING ]] || break
  done
  reason="$(jq -r '.delivery.reason // "-"' "$BODY")"
  echo "  delivery ${id}: status=${st} reason=${reason}"
  [[ "$st" != AWAITING_UPLOAD && "$st" != PROCESSING ]] || fail "delivery ${id} not terminal after 3 minutes (status ${st})"
  [[ "$st" == "$want" ]] || fail "delivery ${id}: expected ${want}, got ${st} (reason ${reason})"
  if [[ -n "$want_reason" ]]; then
    [[ "$reason" == "$want_reason" ]] || fail "delivery ${id}: expected reason ${want_reason}, got ${reason}"
  fi
  echo "  ok: ${label} -> ${st}"
}

echo "== 2: a 2-page PDF"
deliver 2 two-pages ACCEPTED
echo "== 3: a 5-page PDF (pdf-pages limit 3)"
deliver 5 five-pages REJECTED pdf-pages:TOO_MANY_PAGES
echo "== demo passed"
