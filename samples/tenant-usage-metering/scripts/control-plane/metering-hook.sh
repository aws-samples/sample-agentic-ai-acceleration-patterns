#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The control plane's global vendor hook for tenant usage metering (spec §3.4).
# Register it on five events, in these phases:
#
#   CELL_CREATE        PRE   PutCellEmitter
#   CELL_DELETE        POST  DeleteCellEmitter
#   DEPLOYMENT_CREATE  PRE   PutTenantBinding
#   DEPLOYMENT_UPDATE  PRE   PutTenantBinding
#   DEPLOYMENT_DELETE  POST  DeleteTenantBinding
#
# It runs as <fleet>-global-hook, which needs the published registrarStatement
# (spec §6.1). It reads the metering API URL from metering-hook.env beside it,
# never from a PARAM_ value. Every value from the hook environment is checked
# against its charset and reaches the request only through jq --arg, never a
# command line. Every call is idempotent, so a re-run is safe (control-plane
# R-42).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_url="$(sed -n 's/^METERING_API_URL=//p' "$here/metering-hook.env" | head -1)"
if [[ ! "$api_url" =~ ^https://([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com/v1/?$ ]]; then
  echo "metering-hook.env: METERING_API_URL is not an execute-api URL" >&2
  exit 1
fi
region="${BASH_REMATCH[2]}"
api_url="${api_url%/}"

need() {
  local name="$1" pattern="$2" value="${!1:-}"
  if [[ ! "$value" =~ $pattern ]]; then
    echo "hook environment: $name is missing or outside its charset" >&2
    exit 1
  fi
}

need EVENT '^[A-Z_]+$'
need PHASE '^(PRE|POST)$'
need CELL_ID '^[0-9A-HJKMNP-TV-Z]{26}$'
need APPLICATION_ID '^[a-z0-9-]{1,32}$'
execution_id="${EXECUTION_ID:-}"
operator_id="${OPERATOR_ID:-}"
[[ "$execution_id" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || execution_id=""
[[ ${#operator_id} -le 256 && "$operator_id" =~ ^[[:print:]]*$ ]] || operator_id=""

creds="$(aws configure export-credentials --format process)"
access_key="$(jq -r .AccessKeyId <<<"$creds")"
secret_key="$(jq -r .SecretAccessKey <<<"$creds")"
session_token="$(jq -r '.SessionToken // empty' <<<"$creds")"

# call METHOD PATH [BODY]: signed with SigV4; retries 429, 5xx and a lost
# conditional write (409 CONCURRENT_WRITE) with backoff; fails on anything
# else that is not a 2xx.
call() {
  local method="$1" path="$2" body="${3:-}" attempt status out
  out="$(mktemp)"
  for attempt in 1 2 3 4 5; do
    local args=(--silent --show-error --output "$out" --write-out '%{http_code}' --request "$method"
      --aws-sigv4 "aws:amz:${region}:execute-api" --user "${access_key}:${secret_key}"
      --header 'content-type: application/json')
    [[ -n "$session_token" ]] && args+=(--header "x-amz-security-token: ${session_token}")
    if [[ "$method" == DELETE ]]; then
      [[ -n "$execution_id" ]] && args+=(--header "X-Control-Plane-Execution-Id: ${execution_id}")
      [[ -n "$operator_id" ]] && args+=(--header "X-Control-Plane-Operator-Id: ${operator_id}")
    fi
    [[ -n "$body" ]] && args+=(--data "$body")
    status="$(curl "${args[@]}" "${api_url}${path}")" || status=000
    if [[ "$status" =~ ^2 ]]; then
      rm -f "$out"
      echo "metering: $method $path -> $status"
      return 0
    fi
    if [[ "$status" == 409 && "$(jq -r '.reason // empty' "$out" 2>/dev/null)" != CONCURRENT_WRITE ]]; then
      break
    fi
    if [[ "$status" != 409 && "$status" != 429 && ! "$status" =~ ^5 && "$status" != 000 ]]; then
      break
    fi
    sleep $((attempt * attempt))
  done
  echo "metering: $method $path -> $status $(jq -c '{message, reason}' "$out" 2>/dev/null || true)" >&2
  rm -f "$out"
  return 1
}

case "$EVENT:$PHASE" in
  CELL_CREATE:PRE)
    need CELL_ACCOUNT_ID '^[0-9]{12}$'
    call PUT "/cells/${CELL_ID}/emitter" "$(jq -nc --arg app "$APPLICATION_ID" --arg account "$CELL_ACCOUNT_ID" \
      --arg exec "$execution_id" --arg op "$operator_id" \
      '{applicationId: $app, accountId: $account}
       + (if $exec != "" then {controlPlaneExecutionId: $exec} else {} end)
       + (if $op != "" then {controlPlaneOperatorId: $op} else {} end)')"
    ;;
  CELL_DELETE:POST)
    call DELETE "/cells/${CELL_ID}/emitter"
    ;;
  DEPLOYMENT_CREATE:PRE | DEPLOYMENT_UPDATE:PRE)
    need TENANT_ID '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    billing="${PARAM_BILLING_ACCOUNT:-}"
    if [[ -n "$billing" && ! "$billing" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
      echo "hook environment: PARAM_BILLING_ACCOUNT is outside [A-Za-z0-9._:-]{1,128}" >&2
      exit 1
    fi
    call PUT "/cells/${CELL_ID}/tenants/${TENANT_ID}" "$(jq -nc --arg app "$APPLICATION_ID" --arg billing "$billing" \
      --arg exec "$execution_id" --arg op "$operator_id" \
      '{applicationId: $app}
       + (if $billing != "" then {billingAccount: $billing} else {} end)
       + (if $exec != "" then {controlPlaneExecutionId: $exec} else {} end)
       + (if $op != "" then {controlPlaneOperatorId: $op} else {} end)')"
    ;;
  DEPLOYMENT_DELETE:POST)
    need TENANT_ID '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    call DELETE "/cells/${CELL_ID}/tenants/${TENANT_ID}"
    ;;
  *)
    echo "metering: nothing to do on $EVENT $PHASE"
    ;;
esac
