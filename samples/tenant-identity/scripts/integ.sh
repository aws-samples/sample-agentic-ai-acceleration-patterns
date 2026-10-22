#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §10, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# Synthesises test/integ.identity.ts (one stack per topology), deploys the
# three stacks at once, runs the spec §10 scenario against them, then destroys
# them at once. The destroy always runs, also when the deploy or the scenario
# fails, and the script exits non-zero if any step failed. The CDK CLI drives
# the run, not integ-runner, because integ-runner deploys and destroys a
# test's stacks one at a time (ADR-0023).
#
# Runs in exactly one Region: AWS_REGION must be set. Deploys into the account
# of the ambient AWS credentials, which must be CDK-bootstrapped there.

set -euo pipefail

if [ -z "${AWS_REGION:-}" ]; then
  echo "Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)" >&2
  exit 1
fi
export AWS_DEFAULT_REGION="$AWS_REGION"

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAMPLE_DIR"

# A separate cloud assembly, so the run never mixes with `cdk.out/` from a
# build, and the deploy and the destroy see exactly the same templates.
OUT="cdk.integ.out"
CDK=(npx cdk --app "$OUT")

destroy() {
  local status=$?
  trap - EXIT
  echo "=== destroy ($(date -u +%H:%M:%S) UTC)"
  if ! "${CDK[@]}" destroy --all --force --concurrency 3; then
    echo "Destroy failed: run 'AWS_REGION=$AWS_REGION ${CDK[*]} destroy --all --force --concurrency 3' again" >&2
    status=1
  fi
  echo "=== done ($(date -u +%H:%M:%S) UTC), exit $status"
  exit "$status"
}

echo "=== synth ($(date -u +%H:%M:%S) UTC)"
rm -rf "$OUT"
npx cdk synth --quiet --output "$OUT" \
  --app "npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ.identity.ts"

# From here on, whatever happens, the stacks are destroyed.
trap destroy EXIT

echo "=== deploy ($(date -u +%H:%M:%S) UTC)"
"${CDK[@]}" deploy --all --concurrency 3 --require-approval never --progress events

echo "=== e2e ($(date -u +%H:%M:%S) UTC)"
npx jest --config test/e2e/jest.config.json --runInBand=false
