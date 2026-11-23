#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the observability sink of the run dashboard (stress ADR-0022) in the platform account,
# once per Region, and prints its ARN. Run it as the platform account's owner, then pass the ARN
# to each cell account's `stress/application/deploy-owner.sh` as OBSERVABILITY_SINK_ARN.
#
#   AWS_REGION=<the run's Region> STRESS_CELL_ACCOUNTS=<cell accounts file> stress/dashboard/deploy-sink.sh
#
# The sink's policy names the account ids of the cell accounts file, and allows only metric links.
# Deploy it again after a cell account is added. Prints `stack=StressRunSink deploy_seconds=<n>`
# and `SinkArn=<arn>`. The synthesised app goes to stress/cdk.dashboard.sink.out (not committed).

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region of the run}"
: "${STRESS_CELL_ACCOUNTS:?Set STRESS_CELL_ACCOUNTS to the cell accounts file}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent
echo "account=$(aws sts get-caller-identity --query Account --output text) region=${AWS_REGION}"

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only dashboard/sink-app.ts" deploy StressRunSink \
  --output cdk.dashboard.sink.out --exclusively --no-version-reporting --require-approval never >&2
echo "stack=StressRunSink deploy_seconds=$((SECONDS - start))"
echo "SinkArn=$(aws cloudformation describe-stacks --stack-name StressRunSink --query 'Stacks[0].Outputs[?OutputKey==`SinkArn`].OutputValue' --output text)"
