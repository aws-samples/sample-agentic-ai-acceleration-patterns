#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §10, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# Synthesises test/integ.identity.ts (one stack per topology), deploys the
# three stacks at once, runs the spec §10 scenario against them, then destroys
# them at once. The destroy always runs, also when the deploy or the scenario
# fails, and the script exits non-zero if any step failed. The CDK CLI drives
# the run, not integ-runner, because integ-runner deploys and destroys a
# test's stacks one at a time (ADR-0023).
#
# Runs in exactly one Region: AWS_REGION must be set. Deploys into the account
# of the ambient AWS credentials, which must be CDK-bootstrapped there.

set -euo pipefail

if [ -z "${AWS_REGION:-}" ]; then
  echo "Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)" >&2
  exit 1
fi
export AWS_DEFAULT_REGION="$AWS_REGION"

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAMPLE_DIR"

# A separate cloud assembly, so the run never mixes with `cdk.out/` from a
# build, and the deploy and the destroy see exactly the same templates.
OUT="cdk.integ.out"
CDK=(npx cdk --app "$OUT")

# The tags every pool the sample creates carries (src/shared/constants.ts:
# SAMPLE_TAG_KEY / SAMPLE_TAG_VALUE / STACK_TAG_KEY). Read from the source so
# the leftover check cannot drift from what the stacks tag.
read_constant() {
  local value
  value="$(sed -n "s/^export const $1 = '\(.*\)';\$/\1/p" src/shared/constants.ts)"
  if [ -z "$value" ]; then
    echo "Cannot read $1 from src/shared/constants.ts" >&2
    exit 1
  fi
  printf '%s' "$value"
}
SAMPLE_TAG_KEY="$(read_constant SAMPLE_TAG_KEY)"
SAMPLE_TAG_VALUE="$(read_constant SAMPLE_TAG_VALUE)"
STACK_TAG_KEY="$(read_constant STACK_TAG_KEY)"

# The three stack names (test/integ.identity.ts), read from the assembly
# once it exists. Filled in after the synth.
STACKS=()

# Prints every user pool in the Region that carries the sample tag and one
# of the integ stacks' tags - what the TenantDrain must have deleted
# (ADR-0022). One line per pool: "<pool id> <stack tag>".
leftover_pools() {
  local account partition pool arn sample stack
  account="$(aws sts get-caller-identity --query Account --output text)"
  partition="$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)"
  # The CLI follows NextToken; --max-results is the page size.
  for pool in $(aws cognito-idp list-user-pools --max-results 60 --query 'UserPools[].Id' --output text); do
    arn="arn:${partition}:cognito-idp:${AWS_REGION}:${account}:userpool/${pool}"
    sample="$(aws cognito-idp list-tags-for-resource --resource-arn "$arn" \
      --query "Tags.\"${SAMPLE_TAG_KEY}\"" --output text 2>/dev/null || true)"
    if [ "$sample" != "$SAMPLE_TAG_VALUE" ]; then
      continue
    fi
    stack="$(aws cognito-idp list-tags-for-resource --resource-arn "$arn" \
      --query "Tags.\"${STACK_TAG_KEY}\"" --output text 2>/dev/null || true)"
    local s
    for s in "${STACKS[@]}"; do
      if [ "$stack" = "$s" ]; then
        echo "$pool $stack"
      fi
    done
  done
}

# Prints the log group names a stack owns right now (its functions', the API
# access logs and the API execution logs, ADR-0024). Empty when the stack is
# gone or never deployed. Captured BEFORE the destroy: the names are the
# only way to find the groups afterwards.
stack_log_groups() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' || true
}

# Prints the names in "$@" that still exist as log groups.
leftover_log_groups() {
  local name found
  for name in "$@"; do
    found="$(aws logs describe-log-groups --log-group-name-prefix "$name" \
      --query "logGroups[?logGroupName=='${name}'].logGroupName" --output text 2>/dev/null || true)"
    if [ -n "$found" ] && [ "$found" != "None" ]; then
      echo "$name"
    fi
  done
}

destroy() {
  local status=$?
  trap - EXIT

  # What a clean destroy must leave no trace of. Read before the stacks go.
  local log_groups=() stack groups
  for stack in "${STACKS[@]}"; do
    groups="$(stack_log_groups "$stack")"
    if [ -n "$groups" ]; then
      while IFS= read -r line; do log_groups+=("$line"); done <<< "$groups"
    fi
  done

  echo "=== destroy ($(date -u +%H:%M:%S) UTC)"
  if ! "${CDK[@]}" destroy --all --force --concurrency 3; then
    echo "Destroy failed: run 'AWS_REGION=$AWS_REGION ${CDK[*]} destroy --all --force --concurrency 3' again" >&2
    status=1
  else
    # The destroy succeeded; now prove it left nothing behind (ADR-0022,
    # ADR-0024). A leftover fails the run even when the scenario passed.
    echo "=== leftovers ($(date -u +%H:%M:%S) UTC)"
    local pools leftovers
    pools="$(leftover_pools || true)"
    if [ -n "$pools" ]; then
      echo "Leftover user pool(s) tagged ${SAMPLE_TAG_KEY}=${SAMPLE_TAG_VALUE} (ADR-0022):" >&2
      echo "$pools" >&2
      status=1
    fi
    if [ "${#log_groups[@]}" -gt 0 ]; then
      leftovers="$(leftover_log_groups "${log_groups[@]}" || true)"
      if [ -n "$leftovers" ]; then
        echo "Leftover log group(s) (ADR-0024):" >&2
        echo "$leftovers" >&2
        status=1
      fi
    fi
    if [ "$status" -eq 0 ]; then
      echo "No leftover pool or log group."
    fi
  fi
  echo "=== done ($(date -u +%H:%M:%S) UTC), exit $status"
  exit "$status"
}

echo "=== synth ($(date -u +%H:%M:%S) UTC)"
rm -rf "$OUT"
npx cdk synth --quiet --output "$OUT" \
  --app "npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ.identity.ts"
mapfile -t STACKS < <("${CDK[@]}" list)
if [ "${#STACKS[@]}" -eq 0 ]; then
  echo "The assembly in $OUT lists no stack" >&2
  exit 1
fi

# From here on, whatever happens, the stacks are destroyed.
trap destroy EXIT

echo "=== deploy ($(date -u +%H:%M:%S) UTC)"
"${CDK[@]}" deploy --all --concurrency 3 --require-approval never --progress events

echo "=== e2e ($(date -u +%H:%M:%S) UTC)"
npx jest --config test/e2e/jest.config.json --runInBand=false
