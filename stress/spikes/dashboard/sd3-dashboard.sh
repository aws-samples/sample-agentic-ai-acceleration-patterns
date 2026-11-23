#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Spike SD-3: deploy and remove the one-dashboard stack and print the seconds of each.
#   PLATFORM_PROFILE=pg CELL_ACCOUNT=<12 digits> AWS_REGION=eu-central-1 sd3-dashboard.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PLATFORM_PROFILE:?}" "${CELL_ACCOUNT:?}" "${AWS_REGION:?}"
export AWS_DEFAULT_REGION="$AWS_REGION"
stack=StressDashSpikeDashboard
echo "account: $(aws --profile "$PLATFORM_PROFILE" sts get-caller-identity --query Account --output text)"
t0=$(date +%s)
aws --profile "$PLATFORM_PROFILE" cloudformation deploy --stack-name "$stack" --template-file "${here}/dash.yaml" \
  --parameter-overrides CellAccountId="$CELL_ACCOUNT" --no-fail-on-empty-changeset
echo "dashboard_deploy_seconds=$(( $(date +%s) - t0 ))"
aws --profile "$PLATFORM_PROFILE" cloudwatch get-dashboard --dashboard-name StressDashSpike --query DashboardBody --output text | jq -c '{variables: (.variables | length), widgets: (.widgets | length)}'
t0=$(date +%s)
aws --profile "$PLATFORM_PROFILE" cloudformation delete-stack --stack-name "$stack"
aws --profile "$PLATFORM_PROFILE" cloudformation wait stack-delete-complete --stack-name "$stack"
echo "dashboard_destroy_seconds=$(( $(date +%s) - t0 ))"
