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
# The host reads the stress identity, /<STRESS_PREFIX>/identity; STRESS_PARAMETER_PREFIXES
# lists further SSM parameter paths it may read. Prints `stack=<name> deploy_seconds=<n>`,
# waits until the host runs k6, prints `stack=<name> ready_seconds=<n>`, then the outputs as JSON.
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

# CloudFormation is done when the instance runs, not when its user data has installed k6, and
# the SSM Agent registers a few seconds after that. Wait for both, so the next call can use
# the host: the agent online (at most 5 minutes), then cloud-init finished and k6 present.
INSTANCE="$(jq -r --arg s "$STACK" '.[$s].InstanceId' "$OUTPUTS")"
ready_start=$SECONDS
POLL_ERR="$(mktemp)"
trap 'rm -f "$OUTPUTS" "$POLL_ERR"' EXIT
until [[ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=${INSTANCE}" \
  --query 'InstanceInformationList[0].PingStatus' --output text 2>"$POLL_ERR")" == Online ]]; do
  if (( SECONDS - ready_start >= 300 )); then
    echo "the SSM Agent on ${INSTANCE} did not come online in 5 minutes" >&2
    [[ ! -s "$POLL_ERR" ]] || { echo "last error from describe-instance-information:" >&2; tail -3 "$POLL_ERR" >&2; }
    exit 1
  fi
  sleep 10
done
HOST_TIMEOUT=900 "${HERE}/host.sh" 'cloud-init status --wait >/dev/null 2>&1; k6 version' >&2 \
  || { echo "the host did not finish its user data with k6 installed" >&2; exit 1; }
echo "stack=${STACK} ready_seconds=$((SECONDS - ready_start))"
jq --arg s "$STACK" '.[$s]' "$OUTPUTS"
