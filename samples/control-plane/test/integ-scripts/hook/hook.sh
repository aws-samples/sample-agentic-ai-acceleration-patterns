#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Integration-test hook (spec section 10 step 16, ADR-044). TEST ONLY: it is
# not a sample for vendors; it records what a hook build saw so the test can
# read it back, and it fails on demand so the test can drive the failure paths.
#
# Runs in a hook build in the control plane account, under the hook role of its
# scope (R-41). The test attaches one customer-managed policy to each hook role:
# it lets the role write SSM parameters under its own test path and nowhere else
# (the global role under .../hooks/global/, the application role under
# .../hooks/app/). Every run writes one record per attempt there, named by its
# sequence stamp (epoch nanoseconds), holding the R-42 variables it received.
#
# One script serves every hook of the test; the hook id picks the behaviour:
#   p-gate  always fails (a global PRE hook used as a gate)
#   a-pre   fails when PARAM_HOOK_FAIL is "yes" (an application PRE hook on delete)
#   b-post  fails when PARAM_HOOK_FAIL is "post"; also tries four calls its role
#           must not be able to make (R-41 deny) and records the outcome of each
#   others  record and succeed
set -euo pipefail

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${HOOK_ID:?HOOK_ID env var is required}"
: "${HOOK_SCOPE:?HOOK_SCOPE env var is required}"
: "${EXECUTION_ID:?EXECUTION_ID env var is required}"
: "${ATTEMPT:?ATTEMPT env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${CELL_ACCOUNT_ID:?CELL_ACCOUNT_ID env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"

# The fleet name is the one value the control plane does not hand a hook
# (R-42), so the test ships it beside this script.
FLEET_NAME=$(tr -d '\n' < "$(dirname "${BASH_SOURCE[0]}")/fleet-name.txt")
ROOT="/cp-integ/${FLEET_NAME}/hooks"
case "$HOOK_SCOPE" in
  GLOBAL) OWN="${ROOT}/global"; OTHER="${ROOT}/app" ;;
  APPLICATION) OWN="${ROOT}/app"; OTHER="${ROOT}/global" ;;
  *) echo "Unknown HOOK_SCOPE"; exit 1 ;;
esac

STAMP=$(date -u +%s%N)
CALLER=$(aws sts get-caller-identity --query Arn --output text)

# Outcome of a call the role must not be able to make: AccessDenied when the
# service refuses it, Succeeded when it goes through, Failed for any other
# error. The command's own output is never printed (it may name resources).
outcome() {
  local out
  if out=$("$@" 2>&1); then
    echo "Succeeded"
  elif grep -q 'AccessDenied' <<< "$out"; then
    echo "AccessDenied"
  else
    echo "Failed"
  fi
}

DENIED='null'
if [ "$HOOK_ID" = "b-post" ]; then
  # An API Gateway proxy event for a READ route whose authorizer context
  # claims the operator, so a deny that failed would show as a recorded success
  # and write no state.
  FORGED='{"httpMethod":"GET","path":"/hooks","resource":"/hooks","headers":{},"multiValueHeaders":{},"queryStringParameters":null,"multiValueQueryStringParameters":null,"pathParameters":null,"body":null,"isBase64Encoded":false,"requestContext":{"authorizer":{"operatorId":"forged-by-hook","role":"operator","grant":"operator"}}}'
  SSM_WRITE_OTHER=$(outcome aws ssm put-parameter --name "${OTHER}/denied-${STAMP}" --type String --value denied)
  START_EXECUTION=$(outcome aws stepfunctions start-execution --state-machine-arn "${PARAM_WORKFLOW_ARN:-}" --input '{}')
  INVOKE=$(outcome aws lambda invoke --function-name "${PARAM_API_FUNCTION_NAME:-}" --cli-binary-format raw-in-base64-out --payload "$FORGED" /dev/null)
  INVOKE_LATEST=$(outcome aws lambda invoke --function-name "${PARAM_API_FUNCTION_NAME:-}" --qualifier '$LATEST' --cli-binary-format raw-in-base64-out --payload "$FORGED" /dev/null)
  DENIED=$(jq -nc \
    --arg ssmWriteGlobal "$SSM_WRITE_OTHER" --arg startExecution "$START_EXECUTION" \
    --arg invoke "$INVOKE" --arg invokeLatest "$INVOKE_LATEST" \
    '{ssmWriteGlobal: $ssmWriteGlobal, startExecution: $startExecution, invoke: $invoke, invokeLatest: $invokeLatest}')
fi

# The record. Values come from the environment through jq --arg, never
# interpolated into the program (TENANT_NAME, PARAM_ values and SCRIPT_OUTPUTS
# are tenant-shaped). Parameter VALUES are not recorded, only the names and the
# one value the test drives.
PARAM_NAMES=$(jq -nc '[env | keys[] | select(startswith("PARAM_"))]')
RECORD_FILE=$(mktemp)
trap 'rm -f "$RECORD_FILE"' EXIT
jq -nc \
  --arg stamp "$STAMP" --arg event "$EVENT" --arg phase "$PHASE" \
  --arg hookId "$HOOK_ID" --arg hookScope "$HOOK_SCOPE" \
  --arg executionId "$EXECUTION_ID" --arg attempt "$ATTEMPT" \
  --arg applicationId "$APPLICATION_ID" --arg cellId "$CELL_ID" \
  --arg cellAccountId "$CELL_ACCOUNT_ID" --arg tenantId "${TENANT_ID-}" \
  --arg operatorId "$OPERATOR_ID" --arg caller "$CALLER" \
  --arg hookFail "${PARAM_HOOK_FAIL-}" --arg scriptOutputs "${SCRIPT_OUTPUTS-}" \
  --argjson tenantNameSet "$([ -n "${TENANT_NAME+set}" ] && echo true || echo false)" \
  --argjson scriptOutputsSet "$([ -n "${SCRIPT_OUTPUTS+set}" ] && echo true || echo false)" \
  --argjson paramNames "$PARAM_NAMES" --argjson denied "$DENIED" \
  '{stamp: $stamp, event: $event, phase: $phase, hookId: $hookId, hookScope: $hookScope,
    executionId: $executionId, attempt: $attempt, applicationId: $applicationId,
    cellId: $cellId, cellAccountId: $cellAccountId, tenantId: $tenantId,
    operatorId: $operatorId, caller: $caller, hookFail: $hookFail,
    scriptOutputs: $scriptOutputs, scriptOutputsSet: $scriptOutputsSet,
    tenantNameSet: $tenantNameSet, paramNames: $paramNames, denied: $denied}' \
  > "$RECORD_FILE"
aws ssm put-parameter --name "${OWN}/${STAMP}" --type String --value "file://${RECORD_FILE}" > /dev/null
echo "Recorded ${OWN}/${STAMP}"

case "$HOOK_ID" in
  p-gate)
    echo "Hook p-gate always fails"
    exit 1
    ;;
  a-pre)
    if [ "${PARAM_HOOK_FAIL-}" = "yes" ]; then
      echo "Hook a-pre fails while PARAM_HOOK_FAIL is yes"
      exit 1
    fi
    ;;
  b-post)
    if [ "${PARAM_HOOK_FAIL-}" = "post" ]; then
      echo "Hook b-post fails while PARAM_HOOK_FAIL is post"
      exit 1
    fi
    ;;
esac
echo "Hook ${HOOK_ID} done"
