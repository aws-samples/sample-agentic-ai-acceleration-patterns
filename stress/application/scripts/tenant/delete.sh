#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application tenant DELETE script (spec §3.3; stress ADR-0012). Runs like create.sh,
# under the cell account's role pair tenant role: removes the tenant's subscription from the
# cell's Entitlements API (DeleteTenantSubscription; a subscription that is already gone is
# not an error) and the deployment's state parameter.
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
echo "Removing tenant ${TENANT_ID} of ${APPLICATION_ID} from cell ${CELL_ID}"

if api="$(get_param "$(cell_param entitlements-api-url)" 2> /dev/null)"; then
  response="$(mktemp)"
  trap 'rm -f "$response"' EXIT
  status="$(sigv4 DELETE "${api%/}/tenants/${TENANT_ID}" "$response")"
  case "$status" in
    200 | 204 | 404) echo "Subscription of ${TENANT_ID} removed (HTTP ${status})" ;;
    *)
      echo "DeleteTenantSubscription for ${TENANT_ID} returned HTTP ${status}"
      exit 1
      ;;
  esac
else
  echo "No $(cell_param entitlements-api-url): the cell has no Entitlements API to clean"
fi
delete_param "/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}"
if [ -n "${OUTPUTS_FILE:-}" ]; then
  printf '{}\n' > "$OUTPUTS_FILE"
fi
echo "Tenant ${TENANT_ID} removed from cell ${CELL_ID}"
