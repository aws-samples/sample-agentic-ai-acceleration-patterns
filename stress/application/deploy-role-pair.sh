#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the control-plane role pair of a cell account (README, step 4; spec §3.7; stress
# ADR-0012): control-plane's CellAccountStack, `<fleet>-cell-account`, as plain CloudFormation
# with the caller's credentials, no service role and no CDK bootstrap. The cell role gets
# cell-build-policy, the tenant role cell-tenant-build-policy. Run it as the cell account's
# owner, in the cell account, after deploy-owner.sh and bootstrap-cell.sh:
#
#   AWS_REGION=eu-central-1 STRESS_FLEET_NAME=<fleet> CONTROL_PLANE_ACCOUNT_ID=<platform account> \
#     [CELL_POLICY_SUFFIX=-v2] stress/application/deploy-role-pair.sh
#
# The fleet name is the control-plane slice's STRESS_PREFIX in lower case. Prints the caller's
# account, then `stack=<fleet>-cell-account deploy_seconds=<n>`.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
: "${STRESS_FLEET_NAME:?Set STRESS_FLEET_NAME to the control plane fleet name}"
: "${CONTROL_PLANE_ACCOUNT_ID:?Set CONTROL_PLANE_ACCOUNT_ID to the platform account id}"
export AWS_DEFAULT_REGION="$AWS_REGION" STRESS_FLEET_NAME CONTROL_PLANE_ACCOUNT_ID
[[ "$STRESS_FLEET_NAME" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "STRESS_FLEET_NAME must match ^[a-z0-9][a-z0-9-]{0,31}\$" >&2; exit 1; }
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRESS="$(cd "${HERE}/.." && pwd)"
CONTROL_PLANE="$(cd "${STRESS}/../samples/control-plane" && pwd)"
[[ -d "${STRESS}/node_modules" ]] || (cd "$STRESS" && npm ci --silent)
# The stack is control-plane's own, built from that sample's CDK (role-pair-app.ts).
[[ -d "${CONTROL_PLANE}/node_modules" ]] || (cd "$CONTROL_PLANE" && npm ci --silent)

account="$(aws sts get-caller-identity --query Account --output text)"
echo "account=${account} region=${AWS_REGION}"
[[ "$account" != "$CONTROL_PLANE_ACCOUNT_ID" ]] || { echo "this is the platform account, not a cell account" >&2; exit 1; }

stack="${STRESS_FLEET_NAME}-cell-account"
cd "$STRESS"
start=$SECONDS
npx cdk --app "npx ts-node --transpile-only application/role-pair-app.ts" deploy "$stack" \
  --output cdk.application.out/role-pair --exclusively --require-approval never >&2
echo "stack=${stack} deploy_seconds=$((SECONDS - start))"
