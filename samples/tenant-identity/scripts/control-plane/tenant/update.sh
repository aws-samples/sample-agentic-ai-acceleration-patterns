#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane tenant UPDATE script for tenant-identity (ADR-0028, mounting
# spec §7.2). Runs in the control-plane tenant CodeBuild project with
# TENANT_ID, TENANT_NAME, CELL_ID, OPERATION, OPERATOR_ID, AWS_REGION.
#
# Reconcile only: the tenant's identity must be ACTIVE. It never creates, so a
# tenant whose identity was lost fails loudly instead of being silently
# re-onboarded with no ADMIN_EMAIL.
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${TENANT_NAME:?TENANT_NAME env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${OPERATION:?OPERATION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

echo "Reconciling identity for tenant ${TENANT_ID} in cell ${CELL_ID} (${OPERATION}, operator ${OPERATOR_ID})"

read_identity_param apiUrl API_URL

platform_call GET 'platform/tenants/{tenantId}'
case "$PLATFORM_STATUS" in
  200) TENANT_STATUS="$(jq -r '.tenant.status // empty' <<<"$PLATFORM_BODY")" ;;
  404) fail "tenant ${TENANT_ID} has no identity (HTTP 404); it was never onboarded or has been offboarded" ;;
  *) fail "GetTenant for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
esac

[[ "$TENANT_STATUS" == ACTIVE ]] \
  || fail "tenant ${TENANT_ID} identity is '${TENANT_STATUS}', expected ACTIVE"

echo "Tenant ${TENANT_ID} identity is ACTIVE"
