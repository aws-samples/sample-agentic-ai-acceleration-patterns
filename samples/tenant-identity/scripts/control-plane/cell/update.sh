#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# control-plane cell UPDATE script for tenant-identity (ADR-0028, mounting
# spec §7.4). Runs in the control-plane cell CodeBuild project with CELL_ID,
# OPERATION, OPERATOR_ID, AWS_REGION.
#
# Same check as create.sh: the account's identity deployment is published and
# not tiered. UpdateCell is also the recovery path after deploying
# tenant-identity into an account where the cell failed to create (spec §8).
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"
: "${OPERATION:?OPERATION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

echo "Re-checking the identity deployment for cell ${CELL_ID} (${OPERATION}, operator ${OPERATOR_ID})"

read_identity_param apiUrl API_URL
read_identity_param topology TOPOLOGY
refuse_tiered "$TOPOLOGY"

echo "Cell ${CELL_ID} can use the ${TOPOLOGY} identity deployment"
