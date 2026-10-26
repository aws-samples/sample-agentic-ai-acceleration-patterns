#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane tenant CREATE script for tenant-identity (ADR-0028, mounting
# spec §7.1). Runs in the control-plane tenant CodeBuild project with
# TENANT_ID, TENANT_NAME, CELL_ID, OPERATION, ADMIN_EMAIL, OPERATOR_ID,
# AWS_REGION (spec §6.1). Onboards the tenant's identity under the SAME tenant
# id (M-P-1) and parks the first admin's temporary password in an SSM
# SecureString encrypted with AdminPasswordKey (ADR-0031, ADR-0033).
#
# Safe to re-run (M-P-3): every step reads state first and only writes what
# is missing. A replay after a build that was killed before the park claims
# the first-admin slot (M-R-6, ADR-0032) instead of re-parking.
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${TENANT_NAME:?TENANT_NAME env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${OPERATION:?OPERATION env var is required}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# §3.3 audit: the operator beside the tenant id, so an identity access-log
# line (which shows only the build role) joins to the operator here.
echo "Onboarding identity for tenant ${TENANT_ID} in cell ${CELL_ID} (${OPERATION}, operator ${OPERATOR_ID})"

PARKED_PARAM="/application-plane/tenants/${TENANT_ID}/identity/admin-temporary-password"

# Step 6: park PW as a SecureString under AdminPasswordKey (M-R-11), output to
# /dev/null, then forget it. Logs the parameter name only.
park_password() {
  aws ssm put-parameter --type SecureString --key-id "$KEY_ARN" --overwrite \
    --name "$PARKED_PARAM" --value "$PW" >/dev/null
  unset PW
  echo "Parked the first admin's temporary password at ${PARKED_PARAM}"
}

# Step 1: the shared identity parameters; all three before any write (M-R-11).
read_identity_param apiUrl API_URL
read_identity_param topology TOPOLOGY
read_identity_param adminPasswordKeyArn KEY_ARN

# Step 2 (M-R-7).
refuse_tiered "$TOPOLOGY"

# Step 3: what does tenant-identity already hold for this id?
get_tenant_status() {
  platform_call GET 'platform/tenants/{tenantId}'
  case "$PLATFORM_STATUS" in
    200) TENANT_STATUS="$(jq -r '.tenant.status // empty' <<<"$PLATFORM_BODY")" ;;
    404) TENANT_STATUS=ABSENT ;;
    *) fail "GetTenant for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
  esac
}

check_tenant_status() {
  case "$TENANT_STATUS" in
    ACTIVE | ABSENT) ;;
    PROVISIONING) fail "tenant ${TENANT_ID} is PROVISIONING (a concurrent or crashed create); re-run later" ;;
    DELETING) fail "tenant is being offboarded" ;;
    *) fail "tenant ${TENANT_ID} has unexpected status '${TENANT_STATUS}'" ;;
  esac
}

get_tenant_status
check_tenant_status

if [[ "$TENANT_STATUS" == ABSENT ]]; then
  # Step 4: create it under the control plane's id (ADR-0029).
  platform_call POST platform/tenants \
    "$(jq -nc --arg t "$TENANT_ID" --arg n "$TENANT_NAME" --arg e "$ADMIN_EMAIL" \
      '{tenantId: $t, name: $n, adminEmail: $e}')"
  case "$PLATFORM_STATUS" in
    201)
      # M-R-10: the park is the very next call after the 201.
      PW="$(jq -r '.admin.temporaryPassword // empty' <<<"$PLATFORM_BODY")"
      [[ -n "$PW" ]] || fail "CreateTenant returned no temporary password to park"
      park_password
      echo "Tenant ${TENANT_ID} identity onboarded"
      exit 0
      ;;
    409)
      # A racing create won; look once more, then fail if not ACTIVE.
      echo "Tenant ${TENANT_ID} was created concurrently; re-reading"
      get_tenant_status
      [[ "$TENANT_STATUS" == ACTIVE ]] \
        || fail "tenant ${TENANT_ID} is '${TENANT_STATUS}' after a concurrent create; re-run later"
      ;;
    *) fail "CreateTenant for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
  esac
fi

# Step 5 (M-R-6): the tenant is ACTIVE. Claim the first-admin slot; the
# conditional write decides, not a read of the user list (ADR-0032).
platform_call POST 'platform/tenants/{tenantId}/users' \
  "$(jq -nc --arg e "$ADMIN_EMAIL" '{email: $e, firstAdmin: true}')"
case "$PLATFORM_STATUS" in
  201)
    PW="$(jq -r '.temporaryPassword // empty' <<<"$PLATFORM_BODY")"
    if [[ -n "$PW" ]]; then
      park_password
    else
      # The user already existed in a shared pool (added as a member, no new
      # Cognito user): there is no new password and nothing to park.
      echo "First admin claimed for tenant ${TENANT_ID}; no temporary password returned, nothing to park"
    fi
    ;;
  409) echo "Tenant ${TENANT_ID} already has its first admin; nothing to do" ;;
  *) fail "CreateUser (firstAdmin) for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
esac

echo "Tenant ${TENANT_ID} identity onboarded"
