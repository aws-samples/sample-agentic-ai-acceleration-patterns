#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Integration-test hook (spec section 10 steps 16 to 18, ADR-044, ADR-045). TEST ONLY: it is
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
#   r-names fails when TENANT_NAME is "blocked" (a global PRE hook on
#           TENANT_CREATE and TENANT_UPDATE)
#   others  record and succeed
#
# A cell or deployment event names the application, the cell and its account;
# an application record event names the application only, a tenant record
# event the tenant, an account record event the account (R-42, spec 8.4).
set -euo pipefail

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${HOOK_ID:?HOOK_ID env var is required}"
: "${HOOK_SCOPE:?HOOK_SCOPE env var is required}"
: "${EXECUTION_ID:?EXECUTION_ID env var is required}"
: "${ATTEMPT:?ATTEMPT env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"
case "$EVENT" in
  CELL_*|DEPLOYMENT_*)
    : "${APPLICATION_ID:?APPLICATION_ID env var is required}"
    : "${CELL_ID:?CELL_ID env var is required}"
    : "${CELL_ACCOUNT_ID:?CELL_ACCOUNT_ID env var is required}"
    ;;
  APPLICATION_*) : "${APPLICATION_ID:?APPLICATION_ID env var is required}" ;;
  TENANT_*)
    : "${TENANT_ID:?TENANT_ID env var is required}"
    : "${TENANT_NAME:?TENANT_NAME env var is required}"
    ;;
  ACCOUNT_*)
    : "${ACCOUNT_ID:?ACCOUNT_ID env var is required}"
    : "${ACCOUNT_OWNER:?ACCOUNT_OWNER env var is required}"
    # Empty when the account is shared, but always set.
    : "${ACCOUNT_APPLICATION_IDS?ACCOUNT_APPLICATION_IDS env var is required}"
    ;;
  *) echo "Unknown EVENT"; exit 1 ;;
esac

# The fleet name is the one value the control plane does not hand a hook
# (R-42), so the test ships it beside this script, and the account B external
# id with it, so the hook can report whether any variable held it.
HERE="$(dirname "${BASH_SOURCE[0]}")"
FLEET_NAME=$(tr -d '\n' < "${HERE}/fleet-name.txt")
EXTERNAL_ID=$(tr -d '\n' < "${HERE}/external-id.txt")
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

# The names of the variables the build received (CodeBuild's own CODEBUILD_*
# left out, to keep the record inside an SSM standard parameter), and whether
# any value held the external id or named one of the fleet's pair roles. Only
# these two facts leave the build, never the values.
ENV_NAMES=$(jq -nc '[env | keys[] | select(startswith("CODEBUILD_") | not)] | sort')
EXTERNAL_ID_SEEN=$(jq -n --arg x "$EXTERNAL_ID" '[env[] | select(contains($x))] | length > 0')
PAIR_ROLE_SEEN=$(jq -n --arg c "${FLEET_NAME}-cell-provisioning" --arg t "${FLEET_NAME}-tenant-provisioning" \
  '[env[] | select(contains($c) or contains($t))] | length > 0')

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
  --arg applicationId "${APPLICATION_ID-}" --arg cellId "${CELL_ID-}" \
  --arg cellAccountId "${CELL_ACCOUNT_ID-}" --arg tenantId "${TENANT_ID-}" \
  --arg tenantName "${TENANT_NAME-}" --arg accountId "${ACCOUNT_ID-}" \
  --arg accountOwner "${ACCOUNT_OWNER-}" --arg accountApplicationIds "${ACCOUNT_APPLICATION_IDS-}" \
  --argjson envNames "$ENV_NAMES" --argjson externalIdSeen "$EXTERNAL_ID_SEEN" \
  --argjson pairRoleSeen "$PAIR_ROLE_SEEN" \
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
    tenantNameSet: $tenantNameSet, paramNames: $paramNames, denied: $denied,
    tenantName: $tenantName, accountId: $accountId, accountOwner: $accountOwner,
    accountApplicationIds: $accountApplicationIds, envNames: $envNames,
    externalIdSeen: $externalIdSeen, pairRoleSeen: $pairRoleSeen}' \
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
  r-names)
    if [ "${TENANT_NAME-}" = "blocked" ]; then
      echo "Hook r-names refuses the tenant name blocked"
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
