#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane cell DELETE script for tenant-identity (ADR-0028, mounting
# spec §7.4). Runs in the control-plane cell CodeBuild project with CELL_ID,
# OPERATION, OPERATOR_ID, AWS_REGION.
#
# An explicit no-op (control-plane P-9): the identity deployment is shared by
# every cell in the account and owned by the tenant-identity stack, so
# deleting a cell removes nothing from it. Tenants were offboarded one by one
# through tenant/delete.sh before the cell could be deleted.
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"
: "${OPERATION:?OPERATION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"

echo "No-op ${OPERATION} for cell ${CELL_ID} (operator ${OPERATOR_ID}): the shared identity deployment is not a cell resource"
