#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application cell DELETE script (spec §3.3; stress ADR-0012). Runs like create.sh,
# under the cell account's role pair cell role.
#
# It finds the cell's stack through the cell namespace (CONVENTIONS.md: a delete never
# recomputes what its create made), falling back to the name a create gives it when the
# create failed before it published. It assumes the cell bootstrap's deploy role (allowed by
# cell-build-policy) and has CloudFormation delete the stack under the bootstrap's execution
# role, the role that created it, so the delete needs no synth and no install. Then it
# removes the cell's parameters. A stack that is already gone is not an error.
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"
: "${CELL_ACCOUNT_ID:?CELL_ACCOUNT_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source=../lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
caller="$(aws sts get-caller-identity --query Account --output text)"
if [ "$caller" != "$CELL_ACCOUNT_ID" ]; then
  echo "Running in account ${caller}, not the cell's account ${CELL_ACCOUNT_ID}: refusing"
  exit 1
fi
partition="${caller_arn#arn:}"
partition="${partition%%:*}"

if ! STACK="$(get_param "$(cell_param stack)" 2> /dev/null)"; then
  STACK="StressCell-${CELL_ID}"
  echo "No $(cell_param stack); using the create script's name"
fi
if ! [[ "$STACK" =~ ^StressCell-[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
  echo "$(cell_param stack) does not name a stress cell stack: refusing"
  exit 1
fi
echo "Deleting cell ${CELL_ID}: stack ${STACK} in ${CELL_ACCOUNT_ID}"

deploy_role="arn:${partition}:iam::${CELL_ACCOUNT_ID}:role/cdk-cell-deploy-role-${CELL_ACCOUNT_ID}-${AWS_REGION}"
execution_role="arn:${partition}:iam::${CELL_ACCOUNT_ID}:role/cdk-cell-cfn-exec-role-${CELL_ACCOUNT_ID}-${AWS_REGION}"

start=$SECONDS
(
  CREDENTIALS="$(aws sts assume-role --role-arn "$deploy_role" --role-session-name "cell-delete-${CELL_ID}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<< "$CREDENTIALS"
  unset CREDENTIALS
  [ -n "$AWS_SESSION_TOKEN" ] || { echo "AssumeRole of the deploy role returned no credentials"; exit 1; }
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  status="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)" || {
    if grep -q 'does not exist' <<< "$status"; then
      echo "Stack ${STACK} is already gone"
      exit 0
    fi
    echo "Could not describe ${STACK}"
    exit 1
  }
  aws cloudformation delete-stack --stack-name "$STACK" --role-arn "$execution_role"
  if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK"; then
    echo "Stack ${STACK} did not delete: $(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo unknown)"
    exit 1
  fi
  echo "Stack ${STACK} deleted"
)
echo "cell_delete_seconds=$((SECONDS - start))"

delete_param "$(cell_param entitlements-api-url)"
delete_param "$(cell_param stack)"
if [ -n "${OUTPUTS_FILE:-}" ]; then
  printf '{}\n' > "$OUTPUTS_FILE"
fi
echo "Cell ${CELL_ID} deleted"
