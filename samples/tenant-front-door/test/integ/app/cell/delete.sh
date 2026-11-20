#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# The integration test's demo application, cell DELETE script. TEST ONLY.
# The cell's origin is the test's own stack, which the test destroys; the
# script removes what the update script may have recorded.
set -euo pipefail
: "${CELL_ID:?CELL_ID env var is required}"
aws ssm delete-parameter --name "/application-plane/cells/${CELL_ID}/registrar-probe" >/dev/null 2>&1 || true
echo "Cell ${CELL_ID} removed"
