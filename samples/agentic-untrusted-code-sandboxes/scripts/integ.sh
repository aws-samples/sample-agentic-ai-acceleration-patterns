#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec section 8, ADR-0008, ADR-0058).
#
#   AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ      # or: scripts/integ.sh
#
# This script only calls the driver by name. The driver (test/integ/driver.ts)
# deploys the integration app with the CDK CLI, runs every step of
# integration-test.md, deletes the stack through the CloudFormation API from
# its own `finally` and signal handlers, and checks what is left. The exit
# trap below runs the driver's `cleanup` once more, for a driver that was
# killed before it could: it does nothing when the last run finished its
# teardown. The script never destroys a stack itself (integration-test.md,
# "After an interruption" names the one line to run by hand).
#
# Environment: AWS_REGION (required, one Region), INTEG_PREFIX,
# INTEG_DEPLOY_CONCURRENCY, INTEG_STATE_DIR. Conventions: scripts/CONVENTIONS.md
# (nothing the driver prints or records holds a token, nonce or credential).
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the single Region to test in (for example export AWS_REGION=eu-central-1)}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws node npx docker npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."
DRIVER=(npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ/driver.ts)

cleanup() {
  local status=$?
  trap - EXIT
  "${DRIVER[@]}" cleanup || status=1
  exit "$status"
}
trap cleanup EXIT

"${DRIVER[@]}" run
