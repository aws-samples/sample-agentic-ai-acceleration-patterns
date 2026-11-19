#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Removes the stress driver host, <STRESS_PREFIX>-driver, and checks nothing of it is left
# (stress ADR-0009). Prints `stack=<name> destroy_seconds=<n>`.
#
#   AWS_REGION=eu-central-1 STRESS_PREFIX=<prefix> [STRESS_TIER=small] stress/driver/teardown.sh
#
# The results bucket is emptied with the stack (autoDeleteObjects), so download any result
# first. A stack that does not exist is not an error.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region the stack is in}"
: "${STRESS_PREFIX:?Set STRESS_PREFIX}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}/.."
[[ -d node_modules ]] || npm ci --silent
export STRESS_TIER="${STRESS_TIER:-small}"
STACK="${STRESS_PREFIX}-driver"
OUT="cdk.driver.out"

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
status="$(stack_status)"
if [[ "$status" == absent || "$status" == DELETE_COMPLETE ]]; then
  echo "stack=${STACK} not deployed; nothing to remove"
  exit 0
fi

start=$SECONDS
npx cdk --app "npx ts-node --transpile-only driver/app.ts" --output "$OUT" destroy "$STACK" --exclusively --force >&2
echo "stack=${STACK} destroy_seconds=$((SECONDS - start))"

left="$(stack_status)"
[[ "$left" == absent || "$left" == DELETE_COMPLETE ]] || { echo "leftover: ${STACK} is ${left}" >&2; exit 1; }
echo "leftovers: none"
