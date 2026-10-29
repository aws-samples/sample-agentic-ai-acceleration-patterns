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
# The scenario registers two scopes (sample/read, sample/write) through the
# platform API, creates its tenants with them, and proves the entitlement and
# grant rules on real tokens: a tenant that lacks a scope cannot narrow to it,
# a tenant admin's cut shows in the user's next token, UpdateTenant widens a
# tenant, and DeleteScope drops the scope from every token within the 60 s
# catalogue cache (ADR-0034, ADR-0035, ADR-0036).
#
# Runs in exactly one Region: AWS_REGION must be set. Deploys into the account
# of the ambient AWS credentials, which must be CDK-bootstrapped there.
#
# Sharing an account with other deployments of this sample: set
# E2E_STACK_PREFIX to rename the four stacks (default TenantIdentity) and
# E2E_PUBLISHER=none so no integ stack publishes the shared
# /application-plane/shared/identity/* parameters another deployment owns
# (ADR-0017). Both are read by test/integ.identity.ts and the e2e scenario.
#
#   E2E_STACK_PREFIX=TenantIdentityScopes E2E_PUBLISHER=none \
#     AWS_REGION=eu-central-1 scripts/integ.sh

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

# The four stack names (test/integ.identity.ts), read from the assembly
# once it exists. Filled in after the synth. The leftover checks
# (scripts/integ-lib.sh) read them.
STACKS=()

# shellcheck source-path=SCRIPTDIR
# shellcheck source=integ-lib.sh
source "$SAMPLE_DIR/scripts/integ-lib.sh"

# Proves every alarm in a stack can deliver to its action (M-31): forces the
# alarm into ALARM, then waits for the alarm history to record the SNS publish.
# The history says "Failed to execute action" when CloudWatch cannot publish,
# e.g. when the topic's KMS key policy does not let it in. No subscription is
# needed. The alarm is set back to OK afterwards; its next evaluation would
# reset it anyway.
check_alarm_actions() {
  local stack="$1" alarm since summary failed=0
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
    for _ in $(seq 1 30); do
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
    local pools leftovers apis
    pools="$(leftover_pools || true)"
    if [ -n "$pools" ]; then
      echo "Leftover user pool(s) tagged ${SAMPLE_TAG_KEY}=${SAMPLE_TAG_VALUE} (ADR-0022):" >&2
      echo "$pools" >&2
      status=1
    fi
    apis="$(leftover_rest_apis || true)"
    if [ -n "$apis" ]; then
      echo "Leftover REST API(s) from the integ stacks:" >&2
      echo "$apis" >&2
      status=1
      delete_leftover_rest_apis "$apis" || status=1
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
      echo "No leftover pool, REST API or log group."
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
