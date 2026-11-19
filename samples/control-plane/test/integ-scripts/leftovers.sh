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
# Either mode exits 2 when an AWS listing call fails: the leftovers are then
# unknown, never reported as none.
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
  echo "Could not list CloudFormation stacks in $AWS_REGION; leftovers unknown" >&2
  exit 2
}
report "Stacks of this run in $AWS_REGION (${FLEET}):" < <(printf '%s\n' $stacks | grep -E "^${FLEET}(-|$)")
if [ "$mode" = stacks ]; then
  exit $found
fi

# Runs one AWS listing (text output) and prints one name per line. A failed
# call ends the script with exit 2, so an error is never read as "nothing left".
list() {
  local what="$1" out
  shift
  out=$("$@" --output text) || {
    echo "Could not list ${what} in $AWS_REGION; leftovers unknown" >&2
    exit 2
  }
  printf '%s\n' "$out" | tr '\t' '\n' | { grep -v -e '^$' -e '^None$' || true; }
}

roles=$(list "IAM roles" aws iam list-roles --query "Roles[?starts_with(RoleName, '${FLEET}-')].RoleName") || exit 2
report "IAM roles named after the fleet:" <<<"$roles"
projects=$(list "CodeBuild projects" aws codebuild list-projects --region "$AWS_REGION" --query "projects[?starts_with(@, '${FLEET}-')]") || exit 2
report "CodeBuild projects named after the fleet:" <<<"$projects"
machines=$(list "state machines" aws stepfunctions list-state-machines --region "$AWS_REGION" --query "stateMachines[?starts_with(name, '${FLEET}-')].name") || exit 2
report "State machines named after the fleet:" <<<"$machines"
# Log groups the stacks own are named after their stack, so after the fleet.
groups=$(list "log groups" aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "${FLEET}-" --query "logGroups[].logGroupName") || exit 2
report "Log groups named after the fleet (the harness's Lambda ones excepted):" < <(printf '%s\n' "$groups" | grep -v -e '^/aws/lambda/' -e '^$')
params=$(list "SSM parameters" aws ssm get-parameters-by-path --region "$AWS_REGION" --path "/cp-integ/${FLEET}" --recursive --query "Parameters[].Name") || exit 2
report "Hook ledger parameters (delete with: aws ssm delete-parameters --names <names>):" <<<"$params"

# Expected: the harness's default function log groups (not counted).
harness=$(list "harness log groups" aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "/aws/lambda/${FLEET}-" --query "logGroups[].logGroupName") || exit 2
if [ -n "$harness" ]; then
  echo "Expected harness leftovers (default Lambda log groups, delete by prefix /aws/lambda/${FLEET}-):"
  printf '%s\n' "$harness" | sed 's/^/  /'
fi

if [ "$found" -eq 0 ]; then
  echo "No leftovers of ${FLEET} in account A."
fi
exit $found
