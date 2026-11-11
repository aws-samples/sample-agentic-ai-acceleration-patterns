#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Teardown helpers sourced by scripts/integ.sh (and test/teardown-lib.test.ts).
#
# AgentCore deletes a Memory asynchronously, and the deletion can take hours.
# When it outlasts CloudFormation's wait, the stack ends DELETE_FAILED with the
# Memory as its only failed resource while the service keeps deleting it and
# refuses a second DeleteMemory. finish_memory_teardown finishes such a stack
# without hiding the Memory: it deletes the stack with the Memory retained,
# then polls the service until the Memory is gone or the wait runs out.

# finish_memory_teardown STACK [WAIT_SECONDS] [POLL_SECONDS]
#   0  the stack is gone and every retained Memory is gone
#   1  the stack is not in a state this function finishes (another resource
#      failed, or the stack is in another state); nothing was retained
#   2  the stack is gone, but a retained Memory is still being deleted
finish_memory_teardown() {
  local stack="$1" wait="${2:-7200}" poll="${3:-60}"
  local status
  if ! status="$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"; then
    return 0
  fi
  if [[ "$status" != DELETE_FAILED ]]; then
    echo "teardown: ${stack} is ${status}, not DELETE_FAILED" >&2
    return 1
  fi
  local failed type logical physical
  local -a retain=() memories=()
  failed="$(aws cloudformation describe-stack-resources --stack-name "$stack" \
    --query "StackResources[?ResourceStatus=='DELETE_FAILED'].[ResourceType,LogicalResourceId,PhysicalResourceId]" --output text)"
  while read -r type logical physical; do
    [[ -n "$type" ]] || continue
    if [[ "$type" != AWS::BedrockAgentCore::Memory ]]; then
      echo "teardown: ${logical} (${type}) failed to delete; nothing is retained" >&2
      return 1
    fi
    retain+=("$logical")
    memories+=("${physical##*/}")
  done <<<"$failed"
  if [[ ${#retain[@]} -eq 0 ]]; then
    echo "teardown: ${stack} is DELETE_FAILED with no failed resource listed" >&2
    return 1
  fi
  echo "  AgentCore is still deleting ${#memories[@]} Memory resource(s); deleting ${stack} without them"
  aws cloudformation delete-stack --stack-name "$stack" --retain-resources "${retain[@]}"
  if ! aws cloudformation wait stack-delete-complete --stack-name "$stack"; then
    echo "teardown: ${stack} did not delete with the Memory retained" >&2
    return 1
  fi
  local deadline=$(($(date +%s) + wait)) id
  local -a pending
  while :; do
    pending=()
    for id in "${memories[@]}"; do
      if aws bedrock-agentcore-control get-memory --memory-id "$id" >/dev/null 2>&1; then
        pending+=("$id")
      fi
    done
    if [[ ${#pending[@]} -eq 0 ]]; then
      echo "  gone: retained Memory (the service finished deleting it)"
      return 0
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      echo "teardown: Memory ${pending[*]} is still being deleted by AgentCore after $((wait / 60)) min." >&2
      echo "teardown: the stack is gone; check later with: aws bedrock-agentcore-control get-memory --memory-id ${pending[0]}" >&2
      return 2
    fi
    sleep "$poll"
  done
}
