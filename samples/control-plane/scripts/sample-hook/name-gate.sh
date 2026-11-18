#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample NAME GATE hook (ADR-045).
#
# Register it as a global PRE hook on TENANT_CREATE and TENANT_UPDATE. It
# refuses a tenant name outside a house rule (letters, digits, spaces and
# ". _ -", 1 to 64 characters). A PRE hook that exits non-zero stops the
# operation before the record is committed: a create ends CREATE_FAILED and
# an update ends UPDATE_FAILED with the old name still in force, and
# statusReason names this hook. Replace the rule with your own check, for
# example a lookup in a CRM or a sanctions list.
#
# It needs no permission beyond the hook role's own logs.
set -euo pipefail

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${TENANT_ID:?TENANT_ID env var is required}"
# TENANT_NAME is operator-supplied free text: expand it quoted, match it
# with a regex, never print it (scripts/CONVENTIONS.md).
: "${TENANT_NAME?TENANT_NAME env var is required}"

case "$EVENT" in
  TENANT_CREATE|TENANT_UPDATE) ;;
  *) echo "name-gate runs on TENANT_CREATE and TENANT_UPDATE only, got ${EVENT}"; exit 1 ;;
esac
if [ "$PHASE" != "PRE" ]; then
  echo "name-gate is a PRE hook, got ${PHASE}"
  exit 1
fi

if [[ ! "$TENANT_NAME" =~ ^[A-Za-z0-9._\ -]{1,64}$ ]]; then
  echo "Tenant ${TENANT_ID}: name refused by name-gate"
  exit 1
fi
echo "Tenant ${TENANT_ID}: name accepted"
