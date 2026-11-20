#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application tenant CREATE (and UPDATE) script (spec §3.3, step 3; stress ADR-0012).
#
# Runs in the control plane's tenant CodeBuild project with TENANT_ID, TENANT_NAME,
# APPLICATION_ID, CELL_ID, CELL_ACCOUNT_ID, OPERATION, OUTPUTS_FILE, PARAM_AGENTS and
# PARAM_TOOLS (comma-separated names, declared with defaults by the stress application), under
# the cell account's role pair tenant role. That role reads the cell namespace, owns the
# tenant namespace, and holds cell-tenant-build-policy: the tenant subscription methods of the
# account's Entitlements APIs, nothing else.
#
# It subscribes the tenant to the cell's agents and tools on the cell's Entitlements API
# (PutTenantSubscription, SigV4) and records the deployment under
# /application-plane/tenants/<tenant id>/<application id>: the cell and the subscription
# version, which the control-plane slice reads back as an isolation assertion. TENANT_NAME is
# never used. The tenant-identity tenant and the front-door route of the platform run
# (spec §3.3) join when those slices compose (W-9).
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${CELL_ACCOUNT_ID:?CELL_ACCOUNT_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source=../lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

if ! [[ "$TENANT_ID" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
  echo "TENANT_ID is not a ULID: refusing"
  exit 1
fi
caller="$(aws sts get-caller-identity --query Account --output text)"
if [ "$caller" != "$CELL_ACCOUNT_ID" ]; then
  echo "Running in account ${caller}, not the cell's account ${CELL_ACCOUNT_ID}: refusing"
  exit 1
fi
echo "Tenant ${TENANT_ID} of ${APPLICATION_ID} into cell ${CELL_ID} (${OPERATION:-CREATE})"

api="$(get_param "$(cell_param entitlements-api-url)")"
echo "Read $(cell_param entitlements-api-url)"
api="${api%/}"  # the API base: .../<stage>/entitlements

# Names to JSON with jq; PARAM_ values are operator text, so they are never logged or eval'd.
body="$(jq -cn --arg agents "${PARAM_AGENTS-}" --arg tools "${PARAM_TOOLS-}" \
  '{agents: ($agents | split(",") | map(select(length > 0))), tools: ($tools | split(",") | map(select(length > 0)))}')"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT
status="$(sigv4 PUT "${api}/tenants/${TENANT_ID}" "$response" "$body")"
if [ "$status" != 200 ]; then
  echo "PutTenantSubscription for ${TENANT_ID} returned HTTP ${status} ($(jq -r '.reason // .__type // "no reason"' "$response" 2> /dev/null || echo 'no body'))"
  exit 1
fi
version="$(jq -er '.subscription.version' "$response")"
echo "Subscribed ${TENANT_ID} on cell ${CELL_ID} (version ${version})"

state="$(jq -cn --arg cell "$CELL_ID" --arg app "$APPLICATION_ID" --arg tenant "$TENANT_ID" --argjson version "$version" \
  '{tenantId: $tenant, applicationId: $app, cellId: $cell, subscriptionVersion: $version}')"
put_param "/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}" "$state"
if [ -n "${OUTPUTS_FILE:-}" ]; then
  printf '{"cellId":"%s"}\n' "$CELL_ID" > "$OUTPUTS_FILE"
fi
echo "Tenant ${TENANT_ID} ready in cell ${CELL_ID}"
