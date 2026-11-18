#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The integration test (integration-test.md): deploys the demo stack with a
# local test cell, runs test/integ.metering.ts against it, and destroys the
# stack from an exit trap, so the destroy also runs when a step fails.
#
#   AWS_REGION=eu-central-1 npx projen integ
#
# Knobs: INTEG_KEEP_STACK=1 skips the destroy; INTEG_LATE_GRACE_MINUTES
# (default 6) is the demo stack's lateGraceMinutes.

set -uo pipefail

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is not set: the integration test runs in exactly one Region" >&2
  exit 2
fi
export CDK_DEFAULT_REGION="$AWS_REGION"
CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_ACCOUNT

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
stack=TenantUsageMetering
out="cdk.integ.out"
grace="${INTEG_LATE_GRACE_MINUTES:-6}"
mkdir -p "$out"
context=(-c integLocalCell=true -c "lateGraceMinutes=${grace}")

teardown() {
  if [[ "${INTEG_KEEP_STACK:-0}" == 1 ]]; then
    echo "INTEG_KEEP_STACK=1: leaving $stack in place"
    return
  fi
  local t0
  t0=$(date +%s)
  npx cdk destroy "$stack" --force "${context[@]}" --output "$out/assembly"
  echo "destroy: $(( $(date +%s) - t0 )) s"
}
trap teardown EXIT

t0=$(date +%s)
npx cdk deploy "$stack" --require-approval never "${context[@]}" --output "$out/assembly" --outputs-file "$out/outputs.json" || exit 1
echo "deploy: $(( $(date +%s) - t0 )) s"

LATE_GRACE_MINUTES="$grace" npx ts-node --transpile-only test/integ.metering.ts "$out/outputs.json"
