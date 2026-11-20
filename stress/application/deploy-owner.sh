#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the cell account owner's stacks, CellPolicies and CellAccountBase (README, step 1),
# with the caller's credentials and no CDK bootstrap (legacy synthesizer). Run it as the
# cell account's owner, in the cell account:
#
#   AWS_REGION=eu-central-1 [CELL_POLICY_SUFFIX=-v2] \
#     [CELL_USER_POOL_ID=<pool id> CELL_APP_CLIENT_ID=<client id>] stress/application/deploy-owner.sh
#
# Prints the caller's account, then `stacks=... deploy_seconds=<n>`. The synthesised app goes
# to stress/cdk.application.out (not committed).

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
echo "account=${account} region=${AWS_REGION}"

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only application/owner-app.ts" deploy CellPolicies CellAccountBase \
  --output cdk.application.out/owner --exclusively --require-approval never >&2
echo "stacks=CellPolicies,CellAccountBase deploy_seconds=$((SECONDS - start))"
