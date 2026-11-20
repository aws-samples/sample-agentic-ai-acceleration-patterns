#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Every script of step 19's demo-plain application, which has no front
# door: it provisions nothing and writes no outputs (spec §10 step 19).
# TEST ONLY.
set -euo pipefail
echo "demo-plain ${OPERATION:-} for ${APPLICATION_ID:-} ${CELL_ID:-} ${TENANT_ID:-}"
