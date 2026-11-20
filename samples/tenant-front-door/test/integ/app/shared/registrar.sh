#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Sourced by the integration test's application scripts (spec §10 steps
# 11 to 13): calls the front door's registrar with the credentials the
# script runs under, an account role pair role, and records what it got.
# TEST ONLY. Logs ids and statuses, never a credential or a body
# (scripts/CONVENTIONS.md).

PROBE_RESULTS='{}'
PROBE_FAILS=0

# registrar_url: the registrar's stage URL, from the edge parameter in the
# edge account, or from this application's front door hook parameter in
# the control plane's account. Prints nothing and returns 1 when neither
# is readable.
registrar_url() {
  local value url
  if value="$(aws ssm get-parameter --name /application-plane/shared/front-door/edge --query Parameter.Value --output text 2>/dev/null)"; then
    url="$(jq -r '.registrarUrl // empty' <<<"$value")"
  elif value="$(aws ssm get-parameter --name "/application-plane/applications/${APPLICATION_ID}/shared/front-door-hook" --query Parameter.Value --output text 2>/dev/null)"; then
    url="$(jq -r '.registrarUrl // empty' <<<"$value")"
  fi
  [[ "${url:-}" =~ ^https://[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com/[A-Za-z0-9._~-]+/$ ]] || return 1
  printf '%s' "$url"
}

# registrar_call METHOD PATH [JSON] -> the HTTP status, 000 for no answer.
# Signed with the script's own credentials, which reach curl in a 0600
# config file, never on its command line. It runs in a subshell, so its EXIT
# trap removes that file on every exit, a failed command under set -e too.
registrar_call() (
  local dir creds status
  dir="$(mktemp -d)"
  trap 'rm -f "$dir"/*; rmdir "$dir"' EXIT
  creds="$(aws configure export-credentials --format process)"
  {
    printf 'user = "%s:%s"\n' "$(jq -r .AccessKeyId <<<"$creds")" "$(jq -r .SecretAccessKey <<<"$creds")"
    if [[ -n "$(jq -r '.SessionToken // empty' <<<"$creds")" ]]; then
      printf 'header = "x-amz-security-token: %s"\n' "$(jq -r .SessionToken <<<"$creds")"
    fi
  } >"$dir/config"
  chmod 600 "$dir/config"
  local args=(-s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 -X "$1" --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" -K "$dir/config")
  if [[ -n "${3:-}" ]]; then
    printf '%s' "$3" >"$dir/body"
    args+=(-H 'Content-Type: application/json' --data-binary "@$dir/body")
  fi
  status="$(curl "${args[@]}" "${REGISTRAR_URL}$2" 2>/dev/null)" || status=000
  printf '%s' "$status"
)

# probe_expect NAME WANT METHOD PATH [JSON]: one call; records NAME=status
# in PROBE_RESULTS and counts a mismatch in PROBE_FAILS.
probe_expect() {
  local got
  got="$(registrar_call "$3" "$4" "${5:-}")"
  PROBE_RESULTS="$(jq -c --arg k "$1" --arg v "$got" '. + {($k): $v}' <<<"$PROBE_RESULTS")"
  if [[ "$got" == "$2" ]]; then
    echo "registrar probe ${1}: ${got}"
  else
    echo "registrar probe ${1}: want ${2}, got ${got}"
    PROBE_FAILS=$((PROBE_FAILS + 1))
  fi
}

# probe_finish PARAMETER: writes the results to PARAMETER, in the script's
# own namespace, and fails the script when any call answered otherwise, so
# the operation lands in a *_FAILED status.
probe_finish() {
  aws ssm put-parameter --name "$1" --type String --overwrite --value "$PROBE_RESULTS" >/dev/null
  echo "Wrote ${1}"
  if (( PROBE_FAILS > 0 )); then
    echo "registrar probe: ${PROBE_FAILS} answer(s) differ"
    exit 1
  fi
}
