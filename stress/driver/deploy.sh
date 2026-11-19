#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the stress driver host, <STRESS_PREFIX>-driver (stress ADR-0009), and prints its
# outputs (InstanceId, ResultsBucketName) and the deploy time.
#
#   AWS_REGION=eu-central-1 STRESS_PREFIX=<letters and digits> [STRESS_TIER=small|medium|large] \
#     [STRESS_PARAMETER_PREFIXES=/path/a/,/path/b/] stress/driver/deploy.sh
#
# STRESS_TIER picks the instance type from stress/src/tiers.ts (default small).
# STRESS_PARAMETER_PREFIXES lists SSM parameter paths the host may read besides
# tenant-identity's. Prints `stack=<name> deploy_seconds=<n>`, then the outputs as JSON.
# The synthesised app goes to stress/cdk.driver.out (not committed).

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region to deploy in}"
: "${STRESS_PREFIX:?Set STRESS_PREFIX (1 to 40 letters and digits, starting with a letter)}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent
export STRESS_TIER="${STRESS_TIER:-small}"
STACK="${STRESS_PREFIX}-driver"
OUT="cdk.driver.out"
OUTPUTS="$(mktemp)"
trap 'rm -f "$OUTPUTS"' EXIT

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only driver/app.ts" deploy "$STACK" \
  --output "$OUT" --exclusively --require-approval never --outputs-file "$OUTPUTS" >&2
echo "stack=${STACK} deploy_seconds=$((SECONDS - start))"
jq --arg s "$STACK" '.[$s]' "$OUTPUTS"
