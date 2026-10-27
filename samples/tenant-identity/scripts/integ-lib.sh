#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared leftover checks for the deployment integration tests (spec §10,
# docs/sample-standard.md §5.2). Sourced by scripts/integ.sh and
# scripts/integ-control-plane.sh, never run. Both scripts prove that a
# destroy left nothing behind (ADR-0022 pools, ADR-0024 log groups, orphan
# REST APIs); these helpers are what they share.
#
# Expects, from the sourcing script:
#   AWS_REGION, SAMPLE_DIR (the sample root, for src/shared/constants.ts)
#   STACKS=(...)            the tenant-identity stack names the run deployed
# Sets SAMPLE_TAG_KEY, SAMPLE_TAG_VALUE and STACK_TAG_KEY from the source.
# Every helper tolerates a failing AWS call (prints nothing for it) so the
# caller's EXIT trap always runs to its end under set -e.

# The tags every pool the sample creates carries (src/shared/constants.ts:
# SAMPLE_TAG_KEY / SAMPLE_TAG_VALUE / STACK_TAG_KEY). Read from the source so
# the leftover check cannot drift from what the stacks tag.
read_constant() {
  local value
  value="$(sed -n "s/^export const $1 = '\(.*\)';\$/\1/p" "$SAMPLE_DIR/src/shared/constants.ts")"
  if [ -z "$value" ]; then
    echo "Cannot read $1 from src/shared/constants.ts" >&2
    exit 1
  fi
  printf '%s' "$value"
}
SAMPLE_TAG_KEY="$(read_constant SAMPLE_TAG_KEY)"
SAMPLE_TAG_VALUE="$(read_constant SAMPLE_TAG_VALUE)"
STACK_TAG_KEY="$(read_constant STACK_TAG_KEY)"

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

# Prints the physical ids of a stack's resources of one CloudFormation type
# (e.g. AWS::Logs::LogGroup, AWS::Cognito::UserPool, AWS::ApiGateway::RestApi),
# one per line. Empty when the stack is gone or never deployed. Captured
# BEFORE the destroy: the ids are the only way to find the resources after.
stack_resources() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='$2'].PhysicalResourceId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' || true
}

# Prints the log group names a stack owns right now (its functions', the API
# access logs and the API execution logs, ADR-0024).
stack_log_groups() {
  stack_resources "$1" AWS::Logs::LogGroup
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

# Prints the user pool ids in "$@" that still exist.
leftover_pool_ids() {
  local id
  for id in "$@"; do
    if aws cognito-idp describe-user-pool --user-pool-id "$id" >/dev/null 2>&1; then
      echo "$id"
    fi
  done
}

# Prints the REST API ids in "$@" that still exist, as "<id> <name>".
leftover_rest_api_ids() {
  local id name
  for id in "$@"; do
    name="$(aws apigateway get-rest-api --rest-api-id "$id" --query name --output text 2>/dev/null || true)"
    if [ -n "$name" ]; then
      echo "$id $name"
    fi
  done
}

# Prints REST APIs left by a failed CloudFormation create. SpecRestApi first
# creates the shell API, then imports its OpenAPI document with PutRestApi. If
# that second call is denied, CloudFormation has no physical id to delete and
# the shell API can survive rollback. Names are stack-scoped.
leftover_rest_apis() {
  local stack
  for stack in "${STACKS[@]}"; do
    aws apigateway get-rest-apis \
      --query "items[?name=='${stack}-api'].[id,name]" --output text 2>/dev/null || true
  done
}

# API Gateway limits DeleteRestApi to about one request per 30 seconds. Retry
# throttles and pace multiple orphan deletes. The caller still fails the integ
# run: cleanup prevents account litter; it does not turn a failed deploy green.
delete_leftover_rest_apis() {
  local apis="$1" id name attempt
  while read -r id name; do
    [ -n "$id" ] || continue
    echo "Deleting orphan REST API ${name} (${id})" >&2
    for attempt in 1 2 3 4 5; do
      if aws apigateway delete-rest-api --rest-api-id "$id"; then
        break
      fi
      if [ "$attempt" -eq 5 ]; then
        echo "Could not delete orphan REST API ${name} (${id})" >&2
        return 1
      fi
      sleep $((attempt * 10))
    done
    sleep 35
  done <<<"$apis"
}
