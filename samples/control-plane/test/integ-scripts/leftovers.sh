#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# What of ONE run's fleet exists in account A (integration-test.md). Only
# resources that carry this run's fleet name, `cp-integ-<CP_INTEG_RUN_ID>`: a
# run in progress beside this one is never reported.
#
#   leftovers.sh stacks   this run's CloudFormation stacks (exit 1 when any exists)
#   leftovers.sh all      the stacks, plus the fleet's IAM roles, CodeBuild
#                         projects, state machine, log groups and test
#                         parameters (exit 1 when any exists)
#
# Account B holds this fleet's role pair and probe role in a stack of its own,
# which the runner destroys; this script has A's credentials only and does not
# read B. The default Lambda log groups of the test harness
# (/aws/lambda/<fleet>-*) are expected leftovers, listed but not counted: delete
# them by prefix. The API Gateway CloudWatch role and account setting the stack's
# REST API creates are one per account and Region, shared by every run, and are
# not part of a fleet.
set -uo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CP_INTEG_RUN_ID:?CP_INTEG_RUN_ID is required}"
FLEET="cp-integ-${CP_INTEG_RUN_ID}"
mode="${1:-all}"
found=0

# Prints the lines read from stdin, indented under a heading, and records that something was found.
report() {
  local heading="$1" lines
  lines=$(cat)
  if [ -n "$lines" ]; then
    echo "$heading"
    printf '%s\n' "$lines" | sed 's/^/  /'
    found=1
  fi
}

stacks=$(aws cloudformation describe-stacks --region "$AWS_REGION" --query "Stacks[].StackName" --output text) || {
  echo "Could not list CloudFormation stacks in $AWS_REGION"
  exit 1
}
report "Stacks of this run in $AWS_REGION (${FLEET}):" < <(printf '%s\n' $stacks | grep -E "^${FLEET}(-|$)")
if [ "$mode" = stacks ]; then
  exit $found
fi

report "IAM roles named after the fleet:" \
  < <(aws iam list-roles --query "Roles[?starts_with(RoleName, '${FLEET}-')].RoleName" --output text | tr '\t' '\n')
report "CodeBuild projects named after the fleet:" \
  < <(aws codebuild list-projects --region "$AWS_REGION" --query "projects[?starts_with(@, '${FLEET}-')]" --output text | tr '\t' '\n')
report "State machines named after the fleet:" \
  < <(aws stepfunctions list-state-machines --region "$AWS_REGION" --query "stateMachines[?starts_with(name, '${FLEET}-')].name" --output text | tr '\t' '\n')
# Log groups the stacks own are named after their stack, so after the fleet.
report "Log groups named after the fleet (the harness's Lambda ones excepted):" \
  < <(aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "${FLEET}-" --query "logGroups[].logGroupName" --output text | tr '\t' '\n' | grep -v '^/aws/lambda/')
report "Hook ledger parameters (delete with: aws ssm delete-parameters --names <names>):" \
  < <(aws ssm get-parameters-by-path --region "$AWS_REGION" --path "/cp-integ/${FLEET}" --recursive --query "Parameters[].Name" --output text | tr '\t' '\n')

# Expected: the harness's default function log groups (not counted).
harness=$(aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "/aws/lambda/${FLEET}-" --query "logGroups[].logGroupName" --output text | tr '\t' '\n')
if [ -n "$harness" ]; then
  echo "Expected harness leftovers (default Lambda log groups, delete by prefix /aws/lambda/${FLEET}-):"
  printf '%s\n' "$harness" | sed 's/^/  /'
fi

if [ "$found" -eq 0 ]; then
  echo "No leftovers of ${FLEET} in account A."
fi
exit $found
