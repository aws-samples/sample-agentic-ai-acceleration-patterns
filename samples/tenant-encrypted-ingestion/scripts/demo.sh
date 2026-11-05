#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Demo walk-through against a deployed demo stack (skeleton; the README,
# phase 7, will narrate it).
#
#   AWS_REGION=eu-central-1 DEMO_TENANT=tenant-a DEMO_TOKEN_FILE=<file with an access token> scripts/demo.sh
#
# 1. CreateTenantKey for DEMO_TENANT (vendor-key) over SigV4.
# 2. CreateDelivery with a synthetic 2-page PDF, PUT it with the six signed
#    headers, poll GetDelivery until it is terminal.
# 3. A 5-page PDF: rejected by the pdf-pages validator (limit 3).
# 4. Optional (DEMO_OFFBOARD=1): DeleteTenantKey.
#
# The access token comes from a file (mode 0600) the operator made with
# tenant-identity; it is read into a variable and never printed.
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
trap 'rm -rf "$LIB_TMP"' EXIT
# shellcheck source=lib.sh
source "${SAMPLE_DIR}/scripts/lib.sh"
ingestion_init
# shellcheck disable=SC2034 # read by name in tenant_call
TOKEN="$(<"$DEMO_TOKEN_FILE")"

echo "== 1: CreateTenantKey ${DEMO_TENANT}"
status="$(platform POST "platform/tenants/${DEMO_TENANT}/key" '{"tier":"vendor-key"}')"
echo "  HTTP ${status} keyStatus=$(jq -r '.key.keyStatus // .code' "$BODY")"

deliver() { # PAGES LABEL
  local file="${LIB_TMP}/doc.pdf" size id st
  synthetic_pdf "$1" "$file"
  size="$(wc -c <"$file" | tr -d ' ')"
  st="$(tenant_call POST tenant/deliveries TOKEN "$(jq -nc --arg n "synthetic-$2.pdf" --argjson s "$size" '{fileName: $n, contentType: "application/pdf", sizeBytes: $s}')")"
  expect_status 201 "$st" "CreateDelivery $2"
  id="$(jq -r .deliveryId "$BODY")"
  expect_status 200 "$(upload "$file")" "PUT $2"
  for _ in $(seq 36); do
    tenant_call GET "tenant/deliveries/${id}" TOKEN >/dev/null
    st="$(jq -r .delivery.status "$BODY")"
    [[ "$st" == AWAITING_UPLOAD || "$st" == PROCESSING ]] || break
    sleep 5
  done
  echo "  delivery ${id}: status=${st} reason=$(jq -r '.delivery.reason // "-"' "$BODY")"
}

echo "== 2: a 2-page PDF"
deliver 2 two-pages
echo "== 3: a 5-page PDF (pdf-pages limit 3)"
deliver 5 five-pages

if [[ "${DEMO_OFFBOARD:-0}" == 1 ]]; then
  echo "== 4: DeleteTenantKey ${DEMO_TENANT}"
  echo "  HTTP $(platform DELETE "platform/tenants/${DEMO_TENANT}/key")"
fi
