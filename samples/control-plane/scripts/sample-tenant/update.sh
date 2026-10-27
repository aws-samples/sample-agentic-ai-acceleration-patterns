#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample tenant UPDATE script.
#
# Runs in AWS CodeBuild with: TENANT_ID, TENANT_NAME, CELL_ID, OPERATION,
# OPERATOR_ID. Re-applies the per-tenant deployment - a real script would
# re-run its IaC deployment here. Idempotent by design.
# TENANT_NAME is operator-supplied free text: expand it quoted only, never
# eval or use as an identifier (see scripts/CONVENTIONS.md).
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"

echo "Re-applying tenant ${TENANT_ID} in cell ${CELL_ID}"

# Cell-published shared resources are re-resolved on every deploy - a changed
# cell value (e.g. after an UpdateCell build) takes effect on the next tenant
# update build with no control plane change (ADR-010).
CELL_SHARED_ENDPOINT=$(aws ssm get-parameter \
  --name "/application-plane/cells/${CELL_ID}/shared-endpoint" \
  --query Parameter.Value --output text)

EXISTING=$(aws ssm get-parameter \
  --name "/application-plane/tenants/${TENANT_ID}" \
  --query Parameter.Value --output text)
ADMIN_USER=$(echo "${EXISTING}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["adminUser"])')

# Build the JSON with a real encoder (an e-mail may hold a quote) and hand it
# to the CLI through a 0600 file, so the e-mail never reaches argv.
VALUE_FILE=$(mktemp)
chmod 600 "$VALUE_FILE"
trap 'rm -f "$VALUE_FILE"' EXIT
ENDPOINT="${TENANT_ID}.${CELL_SHARED_ENDPOINT}" ADMIN_USER_VALUE="${ADMIN_USER}" \
  python3 -c 'import json,os; print(json.dumps({"endpoint": os.environ["ENDPOINT"], "cellId": os.environ["CELL_ID"], "adminUser": os.environ["ADMIN_USER_VALUE"], "provisionedBy": "update.sh"}, separators=(",", ":")))' \
  > "$VALUE_FILE"
aws ssm put-parameter \
  --name "/application-plane/tenants/${TENANT_ID}" \
  --type String \
  --overwrite \
  --value "file://$VALUE_FILE"
# Log the parameter NAME, never its VALUE - build logs are readable by
# anyone with log-group access (see scripts/CONVENTIONS.md).
echo "Wrote /application-plane/tenants/${TENANT_ID}"

echo "Tenant ${TENANT_ID} in cell ${CELL_ID} re-applied"
