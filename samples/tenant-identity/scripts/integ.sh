#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §10, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# Synthesises test/integ.identity.ts (one stack per deployment: the three
# topologies plus `tiered`, ADR-0027), deploys the four stacks at once, runs the
# spec §10 scenario and the ADR-0027 tiered scenario against them, then destroys
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

# The four stack names (test/integ.identity.ts), read from the assembly
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

# Proves every alarm in a stack can deliver to its action (M-31): forces the
# alarm into ALARM, then waits for the alarm history to record the SNS publish.
# The history says "Failed to execute action" when CloudWatch cannot publish,
# e.g. when the topic's KMS key policy does not let it in. No subscription is
# needed. The alarm is set back to OK afterwards; its next evaluation would
# reset it anyway.
check_alarm_actions() {
  local stack="$1" alarm since summary failed=0 i
  for alarm in $(aws cloudformation describe-stack-resources --stack-name "$stack" \
      --query "StackResources[?ResourceType=='AWS::CloudWatch::Alarm'].PhysicalResourceId" --output text); do
    # A transition is what fires an action, so start from OK.
    aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK \
      --state-reason "integ: alarm action check (reset)"
    sleep 2
    since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value ALARM \
      --state-reason "integ: alarm action check (M-31)"
    summary=""
    for i in $(seq 1 30); do
      summary="$(aws cloudwatch describe-alarm-history --alarm-name "$alarm" \
        --history-item-type Action --start-date "$since" \
        --query 'AlarmHistoryItems[0].HistorySummary' --output text)"
      if [ -n "$summary" ] && [ "$summary" != "None" ]; then
        break
      fi
      sleep 2
    done
    aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK \
      --state-reason "integ: alarm action check (done)"
    case "$summary" in
      "Successfully executed action"*) echo "$alarm: $summary" ;;
      "") echo "$alarm: no action recorded within 60 s" >&2; failed=1 ;;
      *) echo "$alarm: $summary" >&2; failed=1 ;;
    esac
  done
  return "$failed"
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
  if ! "${CDK[@]}" destroy --all --force --concurrency 4; then
    echo "Destroy failed: run 'AWS_REGION=$AWS_REGION ${CDK[*]} destroy --all --force --concurrency 4' again" >&2
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
"${CDK[@]}" deploy --all --concurrency 4 --require-approval never --progress events

echo "=== e2e ($(date -u +%H:%M:%S) UTC)"
npx jest --config test/e2e/jest.config.json --runInBand=false

echo "=== alarm actions ($(date -u +%H:%M:%S) UTC)"
alarm_status=0
for stack in "${STACKS[@]}"; do
  check_alarm_actions "$stack" || alarm_status=1
done
if [ "$alarm_status" -ne 0 ]; then
  echo "An alarm could not deliver to its SNS topic (M-31)" >&2
  exit 1
fi
