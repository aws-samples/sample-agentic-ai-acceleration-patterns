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
#           A stack of that name without the `stress:part=run-dashboard` tag is not ours: it is left
#           alone and `down` exits 0.
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

[[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 2; }
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

# Refuses to touch a stack of the dashboard's name that is not a run dashboard (the tag the app
# gives its stack): the platform account holds other stacks, and `<prefix>-dashboard` is a likely name.
is_run_dashboard() {
  local tag
  # A failed read must stop the script: an empty tag would read as "not ours" and `down` would leave the stack.
  tag="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Tags[?Key=='stress:part'].Value | [0]" --output text)" \
    || { echo "describe-stacks ${STACK} failed: could not read its tags (the stack may have been deleted meanwhile)" >&2; exit 1; }
  [[ "$tag" == run-dashboard ]]
}

case "$verb" in
  up)
    : "${STRESS_DASHBOARD_PLAN_FILE:?Set STRESS_DASHBOARD_PLAN_FILE to the plan the runner wrote}"
    existing="$(stack_status)"
    if [[ "$existing" != absent && "$existing" != DELETE_COMPLETE ]] && ! is_run_dashboard; then
      echo "${STACK} exists and is not a run dashboard (no stress:part=run-dashboard tag): not touching it" >&2
      exit 1
    fi
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
      if ! is_run_dashboard; then
        echo "${STACK} is not a run dashboard (no stress:part=run-dashboard tag): not ours, nothing to remove" >&2
        exit 0
      fi
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
