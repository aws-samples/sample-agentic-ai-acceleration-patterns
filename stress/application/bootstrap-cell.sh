#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runs the cell bootstrap (spec §8, decision 7; README, step 2) for the caller's account:
#
#   cdk bootstrap aws://<account>/<region> --qualifier cell --toolkit-stack-name CDKToolkit-cell \
#     --cloudformation-execution-policies <cell execution policy ARN> \
#     --custom-permissions-boundary <cell permissions boundary name>
#
# Run it as the cell account's owner after deploy-owner.sh, and again after the policy names
# change (CELL_POLICY_SUFFIX): it updates CDKToolkit-cell in place.
#
#   AWS_REGION=eu-central-1 [CELL_POLICY_SUFFIX=-v2] stress/application/bootstrap-cell.sh
#
# It refuses to run when the policies are missing, and runs the CDK from an empty folder so
# no cdk.json can change the bootstrap. Prints `stack=CDKToolkit-cell bootstrap_seconds=<n>`.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
suffix="${CELL_POLICY_SUFFIX:-}"
[[ "$suffix" =~ ^(-[a-z0-9]{1,16})?$ ]] || { echo "CELL_POLICY_SUFFIX must be empty or - and 1 to 16 lower-case letters or digits" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRESS="$(cd "${HERE}/.." && pwd)"
[[ -d "${STRESS}/node_modules" ]] || (cd "$STRESS" && npm ci --silent)
CDK="${STRESS}/node_modules/.bin/cdk"

caller="$(aws sts get-caller-identity --query Arn --output text)"
account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 1; }
partition="${caller#arn:}"; partition="${partition%%:*}"
echo "account=${account} region=${AWS_REGION}"

execution="arn:${partition}:iam::${account}:policy/cell-execution-policy${suffix}"
boundary="cell-permissions-boundary${suffix}"
for arn in "$execution" "arn:${partition}:iam::${account}:policy/${boundary}" "arn:${partition}:iam::${account}:policy/cell-workload-boundary${suffix}"; do
  aws iam get-policy --policy-arn "$arn" --query Policy.PolicyName --output text >/dev/null \
    || { echo "missing ${arn}: run deploy-owner.sh first" >&2; exit 1; }
done

empty="$(mktemp -d)"
trap 'rmdir "$empty" 2>/dev/null || true' EXIT
cd "$empty"
start=$SECONDS
"$CDK" bootstrap "aws://${account}/${AWS_REGION}" --qualifier cell --toolkit-stack-name CDKToolkit-cell \
  --cloudformation-execution-policies "$execution" --custom-permissions-boundary "$boundary" >&2
echo "stack=CDKToolkit-cell bootstrap_seconds=$((SECONDS - start))"
