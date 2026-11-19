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
# Knobs:
#   INTEG_STACK_NAME                 stack name (default TenantUsageMetering)
#   INTEG_FLEET                      the demo stack's fleetName (default demo)
#   INTEG_INGEST_PATH                BUS or DIRECT (default BUS)
#   INTEG_PUBLISH_SERVICE_PARAMETER  true or false: write the published
#                                    parameter (default true; false for a
#                                    second stack in the same account)
#   INTEG_LATE_GRACE_MINUTES         the demo stack's lateGraceMinutes (default 6)
#   INTEG_KEEP_STACK=1               skips the destroy
#
# A DIRECT run beside a BUS stack:
#
#   INTEG_STACK_NAME=TenantUsageMeteringDirect INTEG_FLEET=demo2 \
#     INTEG_INGEST_PATH=DIRECT INTEG_PUBLISH_SERVICE_PARAMETER=false \
#     AWS_REGION=eu-central-1 npx projen integ

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
stack="${INTEG_STACK_NAME:-TenantUsageMetering}"
fleet="${INTEG_FLEET:-demo}"
ingest_path="${INTEG_INGEST_PATH:-BUS}"
publish="${INTEG_PUBLISH_SERVICE_PARAMETER:-true}"
if [[ "$ingest_path" != BUS && "$ingest_path" != DIRECT ]]; then
  echo "INTEG_INGEST_PATH must be BUS or DIRECT, got '$ingest_path'" >&2
  exit 2
fi
if [[ "$publish" != true && "$publish" != false ]]; then
  echo "INTEG_PUBLISH_SERVICE_PARAMETER must be true or false, got '$publish'" >&2
  exit 2
fi
out="cdk.integ.out/${stack}"
grace="${INTEG_LATE_GRACE_MINUTES:-6}"
mkdir -p "$out"
context=(-c "stackName=${stack}" -c "fleetName=${fleet}" -c "ingestPath=${ingest_path}" -c "publishServiceParameter=${publish}"
  -c integLocalCell=true -c integHttpReceiver=true -c "lateGraceMinutes=${grace}")

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
test_rc=$?

# The deployment-role exemption of the bucket configuration denies (spec
# §3.5): a stack update that changes the raw bucket's lifecycle must pass.
t0=$(date +%s)
if npx cdk deploy "$stack" --require-approval never "${context[@]}" -c rawRetentionDays=401 --output "$out/assembly"; then
  echo "PASS a stack update changes the raw bucket lifecycle through the configuration deny ($(( $(date +%s) - t0 )) s)"
else
  echo "FAIL a stack update changes the raw bucket lifecycle through the configuration deny"
  test_rc=1
fi
exit "$test_rc"
