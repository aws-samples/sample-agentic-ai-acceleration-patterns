#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Integration-test tenant CREATE script for application Z (spec section 10 step
# 16). TEST ONLY. It writes a script output (R-43) and then runs the sample
# tenant create script unchanged, so Z provisions exactly what X and Y do.
#
# The output is written with a space after the colon on purpose: the buildspec
# exports its own compact re-serialisation, and the test reads that back from
# the post hook's SCRIPT_OUTPUTS.
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${OUTPUTS_FILE:?OUTPUTS_FILE env var is required}"

printf '{"endpoint": "%s.example.com"}\n' "${TENANT_ID}" > "${OUTPUTS_FILE}"
echo "Wrote the script outputs file"

exec bash "$(dirname "${BASH_SOURCE[0]}")/../sample-tenant/create.sh"
