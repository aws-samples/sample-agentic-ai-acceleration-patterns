#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deploys the cell account owner's stacks, CellPolicies and CellAccountBase (README, step 1),
# with the caller's credentials and no CDK bootstrap (legacy synthesizer). Run it as the
# cell account's owner, in the cell account:
#
#   AWS_REGION=eu-central-1 [CELL_POLICY_SUFFIX=-v2] \
#     [CELL_USER_POOL_ID=<pool id> CELL_APP_CLIENT_ID=<client id>] \
#     [PLATFORM_ACCOUNT_ID=<platform account id>] [CELL_OWNER_STACKS=base] \
#     stress/application/deploy-owner.sh
#
# PLATFORM_ACCOUNT_ID (a platform run) adds the ingress reader role, which that account may
# assume, to CellAccountBase. CELL_OWNER_STACKS=base deploys CellAccountBase alone: the second
# Region of an account that already has the policies (their names are account-wide).
#
# Prints the caller's account, then `stacks=... deploy_seconds=<n>`, and the base stack's
# IngressReaderRoleArn when it has one. The synthesised app goes to stress/cdk.application.out
# (not committed).

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

stacks=(CellPolicies CellAccountBase)
case "${CELL_OWNER_STACKS:-}" in
  '') ;;
  base) stacks=(CellAccountBase) ;;
  *) echo "CELL_OWNER_STACKS must be empty or base" >&2; exit 1 ;;
esac
[[ -z "${PLATFORM_ACCOUNT_ID:-}" || "${PLATFORM_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || { echo "PLATFORM_ACCOUNT_ID must be a 12-digit account id" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent

account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 1; }
echo "account=${account} region=${AWS_REGION}"

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only application/owner-app.ts" deploy "${stacks[@]}" \
  --output cdk.application.out/owner --exclusively --require-approval never >&2
# IFS is set inside the command substitution's subshell only, to join the stack names with commas.
# nosemgrep: bash.lang.security.ifs-tampering.ifs-tampering
echo "stacks=$(IFS=,; echo "${stacks[*]}") deploy_seconds=$((SECONDS - start))"
if [[ -n "${PLATFORM_ACCOUNT_ID:-}" ]]; then
  echo "IngressReaderRoleArn=$(aws cloudformation describe-stacks --stack-name CellAccountBase --query 'Stacks[0].Outputs[?OutputKey==`IngressReaderRoleArn`].OutputValue' --output text)"
fi
