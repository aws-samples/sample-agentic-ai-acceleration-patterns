#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane cell CREATE script for tenant-identity (ADR-0028, mounting
# spec §7.4). Runs in the control-plane cell CodeBuild project with CELL_ID,
# OPERATION, OPERATOR_ID, AWS_REGION.
#
# tenant-identity is account-level shared infrastructure (its ADR-0017), not a
# cell's shared deployment, so a cell provisions nothing for identity. It only
# checks that a usable identity deployment exists in this account and Region:
# apiUrl and topology are published, and the topology is not tiered (M-R-7).
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"
: "${OPERATION:?OPERATION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

echo "Checking the identity deployment for cell ${CELL_ID} (${OPERATION}, operator ${OPERATOR_ID})"

read_identity_param apiUrl API_URL
read_identity_param topology TOPOLOGY
refuse_tiered "$TOPOLOGY"

echo "Cell ${CELL_ID} can use the ${TOPOLOGY} identity deployment"
