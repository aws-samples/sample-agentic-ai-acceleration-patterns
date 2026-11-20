#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the two probe stacks probes.sh runs against (README, "Probe the policies"):
# CellBoundaryProbe as an owner stack, then CellWorkloadProbe through the cell bootstrap.
# Run as the cell account's owner after bootstrap-cell.sh; remove them with probe-remove.sh.
#
#   AWS_REGION=eu-central-1 [CELL_POLICY_SUFFIX=-v2] stress/application/probe-deploy.sh

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent

account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 1; }
echo "account=${account} region=${AWS_REGION}"

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only application/owner-app.ts" deploy CellBoundaryProbe \
  --output cdk.application.out/owner --exclusively --require-approval never >&2
echo "stack=CellBoundaryProbe deploy_seconds=$((SECONDS - start))"

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only application/probe-app.ts" deploy CellWorkloadProbe \
  --output cdk.application.out/probe --toolkit-stack-name CDKToolkit-cell --require-approval never >&2
echo "stack=CellWorkloadProbe deploy_seconds=$((SECONDS - start))"
