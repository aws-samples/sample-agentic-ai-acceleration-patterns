#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample AUDIT hook (ADR-044, ADR-045).
#
# Register it as a global POST hook on any events. For each event it writes
# one JSON line to its build log: the event, the phase, the hook, the
# operation's execution id and the ids of the record it acted on. On a cell
# or deployment POST it also lists the NAMES of the outputs the script wrote,
# never their values. Swap the echo for a call to your own audit store,
# CMDB or metering endpoint, and grant the call through
# globalHookManagedPolicyArns.
#
# It needs no permission beyond the hook role's own logs. It runs in the
# control plane account and never in a cell account.
set -euo pipefail

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${HOOK_ID:?HOOK_ID env var is required}"
: "${HOOK_SCOPE:?HOOK_SCOPE env var is required}"
: "${EXECUTION_ID:?EXECUTION_ID env var is required}"
: "${ATTEMPT:?ATTEMPT env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"

# SCRIPT_OUTPUTS comes from the cell's account, which a tenant may own, so it
# is untrusted: parse it with jq, read only key names, never eval it. Record
# events and PRE hooks get none, or {}.
OUTPUT_KEYS='[]'
if [ -n "${SCRIPT_OUTPUTS:-}" ]; then
  if ! OUTPUT_KEYS=$(jq -ce 'if type == "object" then keys else error("not an object") end' \
      <<< "${SCRIPT_OUTPUTS}" 2>/dev/null); then
    echo "SCRIPT_OUTPUTS is not a JSON object"
    exit 1
  fi
fi

# Ids are control-plane-generated or held to a fixed pattern, so they are
# safe to log. TENANT_NAME and PARAM_ values are free text and are left out
# (scripts/CONVENTIONS.md).
jq -nc \
  --arg event "$EVENT" --arg phase "$PHASE" \
  --arg hookId "$HOOK_ID" --arg hookScope "$HOOK_SCOPE" \
  --arg executionId "$EXECUTION_ID" --arg attempt "$ATTEMPT" \
  --arg operatorId "$OPERATOR_ID" \
  --arg applicationId "${APPLICATION_ID-}" --arg cellId "${CELL_ID-}" \
  --arg cellAccountId "${CELL_ACCOUNT_ID-}" --arg tenantId "${TENANT_ID-}" \
  --arg accountId "${ACCOUNT_ID-}" --arg accountOwner "${ACCOUNT_OWNER-}" \
  --argjson outputKeys "$OUTPUT_KEYS" \
  '{audit: "control-plane", event: $event, phase: $phase, hookId: $hookId,
    hookScope: $hookScope, executionId: $executionId, attempt: $attempt,
    operatorId: $operatorId, applicationId: $applicationId, cellId: $cellId,
    cellAccountId: $cellAccountId, tenantId: $tenantId, accountId: $accountId,
    accountOwner: $accountOwner, outputKeys: $outputKeys}
   | with_entries(select(.value != ""))'
