#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The tenant front door's route hook (spec §3.4, §4.2, §5.2; ADR-0017).
#
# The control plane runs it in its global hook project, in its own account,
# under <fleet>-global-hook (control-plane R-41). scripts/register-hooks.sh
# registers it as two global hooks:
#
#   front-door-post  POST on CELL_CREATE, CELL_UPDATE, DEPLOYMENT_CREATE, DEPLOYMENT_UPDATE
#   front-door-pre   PRE  on CELL_DELETE, DEPLOYMENT_DELETE
#
# A cell POST puts the cell route with the cell script's frontDoorApiDomain
# output; a deployment POST puts the tenant route; a PRE delete removes the
# route before the delete script runs. Every call is signed with the hook
# role's credentials and goes to the registrar named by the front door hook
# parameter in this account. An application with no such parameter has no
# front door, and the hook exits 0 for it (ADR-0014).
#
# Inputs: the control plane's hook environment (control-plane R-42):
# EVENT, PHASE, HOOK_ID, HOOK_SCOPE, APPLICATION_ID, CELL_ID, TENANT_ID and,
# on POST, SCRIPT_OUTPUTS; AWS_REGION, which CodeBuild sets. Needs the AWS
# CLI v2, jq and curl 7.75 or later (--aws-sigv4), all in the CodeBuild
# standard image.
#
# Never prints a credential, a request body or an output value
# (scripts/CONVENTIONS.md).

set -euo pipefail
umask 077

fail() { echo "route-hook: $*"; exit 1; }

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${HOOK_ID:?HOOK_ID env var is required}"
: "${HOOK_SCOPE:?HOOK_SCOPE env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# A wrong registration fails loudly (control-plane scripts/CONVENTIONS.md).
case "${PHASE} ${EVENT}" in
  'POST CELL_CREATE' | 'POST CELL_UPDATE') ACTION=put-cell ;;
  'POST DEPLOYMENT_CREATE' | 'POST DEPLOYMENT_UPDATE') ACTION=put-tenant ;;
  'PRE CELL_DELETE') ACTION=delete-cell ;;
  'PRE DEPLOYMENT_DELETE') ACTION=delete-tenant ;;
  *) fail "${HOOK_ID} runs POST on cell and deployment create and update and PRE on their delete, got ${PHASE} ${EVENT}" ;;
esac
[[ "$HOOK_SCOPE" == GLOBAL ]] || fail "${HOOK_ID} is a global hook, got scope ${HOOK_SCOPE}"
[[ "$APPLICATION_ID" =~ ^[a-z0-9-]{1,32}$ ]] || fail "APPLICATION_ID is not of the form [a-z0-9-]{1,32}"
[[ "$AWS_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || fail "AWS_REGION is not a Region name"

TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT

# read_json VAR FILTER: sets VAR to the string FILTER selects from the JSON
# on stdin, exactly: a command substitution alone would drop a trailing
# newline and let a value with one pass the checks below.
read_json() {
  local v
  v="$(jq -j "$2"; printf x)"
  printf -v "$1" '%s' "${v%x}"
}

# backoff ATTEMPT BASE: sleeps a jittered half to all of BASE * 2^(ATTEMPT-1)
# seconds, so four sleeps take 7.5 to 15 times BASE in all.
backoff() {
  local window=$(($2 << ($1 - 1)))
  sleep $((window / 2 + RANDOM % (window / 2 + 1)))
}

# -- Step 1: the front door hook parameter ------------------------------------
PARAM_NAME="/application-plane/applications/${APPLICATION_ID}/shared/front-door-hook"

# Five attempts on a throttle, over about a minute (backoff base 4 s): the
# hook runs for every application on the control plane. Only
# ParameterNotFound is a skip; any other error fails the hook at once.
read_parameter() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if PARAM_VALUE="$(aws ssm get-parameter --name "$PARAM_NAME" --query Parameter.Value --output text 2>"$TMP/ssm.err")"; then
      return 0
    fi
    if grep -q 'ParameterNotFound' "$TMP/ssm.err"; then
      return 3
    fi
    if grep -qE 'ThrottlingException|TooManyRequestsException' "$TMP/ssm.err" && ((attempt < 5)); then
      echo "route-hook: reading ${PARAM_NAME} was throttled (attempt ${attempt} of 5), retrying"
      backoff "$attempt" 4
      continue
    fi
    fail "reading ${PARAM_NAME} failed: $(head -c 300 "$TMP/ssm.err" | tr -cd '[:print:]')"
  done
}

rc=0
read_parameter || rc=$?
if ((rc == 3)); then
  echo "route-hook: application ${APPLICATION_ID} has no front door (no ${PARAM_NAME}), nothing to do"
  exit 0
fi

jq -e '
  type == "object" and .version == 1
  and (.registrarUrl | type) == "string"
  and (.appDomain | type) == "string"
  and (.addressing == "single" or .addressing == "host")' >/dev/null 2>&1 <<<"$PARAM_VALUE" \
  || fail "${PARAM_NAME} is not a version 1 front door hook parameter"
read_json REGISTRAR_URL .registrarUrl <<<"$PARAM_VALUE"
read_json APP_DOMAIN .appDomain <<<"$PARAM_VALUE"
read_json ADDRESSING .addressing <<<"$PARAM_VALUE"

# The registrar is a regional REST API in this Region (spec §3.1).
[[ "$REGISTRAR_URL" =~ ^https://[a-z0-9]{10}\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?/([A-Za-z0-9._~-]+/)+$ ]] \
  || fail "${PARAM_NAME} registrarUrl is not an API Gateway stage URL ending in /"
[[ "${BASH_REMATCH[1]}" == "$AWS_REGION" ]] || fail "${PARAM_NAME} registrarUrl is not in ${AWS_REGION}"
LABEL='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
[[ "$APP_DOMAIN" =~ ^${LABEL}(\.${LABEL})+$ ]] || fail "${PARAM_NAME} appDomain is not a lower-case DNS name"

# -- Step 2: ids from the environment, the API domain from the outputs --------
ULID='^[0-9A-HJKMNP-TV-Z]{26}$'
case "$ACTION" in
  put-cell | delete-cell)
    : "${CELL_ID:?CELL_ID env var is required on a cell event}"
    [[ "$CELL_ID" =~ $ULID ]] || fail "CELL_ID is not a control-plane id"
    ;;
  *)
    : "${TENANT_ID:?TENANT_ID env var is required on a deployment event}"
    [[ "$TENANT_ID" =~ $ULID ]] || fail "TENANT_ID is not a control-plane id"
    ;;
esac

# SCRIPT_OUTPUTS comes from the cell's account, which a tenant may own
# (control-plane R-43, T44): parse it with jq, refuse a repeated key, check the
# one value used, never eval it and never print a value.
api_domain_from_outputs() {
  : "${SCRIPT_OUTPUTS?SCRIPT_OUTPUTS env var is required on a cell POST}"
  jq -e 'type == "object" and all(.[]; type == "string")' >/dev/null 2>&1 <<<"$SCRIPT_OUTPUTS" \
    || fail "SCRIPT_OUTPUTS is not a JSON object of strings"
  # Plain jq keeps the last value of a repeated key; the stream sees each one.
  jq -en --stream '[inputs | select(length == 2 and (.[0] | length) == 1) | .[0][0]] | length == (unique | length)' \
    >/dev/null 2>&1 <<<"$SCRIPT_OUTPUTS" || fail "SCRIPT_OUTPUTS has a repeated key"
  read_json API_DOMAIN '.frontDoorApiDomain // empty' <<<"$SCRIPT_OUTPUTS"
  [[ -n "$API_DOMAIN" ]] || fail "the cell script wrote no frontDoorApiDomain output (spec §5.2)"
  [[ "$API_DOMAIN" =~ ^[a-z0-9]{32}\.lambda-url\.${AWS_REGION}\.on\.aws$ ]] \
    || fail "frontDoorApiDomain is not a Lambda function URL host in ${AWS_REGION} (spec §3.4 step 3)"
}

# -- Step 3: the hook role's credentials, in a mode-600 curl config -----------
CURL_CONFIG="$TMP/curl.config"
load_credentials() {
  local creds ak sk st
  creds="$(aws configure export-credentials --format process 2>/dev/null)" \
    || fail "the build has no credentials (aws configure export-credentials failed)"
  ak="$(jq -r '.AccessKeyId // empty' <<<"$creds")"
  sk="$(jq -r '.SecretAccessKey // empty' <<<"$creds")"
  st="$(jq -r '.SessionToken // empty' <<<"$creds")"
  [[ "$ak" =~ ^[A-Z0-9]{16,128}$ && "$sk" =~ ^[A-Za-z0-9/+=]{16,128}$ && "$st" =~ ^[A-Za-z0-9/+=]*$ ]] \
    || fail "the build's credentials are not in the expected form"
  : >"$CURL_CONFIG"
  chmod 600 "$CURL_CONFIG"
  # printf is a builtin: the values never reach a process's command line.
  printf 'user = "%s:%s"\n' "$ak" "$sk" >>"$CURL_CONFIG"
  if [[ -n "$st" ]]; then
    printf 'header = "x-amz-security-token: %s"\n' "$st" >>"$CURL_CONFIG"
  fi
}

# registrar METHOD PATH [JSON]: one signed call; the status in STATUS, the
# answer in $TMP/body.
REGISTRAR_REGION="$AWS_REGION"
registrar() {
  local args=(-sS -o "$TMP/body" -w '%{http_code}' --connect-timeout 10 --max-time 30
    -X "$1" --aws-sigv4 "aws:amz:${REGISTRAR_REGION}:execute-api" -K "$CURL_CONFIG")
  if [[ -n "${3:-}" ]]; then
    printf '%s' "$3" >"$TMP/request"
    args+=(-H 'Content-Type: application/json' --data-binary "@$TMP/request")
  fi
  : >"$TMP/body"
  STATUS="$(curl "${args[@]}" "${REGISTRAR_URL}$2" 2>"$TMP/curl.err")" || STATUS=000
}

# -- Step 4: act on the answer --------------------------------------------------
# 200 or 202 succeed. 503, 429, another 5xx or no answer: five attempts over
# about two minutes (backoff base 8 s), because the control plane retries no
# create or update hook (control-plane R-46). Anything else fails at once:
# a retry would not change it. The hook never sends customDomain, so its
# 429 is a throttle.
call_registrar() { # WHAT METHOD PATH [JSON]
  local what="$1" attempt
  shift
  for attempt in 1 2 3 4 5; do
    registrar "$@"
    case "$STATUS" in
      200 | 202) echo "route-hook: ${what}: HTTP ${STATUS}"; return 0 ;;
      507) ;;
      429 | 5?? | 000)
        if ((attempt < 5)); then
          if [[ "$STATUS" == 000 ]]; then
            echo "route-hook: ${what}: no answer ($(head -c 200 "$TMP/curl.err" | tr -cd '[:print:]')), attempt ${attempt} of 5, retrying"
          else
            echo "route-hook: ${what}: HTTP ${STATUS} (attempt ${attempt} of 5), retrying"
          fi
          backoff "$attempt" 8
          continue
        fi
        ;;
    esac
    # The registrar's error body is {message, reason?}; it holds no token.
    fail "${what}: HTTP ${STATUS}: $(head -c 512 "$TMP/body" | tr -cd '[:print:]')"
  done
}

# -- Propagation (spec §4.2) ---------------------------------------------------
PROPAGATION_SECONDS=45
POLL_SECONDS=3

wait_bound() {
  echo "route-hook: waiting ${PROPAGATION_SECONDS} s for the route to reach the edge"
  sleep "$PROPAGATION_SECONDS"
}

# poll_tenant_host WANT [DT]: host mode only. Polls the tenant's own
# /config.json until it answers 200 with rev == DT (a put) or 404 (a delete),
# for at most 45 s. Late propagation is a warning, never a failure: the
# write has succeeded.
poll_tenant_host() {
  local want="$1" dt="${2:-}" host polls=0 st deadline=$((SECONDS + PROPAGATION_SECONDS))
  host="${TENANT_ID,,}.${APP_DOMAIN}"
  while ((SECONDS < deadline && polls < PROPAGATION_SECONDS / POLL_SECONDS)); do
    polls=$((polls + 1))
    st="$(curl -s -o "$TMP/config.json" -w '%{http_code}' --max-time "$POLL_SECONDS" "https://${host}/config.json" 2>/dev/null)" || st=000
    if [[ "$want" == gone && "$st" == 404 ]]; then
      echo "route-hook: ${host} answers 404 at the edge"
      return 0
    fi
    if [[ "$want" == rev && "$st" == 200 ]] && jq -e --argjson dt "$dt" '.rev == $dt' "$TMP/config.json" >/dev/null 2>&1; then
      echo "route-hook: ${host} serves the route at the edge"
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  echo "route-hook: warning: ${host} did not show the change within ${PROPAGATION_SECONDS} s; the write succeeded, only propagation is late"
}

# -- Run -------------------------------------------------------------------------
case "$ACTION" in
  put-cell)
    api_domain_from_outputs
    load_credentials
    call_registrar "PutCellRoute ${CELL_ID}" PUT "cells/${CELL_ID}" "$(jq -nc --arg d "$API_DOMAIN" '{apiDomain: $d}')"
    wait_bound
    ;;
  delete-cell)
    load_credentials
    call_registrar "DeleteCellRoute ${CELL_ID}" DELETE "cells/${CELL_ID}"
    wait_bound
    ;;
  put-tenant)
    load_credentials
    call_registrar "PutTenantRoute ${TENANT_ID}" PUT "tenants/${TENANT_ID}" '{}'
    if [[ "$ADDRESSING" == host ]]; then
      DT="$(jq -r '.dt // empty' "$TMP/body" 2>/dev/null || true)"
      if [[ "$DT" =~ ^[0-9]{1,16}$ ]]; then
        poll_tenant_host rev "$DT"
      else
        echo "route-hook: warning: the registrar's answer has no dt, waiting the full bound"
        wait_bound
      fi
    else
      wait_bound
    fi
    ;;
  delete-tenant)
    load_credentials
    call_registrar "DeleteTenantRoute ${TENANT_ID}" DELETE "tenants/${TENANT_ID}"
    if [[ "$ADDRESSING" == host ]]; then
      poll_tenant_host gone
    else
      wait_bound
    fi
    ;;
esac
