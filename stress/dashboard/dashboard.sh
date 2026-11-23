#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The run dashboard of the platform stress test (stress ADR-0022): `<STRESS_PREFIX>-dashboard`, one
# stack with one CloudWatch dashboard, `<STRESS_PREFIX>-run`. The runner calls it with `up` after
# `budget` passes, `snapshot` and `down` after the last teardown; `run.sh dashboard <verb> --run <id>`
# calls it by hand.
#
#   AWS_REGION=<the run's Region> STRESS_PREFIX=<prefix> STRESS_DASHBOARD_PLAN_FILE=<plan> \
#     [STRESS_CELL_ACCOUNTS=<cell accounts file>] [STRESS_RUN_DIR=<run folder>] \
#     stress/dashboard/dashboard.sh up | snapshot | down
#
# up        deploys the stack and prints `stack=<name> deploy_seconds=<n>`.
# snapshot  saves a PNG of each metric widget into <STRESS_RUN_DIR>/dashboard/.
# down      removes the stack, prints `stack=<name> destroy_seconds=<n>`, then checks that the
#           stack and the dashboard are gone (the leftover check of design §8) and exits 1 if not.
#
# The credentials are the platform account's. The synthesised app goes to stress/cdk.dashboard.out
# (not committed). Nothing here prints an account id.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region of the run}"
: "${STRESS_PREFIX:?Set STRESS_PREFIX (1 to 40 letters and digits, starting with a letter)}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent
STACK="${STRESS_PREFIX}-dashboard"
DASHBOARD="${STRESS_PREFIX}-run"
OUT="cdk.dashboard.out"
verb="${1:-}"

# stack_status -> the status on stdout; "absent" when CloudFormation says the stack does not
# exist; any other failure (credentials, throttle, Region) stops the script.
stack_status() {
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    echo "$out"
  elif [[ "$out" == *"does not exist"* ]]; then
    echo absent
  else
    echo "describe-stacks ${STACK} failed: ${out}" >&2
    exit 1
  fi
}

case "$verb" in
  up)
    : "${STRESS_DASHBOARD_PLAN_FILE:?Set STRESS_DASHBOARD_PLAN_FILE to the plan the runner wrote}"
    start=$SECONDS
    npx cdk --app "npx ts-node --transpile-only dashboard/app.ts" deploy "$STACK" \
      --output "$OUT" --exclusively --require-approval never --no-version-reporting >&2
    echo "stack=${STACK} deploy_seconds=$((SECONDS - start))"
    ;;
  snapshot)
    : "${STRESS_DASHBOARD_PLAN_FILE:?Set STRESS_DASHBOARD_PLAN_FILE to the plan the runner wrote}"
    : "${STRESS_RUN_DIR:?Set STRESS_RUN_DIR to the run folder}"
    npx ts-node --transpile-only dashboard/snapshot.ts
    ;;
  down)
    status="$(stack_status)"
    if [[ "$status" != absent && "$status" != DELETE_COMPLETE ]]; then
      start=$SECONDS
      aws cloudformation delete-stack --stack-name "$STACK"
      aws cloudformation wait stack-delete-complete --stack-name "$STACK"
      echo "stack=${STACK} destroy_seconds=$((SECONDS - start))"
    else
      echo "stack=${STACK} not deployed; nothing to remove"
    fi
    left=0
    after="$(stack_status)"
    if [[ "$after" != absent && "$after" != DELETE_COMPLETE ]]; then
      echo "leftover: ${STACK} is ${after}" >&2
      left=1
    fi
    found="$(aws cloudwatch list-dashboards --dashboard-name-prefix "$DASHBOARD" --query "DashboardEntries[?DashboardName=='${DASHBOARD}'].DashboardName" --output text)"
    if [[ -n "$found" && "$found" != None ]]; then
      echo "leftover: the dashboard ${DASHBOARD} is still there" >&2
      left=1
    fi
    [[ "$left" -eq 0 ]] || exit 1
    echo "leftovers: none"
    ;;
  *)
    echo "usage: dashboard.sh up | snapshot | down" >&2
    exit 2
    ;;
esac
