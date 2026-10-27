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
EMAIL_IN_USE="ADMIN_EMAIL is probably already in use in the shared pool"

# Step 6: park PW as a SecureString under AdminPasswordKey (M-R-11), output to
# /dev/null, then forget it. The password never goes on argv: it is written to
# the mode-0600 request file and the CLI reads it through file://. A transient
# SSM or KMS error is retried (three attempts) because a failed park loses the
# password for good (spec §9 gap 1). Logs the parameter name only.
park_password() {
  local attempt rc=0
  printf '%s' "$PW" >"$PLATFORM_REQUEST_FILE"
  unset PW
  for attempt in 1 2 3; do
    rc=0
    aws ssm put-parameter --type SecureString --key-id "$KEY_ARN" --overwrite \
      --name "$PARKED_PARAM" --value "file://${PLATFORM_REQUEST_FILE}" >/dev/null 2>"$PLATFORM_ERR_FILE" || rc=$?
    [[ "$rc" -ne 0 ]] || break
    echo "put-parameter ${PARKED_PARAM} failed ($(aws_error_class "$PLATFORM_ERR_FILE")), attempt ${attempt} of 3" >&2
    [[ "$attempt" -eq 3 ]] || sleep "$attempt"
  done
  : >"$PLATFORM_REQUEST_FILE"
  : >"$PLATFORM_ERR_FILE"
  [[ "$rc" -eq 0 ]] || fail "put-parameter ${PARKED_PARAM} failed after 3 attempts; the temporary password is lost, recover per spec §8"
  echo "Parked the first admin's temporary password at ${PARKED_PARAM}"
}

# take_password JQ_PATH -> PW from PLATFORM_BODY, then drop the body so the
# password lives in exactly one variable until the park.
take_password() {
  PW="$(jq -r "$1 // empty" <<<"$PLATFORM_BODY")"
  unset PLATFORM_BODY
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

# M2: a step-5 409 says the slot is held, or that the e-mail is taken in the
# shared pool (tenant-identity releases the slot and returns the same 409).
# Follow the user list and require an admin before calling it success. A read
# AFTER the conditional write does not contradict ADR-0032.
tenant_has_admin() {
  local token="" page=0 admins
  while :; do
    platform_call GET 'platform/tenants/{tenantId}/users' '' "$token"
    [[ "$PLATFORM_STATUS" == 200 ]] || fail "ListUsers for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}"
    admins="$(jq -r '[.users[]? | select(.admin == true)] | length' <<<"$PLATFORM_BODY")"
    [[ "$admins" -eq 0 ]] || return 0
    token="$(jq -r '(.nextToken // empty) | @uri' <<<"$PLATFORM_BODY")"
    [[ -n "$token" ]] || return 1
    token="nextToken=${token}"
    page=$((page + 1))
    [[ "$page" -lt 50 ]] || fail "ListUsers for ${TENANT_ID} did not end after 50 pages"
  done
}

# m2: the slot is held, so a password was parked once. Say so loudly when the
# parameter is gone (a build killed between the 201 and the park, or a park
# that failed). No --with-decryption: the version is enough and needs no KMS.
check_parked_password() {
  local class
  if aws ssm get-parameter --name "$PARKED_PARAM" --query Parameter.Version --output text >/dev/null 2>"$PLATFORM_ERR_FILE"; then
    echo "Parked password present at ${PARKED_PARAM}"
    return 0
  fi
  class="$(aws_error_class "$PLATFORM_ERR_FILE")"
  : >"$PLATFORM_ERR_FILE"
  if [[ "$class" == ParameterNotFound ]]; then
    echo "WARNING: tenant ${TENANT_ID} has its first admin but no parked password at ${PARKED_PARAM}; the vendor has no credential. Recover per mounting spec §8 (DeleteUser releases the slot, then CreateUser {firstAdmin: true}, or control-plane DeleteTenant + CreateTenant)" >&2
  else
    echo "WARNING: could not verify the parked password at ${PARKED_PARAM} (${class})" >&2
  fi
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
      take_password '.admin.temporaryPassword'
      [[ -n "$PW" ]] || fail "CreateTenant returned no temporary password to park"
      park_password
      echo "Tenant ${TENANT_ID} identity onboarded"
      exit 0
      ;;
    409)
      # Either a racing create won, or (shared pool) the e-mail is already
      # taken and nothing was written. Look once more to tell them apart.
      echo "CreateTenant for ${TENANT_ID} refused (HTTP 409); re-reading"
      get_tenant_status
      case "$TENANT_STATUS" in
        ACTIVE) ;;
        ABSENT) fail "CreateTenant refused (HTTP 409) and tenant ${TENANT_ID} does not exist: ${EMAIL_IN_USE}" ;;
        PROVISIONING) fail "tenant ${TENANT_ID} is PROVISIONING after a concurrent create; re-run later" ;;
        *) fail "tenant ${TENANT_ID} is '${TENANT_STATUS}' after a concurrent create" ;;
      esac
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
    take_password '.temporaryPassword'
    if [[ -n "$PW" ]]; then
      park_password
    else
      # The user already existed in a shared pool (added as a member, no new
      # Cognito user): there is no new password and nothing to park.
      echo "First admin claimed for tenant ${TENANT_ID}; no temporary password returned, nothing to park"
    fi
    ;;
  409)
    tenant_has_admin \
      || fail "first-admin slot for ${TENANT_ID} refused (HTTP 409) and no admin exists: ${EMAIL_IN_USE}"
    echo "Tenant ${TENANT_ID} already has its first admin; nothing to do"
    check_parked_password
    ;;
  *) fail "CreateUser (firstAdmin) for ${TENANT_ID} returned HTTP ${PLATFORM_STATUS}" ;;
esac

echo "Tenant ${TENANT_ID} identity onboarded"
