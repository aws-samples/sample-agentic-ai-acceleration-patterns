#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The control-plane slice of the platform stress test (docs/stress-test.spec.md §3.4,
# stress/README.md; README.md here). The runner calls it with one verb at a time and the
# STRESS_* environment:
#
#   slice.sh budget                 draws on the account-wide quotas, no credentials
#   slice.sh deploy                 the cell account check, then the control plane and the
#                                   stress application, reused when they are there
#   slice.sh seed                   the tier's tenant records, from the manifest when it exists
#   slice.sh run <scenario>         PS-1, placement-race, read-rate or build-limit-scaling
#   slice.sh collect                server-side 5xx of this run's records (P-7)
#   slice.sh teardown [--fixtures]  remove the run's deployments, cells and tenants; with
#                                   --fixtures also the registrations and both stacks
#
# Beyond the runner's variables it reads STRESS_CELL_ACCOUNTS (the cell accounts file:
# account ids, the owner's read profile and the account-base stack ARNs, spec §3.7),
# STRESS_BUILD_LIMIT (default 50, ADR-0046), STRESS_CELL_POLICY_SUFFIX (the cell policy
# suffix of the cell accounts, default none) and AWS_REGION, with credentials for the
# platform account. It needs bash, git, jq, node and the AWS CLI, and runs the sample's
# `npm ci` and `smithy build` when they are missing. It prints ids and counts only, never a
# token, a password or a key, and never runs `set -x` (scripts/CONVENTIONS.md).
#
# The stacks are `${STRESS_PREFIX}-cp-setup` and `${STRESS_PREFIX}-control-plane`, fleet
# `${STRESS_PREFIX}` in lower case; they are fixtures that `teardown` keeps unless
# `--fixtures`. Cells live in the cell accounts and go with the seeded fleet.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${here}/../.." && pwd)"
REPO="$(cd "${SAMPLE_DIR}/../.." && pwd)"
verb="${1:-}"
[ "$#" -eq 0 ] || shift

for name in STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE; do
  if [ -z "${!name:-}" ]; then
    echo "slice.sh: ${name} is not set" >&2
    exit 2
  fi
done
if ! [[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9-]{2,31}$ ]]; then
  echo "slice.sh: STRESS_PREFIX must match ^[A-Za-z][A-Za-z0-9-]{2,31}\$ (it names the fleet)" >&2
  exit 2
fi
if ! command -v jq > /dev/null 2>&1; then
  echo "slice.sh: jq is not installed" >&2
  exit 2
fi

FLEET="$(printf '%s' "$STRESS_PREFIX" | tr '[:upper:]' '[:lower:]')"
SETUP_STACK="${STRESS_PREFIX}-cp-setup"
CP_STACK="${STRESS_PREFIX}-control-plane"
RUN_HOME="${STRESS_HOME}/${STRESS_PREFIX}"
CDK_OUT="${RUN_HOME}/control-plane.cdk.out"
export STRESS_SLICE_SCRIPT="${here}/slice.sh"

ensure_installed() {
  if [ -d "${SAMPLE_DIR}/node_modules/.bin" ] && (cd "$SAMPLE_DIR" && npm ls --depth=0 > /dev/null 2>&1); then
    return 0
  fi
  (cd "$SAMPLE_DIR" && npm ci --silent)
}

ensure_built() {
  ensure_installed
  if [ ! -d "${SAMPLE_DIR}/src/smithy" ]; then
    (cd "$SAMPLE_DIR" && smithy build > /dev/null)
  fi
}

driver() {
  (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts "$@")
}

need_region() {
  : "${AWS_REGION:?slice.sh: set AWS_REGION to the Region of the platform account}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

need_cell_accounts() {
  : "${STRESS_CELL_ACCOUNTS:?slice.sh: set STRESS_CELL_ACCOUNTS to the cell accounts file (README, Stress slice)}"
  [ -r "$STRESS_CELL_ACCOUNTS" ] || { echo "slice.sh: ${STRESS_CELL_ACCOUNTS} is not readable" >&2; exit 2; }
}

# The script source: the repository at the commit the run is built from, as one zip. Only
# what the cell and tenant scripts run: the stress application and the runtime-isolation
# sample (spec §8, decision 7: the cell deploys from a pinned commit), plus that sample's
# generated Smithy code, built here from the commit's own model: the build image has no
# Smithy CLI, and the code is generated output the repository does not commit.
source_zip() {
  local commit="${STRESS_COMMIT:?slice.sh: STRESS_COMMIT is not set}" zip tree
  zip="${RUN_HOME}/source-${commit}.zip"
  if [ ! -s "$zip" ]; then
    tree="$(mktemp -d "${RUN_HOME}/source.XXXXXX")"
    git -C "$REPO" archive --format=tar "$commit" stress/application stress/tsconfig.json samples/agentic-runtime-isolation | tar -x -C "$tree"
    (cd "${tree}/samples/agentic-runtime-isolation" && smithy build > /dev/null)
    rm -rf "${tree}/samples/agentic-runtime-isolation/build"
    (cd "$tree" && zip -q -r -X "${zip}.tmp" stress samples)
    rm -rf "$tree"
    mv "${zip}.tmp" "$zip"
  fi
  printf '%s' "$zip"
}

cdk_deploy() {
  local zip
  zip="$(source_zip)"
  (cd "$SAMPLE_DIR" && STRESS_SOURCE_ZIP="$zip" node_modules/.bin/cdk \
    --app "node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/stress-app.ts" \
    --output "$CDK_OUT" deploy "$@" --require-approval never --progress events)
}

# True unless CloudFormation says the stack does not exist: an AWS error counts as "still
# there", so nothing is forgotten on a failed check.
stack_exists() {
  local err
  if err="$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>&1 > /dev/null)"; then
    return 0
  fi
  ! grep -q 'does not exist' <<< "$err"
}

case "$verb" in
  budget)
    ensure_installed
    driver budget
    ;;

  deploy)
    need_region
    need_cell_accounts
    ensure_built
    mkdir -p -m 700 "$RUN_HOME"
    echo "deploy: account check of the cell accounts (spec §3.7)"
    driver check-accounts
    echo "deploy: ${SETUP_STACK} and ${CP_STACK} (fleet ${FLEET}, build limit ${STRESS_BUILD_LIMIT:-50}) in ${AWS_REGION}"
    cdk_deploy "$SETUP_STACK" "$CP_STACK"
    driver register
    ;;

  set-build-limit)
    # Internal: build-limit-scaling redeploys the control plane with another limit.
    need_region
    limit="${1:?slice.sh set-build-limit: a limit}"
    echo "set-build-limit: ${CP_STACK} at ${limit}"
    STRESS_BUILD_LIMIT="$limit" cdk_deploy "$CP_STACK" --exclusively > /dev/null
    ;;

  seed)
    need_region
    need_cell_accounts
    ensure_installed
    mkdir -p -m 700 "$RUN_HOME"
    driver seed
    ;;

  run)
    need_region
    need_cell_accounts
    ensure_installed
    driver run "${1:?slice.sh run: a scenario id}"
    ;;

  collect)
    need_region
    ensure_installed
    driver collect
    ;;

  teardown)
    need_region
    need_cell_accounts
    ensure_built
    fixtures=0
    [ "${1:-}" != "--fixtures" ] || fixtures=1
    status=0
    onboarding="$(jq -er .onboarding <<< "$STRESS_TIER_JSON")"
    if ! stack_exists "$CP_STACK"; then
      echo "teardown: no ${CP_STACK}; nothing registered to sweep"
    else
      # The run's deployments always go. The seeded fleet and its cells go when onboarding
      # repeats every run (small, medium: stress ADR-0004) or with --fixtures.
      seeded=()
      if [ "$fixtures" -eq 1 ] || [ "$onboarding" = "every-run" ]; then
        seeded=(--seeded)
      fi
      driver sweep ${seeded[@]+"${seeded[@]}"} || status=1
      if [ "$fixtures" -eq 1 ] && [ "$status" -eq 0 ]; then
        driver unregister || status=1
      fi
    fi
    if [ "$fixtures" -eq 1 ]; then
      if [ "$status" -ne 0 ]; then
        echo "teardown: cells or registrations are left; the stacks stay so a rerun can reach them" >&2
      else
        for stack in "$CP_STACK" "$SETUP_STACK"; do
          if stack_exists "$stack"; then
            echo "teardown: destroying ${stack}"
            (cd "$SAMPLE_DIR" && STRESS_SOURCE_ZIP="$(source_zip)" node_modules/.bin/cdk \
              --app "node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/stress-app.ts" \
              --output "$CDK_OUT" destroy "$stack" --force) || status=1
          fi
        done
        for stack in "$CP_STACK" "$SETUP_STACK"; do
          if stack_exists "$stack"; then
            echo "teardown: stack ${stack} is still there" >&2
            status=1
          fi
        done
        [ "$status" -ne 0 ] || rm -f "${RUN_HOME}/control-plane.json" "${RUN_HOME}"/source-*.zip
      fi
      # What of the fleet is left in the platform account: roles, projects, the workflow
      # and log groups named after it (the stacks own them).
      left="$(aws iam list-roles --query "Roles[?starts_with(RoleName, '${FLEET}-')].RoleName" --output text)"
      left+=" $(aws codebuild list-projects --query "projects[?starts_with(@, '${FLEET}-')]" --output text)"
      left+=" $(aws stepfunctions list-state-machines --query "stateMachines[?starts_with(name, '${FLEET}-')].name" --output text)"
      left="$(tr '\t ' '\n\n' <<< "$left" | grep -v -e '^$' -e '^None$' || true)"
      if [ -n "$left" ]; then
        echo "teardown: left in the platform account: $(printf '%s\n' "$left" | wc -l) roles, projects or state machines named ${FLEET}-*" >&2
        status=1
      fi
      groups="$(aws logs describe-log-groups --query "logGroups[?contains(logGroupName, '${STRESS_PREFIX}-c')].logGroupName" --output text | tr '\t' '\n' | grep -v -e '^$' -e '^None$' || true)"
      if [ -n "$groups" ]; then
        echo "teardown: log groups named after the stacks (listed, not counted; see README, Known limitations):"
        printf '  %s\n' $groups
      fi
    fi
    # Cells go with the seeded fleet; at a fixture tier without --fixtures they stay.
    if [ "$fixtures" -eq 1 ] || [ "$onboarding" = "every-run" ]; then
      driver cell-leftovers || status=1
    fi
    if [ "$status" -eq 0 ]; then
      echo "teardown: nothing the slice owned is left"
    fi
    exit "$status"
    ;;

  *)
    echo "usage: slice.sh budget | deploy | seed | run <scenario> | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
