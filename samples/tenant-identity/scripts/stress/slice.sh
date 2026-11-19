#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The tenant-identity slice of the platform stress test
# (docs/stress-test.spec.md §3.4, stress/README.md). The runner calls it with
# one verb at a time and the STRESS_* environment:
#
#   slice.sh budget                 draws on the account-wide quotas, no credentials
#   slice.sh deploy                 the stress-only identity stack, reused when it is there
#   slice.sh seed                   the tier's tenants and users, from the manifest when it exists
#   slice.sh run <scenario>         PS-1, token-rate or create-tenant-burst
#   slice.sh collect                late fields of this run's records, from API Gateway metrics
#   slice.sh teardown [--fixtures]  delete the run's tenants; with --fixtures also the stack
#
# The stack is `${STRESS_PREFIX}-identity`, a `shared-pool` deployment with its
# own user pool that publishes none of the fixed-name shared parameters
# (stress ADR-0002, ADR-0041). It is a fixture: `teardown` keeps it unless
# `--fixtures`. The long-lived TenantIdentity-* stacks the integration tests
# share are never read, changed or destroyed here: the prefix check below
# refuses any prefix that could name one of them.
#
# Needs AWS_REGION and credentials for the account (every verb but budget),
# bash, jq, node, and the sample's npm install and `smithy build` (deploy runs
# them when missing). Prints ids and counts only, never a token, a password or
# a key, and never runs `set -x` (scripts/CONVENTIONS.md): the runner writes
# this output to run.log.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${here}/../.." && pwd)"
verb="${1:-}"
[ "$#" -eq 0 ] || shift

for name in STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE; do
  if [ -z "${!name:-}" ]; then
    echo "slice.sh: ${name} is not set" >&2
    exit 2
  fi
done

if ! [[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9-]{2,40}$ ]]; then
  echo "slice.sh: STRESS_PREFIX must match ^[A-Za-z][A-Za-z0-9-]{2,40}\$" >&2
  exit 2
fi
prefix_lower="$(printf '%s' "$STRESS_PREFIX" | tr '[:upper:]' '[:lower:]')"
if [[ "$prefix_lower" == tenantidentity* ]]; then
  echo "slice.sh: STRESS_PREFIX must not start with TenantIdentity: those stacks belong to the integration tests" >&2
  exit 2
fi
STACK="${STRESS_PREFIX}-identity"
RUN_HOME="${STRESS_HOME}/${STRESS_PREFIX}"
CDK_OUT="${RUN_HOME}/tenant-identity.cdk.out"

# Installs and builds on a fresh checkout. `budget` has an empty HOME, so
# npm's cache goes to a scratch folder there.
ensure_installed() {
  if [ -d "${SAMPLE_DIR}/node_modules/.bin" ]; then
    return 0
  fi
  local cache=""
  if [ -z "${HOME:-}" ]; then
    cache="$(mktemp -d)"
    export npm_config_cache="$cache"
  fi
  (cd "$SAMPLE_DIR" && npm ci --silent)
  [ -z "$cache" ] || rm -rf "${cache:?}"
}

ensure_built() {
  ensure_installed
  if [ ! -d "${SAMPLE_DIR}/src/smithy" ]; then
    (cd "$SAMPLE_DIR" && smithy build > /dev/null)
  fi
}

# The driver and the CDK app run through the sample's own ts-node and cdk.
driver() {
  (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts "$@")
}

cdk_app="node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress.identity.ts"
cdk() {
  (cd "$SAMPLE_DIR" && node_modules/.bin/cdk --app "$cdk_app" --output "$CDK_OUT" "$@")
}

need_region() {
  : "${AWS_REGION:?slice.sh: set AWS_REGION to the Region of the stress account}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text > /dev/null 2>&1
}

case "$verb" in
  budget)
    ensure_installed
    driver budget
    ;;

  deploy)
    need_region
    ensure_built
    mkdir -p -m 700 "$RUN_HOME"
    echo "deploy: ${STACK} in ${AWS_REGION}"
    cdk deploy "$STACK" --require-approval never --progress events
    driver publish
    ;;

  seed)
    need_region
    ensure_installed
    mkdir -p -m 700 "$RUN_HOME"
    driver seed
    ;;

  run)
    need_region
    ensure_installed
    scenario="${1:?slice.sh run: a scenario id}"
    driver run "$scenario"
    ;;

  collect)
    need_region
    ensure_installed
    driver collect
    ;;

  teardown)
    need_region
    ensure_installed
    fixtures=0
    [ "${1:-}" != "--fixtures" ] || fixtures=1
    status=0

    # The run's own tenants always go. The seeded set goes with them when
    # onboarding repeats every run (small, medium: stress ADR-0004) or on
    # --fixtures; at `large` it stays, as the fixture it is.
    seeded=()
    if [ "$fixtures" -eq 1 ] || [ "$(jq -r .onboarding <<< "$STRESS_TIER_JSON")" = "every-run" ]; then
      seeded=(--seeded)
    fi
    driver sweep ${seeded[@]+"${seeded[@]}"} || status=1

    if [ "$fixtures" -eq 1 ]; then
      # What a clean destroy must leave no trace of (integ-lib.sh, ADR-0022,
      # ADR-0024). Read before the stack goes: the ids are the only way back.
      STACKS=("$STACK")
      # shellcheck source-path=SCRIPTDIR
      # shellcheck source=../integ-lib.sh
      source "${SAMPLE_DIR}/scripts/integ-lib.sh"
      pools=()
      apis=()
      groups=()
      if stack_exists; then
        while IFS= read -r line; do [ -z "$line" ] || pools+=("$line"); done < <(stack_resources "$STACK" AWS::Cognito::UserPool)
        while IFS= read -r line; do [ -z "$line" ] || apis+=("$line"); done < <(stack_resources "$STACK" AWS::ApiGateway::RestApi)
        while IFS= read -r line; do [ -z "$line" ] || groups+=("$line"); done < <(stack_log_groups "$STACK")
        echo "teardown: destroying ${STACK}"
        cdk destroy "$STACK" --force || status=1
      fi
      driver unpublish || status=1
      rm -f "${RUN_HOME}/tenant-identity.json"

      if stack_exists; then
        echo "teardown: stack ${STACK} is still there" >&2
        status=1
      fi
      left="$(leftover_pool_ids ${pools[@]+"${pools[@]}"})"
      if [ -n "$left" ]; then
        echo "teardown: leftover user pool(s): $(printf '%s' "$left" | wc -l)" >&2
        status=1
      fi
      left="$(leftover_rest_api_ids ${apis[@]+"${apis[@]}"})"
      if [ -n "$left" ]; then
        echo "teardown: leftover REST API(s): $(printf '%s' "$left" | wc -l)" >&2
        status=1
      fi
      left="$(leftover_log_groups ${groups[@]+"${groups[@]}"})"
      if [ -n "$left" ]; then
        echo "teardown: leftover log group(s): $(printf '%s' "$left" | wc -l)" >&2
        status=1
      fi
      if aws ssm get-parameter --name "/${STRESS_PREFIX}/identity" --query Parameter.Name --output text > /dev/null 2>&1; then
        echo "teardown: parameter /${STRESS_PREFIX}/identity is still there" >&2
        status=1
      fi
      if [ "$status" -eq 0 ]; then
        echo "teardown: no stack, pool, REST API, log group or parameter left"
      fi
    fi
    exit "$status"
    ;;

  *)
    echo "usage: slice.sh budget | deploy | seed | run <scenario> | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
