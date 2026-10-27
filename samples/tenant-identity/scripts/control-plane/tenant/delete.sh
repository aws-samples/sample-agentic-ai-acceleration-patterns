#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane tenant DELETE script for tenant-identity (ADR-0028, mounting
# spec §7.3). Runs in the control-plane tenant CodeBuild project with
# TENANT_ID, TENANT_NAME, CELL_ID, OPERATION, OPERATOR_ID, AWS_REGION.
#
# Offboards the tenant's identity and removes the parked password. It is also
# the clean-up path for CREATE_FAILED tenants, so "already gone" is success:
# 404 from DeleteTenant and ParameterNotFound from delete-parameter both pass.
# tenant-identity's DeleteTenant is idempotent against DELETING (its R-11), so
# a re-run finishes a half-done offboarding.
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

echo "Offboarding identity for tenant ${TENANT_ID} in cell ${CELL_ID} (${OPERATION}, operator ${OPERATOR_ID})"

PARKED_PARAM="/application-plane/tenants/${TENANT_ID}/identity/admin-temporary-password"

# Step 1: DeleteTenant; 204 and 404 are both success.
read_identity_param apiUrl API_URL
platform_call DELETE 'platform/tenants/{tenantId}'
case "$PLATFORM_STATUS" in
  204) echo "Tenant ${TENANT_ID} identity offboarding started" ;;
  404) echo "Tenant ${TENANT_ID} has no identity to offboard (HTTP 404)" ;;
  *) fail "DeleteTenant for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
esac

# Step 2: the parked password; ParameterNotFound is success. Any other error
# fails naming the parameter and the error class (never the CLI's full text).
if aws ssm delete-parameter --name "$PARKED_PARAM" >/dev/null 2>"$PLATFORM_ERR_FILE"; then
  echo "Deleted ${PARKED_PARAM}"
else
  class="$(aws_error_class "$PLATFORM_ERR_FILE")"
  : >"$PLATFORM_ERR_FILE"
  if [[ "$class" == ParameterNotFound ]]; then
    echo "No parked password at ${PARKED_PARAM}; nothing to delete"
  else
    fail "delete-parameter ${PARKED_PARAM} failed (${class})"
  fi
fi

echo "Tenant ${TENANT_ID} identity offboarded"
