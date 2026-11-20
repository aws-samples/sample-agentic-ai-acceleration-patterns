#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Read-only leftover check of the integration test (spec section 8, teardown).
#
#   AWS_PROFILE=<profile> AWS_REGION=eu-central-1 scripts/leftovers.sh
#
# Lists the stacks, log groups, task definitions, clusters and container
# instances, MicroVMs, runtimes, VPCs and endpoints, DNS Firewall resources
# and Logs resource policies a run left in the account and Region. It deletes
# nothing. With no state file of a run on this machine it lists only the
# stacks that carry INTEG_PREFIX. Exit status 1 when something is left; the
# one known leftover (a statement in a shared Logs resource policy, spec
# section 3.9) is listed and does not count.
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the single Region that was tested (for example export AWS_REGION=eu-central-1)}"
export AWS_DEFAULT_REGION="$AWS_REGION"
command -v npx >/dev/null 2>&1 || { echo "Missing required tool: npx" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ/driver.ts leftovers
