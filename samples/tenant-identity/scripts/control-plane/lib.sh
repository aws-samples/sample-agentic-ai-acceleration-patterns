#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared helpers for the control-plane mount scripts (ADR-0028, mounting spec
# §7). Sourced by scripts/control-plane/{tenant,cell}/*.sh, never run.
#
#   read_identity_param NAME VAR    -> VAR=/application-plane/shared/identity/NAME
#   refuse_tiered TOPOLOGY          -> exit 1 with the M-R-7 text when tiered
#   platform_call METHOD TEMPLATE [BODY]
#                                   -> SigV4 call to the platform API; sets
#                                      PLATFORM_STATUS and PLATFORM_BODY
#
# Runs inside the control-plane tenant/cell CodeBuild project (image
# standard:7.0: bash, AWS CLI v2, curl >= 7.75, jq) as the tenant build role.
# Hygiene (scripts/CONVENTIONS.md, spec M-P-5): no set -x; SigV4 credentials
# reach curl through a config on stdin and request bodies through a mode-0600
# temp file, never on a command line; the log shows method, path template and
# HTTP status, never a body, password, credential or e-mail.

set -euo pipefail

: "${AWS_REGION:?AWS_REGION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"

for tool in aws curl jq; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done

IDENTITY_NS="/application-plane/shared/identity"
TIERED_REFUSAL="tiered identity needs a per-tenant tier; not supported when mounted"

fail() { echo "FAILED: $*" >&2; exit 1; }

# read_identity_param NAME VAR -> stores the value of the shared identity
# parameter in VAR; exit 1 naming the parameter when it is missing (spec §7.1
# step 1). Logs the parameter name only.
read_identity_param() {
  local name="${IDENTITY_NS}/$1" value
  value="$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text 2>/dev/null)" \
    || fail "parameter ${name} is missing; deploy tenant-identity in ${AWS_REGION} first"
  [[ -n "$value" && "$value" != None ]] || fail "parameter ${name} is empty"
  printf -v "$2" '%s' "$value"
  echo "Read ${name}"
}

# refuse_tiered TOPOLOGY -> exit 1 with the M-R-7 text when the deployment is tiered.
refuse_tiered() {
  [[ "$1" != tiered ]] || fail "$TIERED_REFUSAL"
}

# The request body travels to curl through this file, never through argv:
# other local users can read /proc/<pid>/cmdline while a request runs.
PLATFORM_REQUEST_FILE="$(mktemp)"
chmod 600 "$PLATFORM_REQUEST_FILE"
trap 'rm -f "$PLATFORM_REQUEST_FILE"' EXIT

# Credentials of the current role, held in variables and loaded on first use.
PLATFORM_AK="" PLATFORM_SK="" PLATFORM_ST=""
platform_credentials() {
  [[ -z "$PLATFORM_AK" ]] || return 0
  local creds
  creds="$(aws configure export-credentials --format process)" \
    || fail "no AWS credentials for SigV4 (aws configure export-credentials)"
  PLATFORM_AK="$(jq -r .AccessKeyId <<<"$creds")"
  PLATFORM_SK="$(jq -r .SecretAccessKey <<<"$creds")"
  PLATFORM_ST="$(jq -r '.SessionToken // empty' <<<"$creds")"
  unset creds
}

# platform_call METHOD TEMPLATE [BODY]
#
# TEMPLATE is the route with `{tenantId}` unexpanded, e.g.
# `platform/tenants/{tenantId}`; it is what the log line shows. Needs API_URL
# (from read_identity_param apiUrl). Prints exactly
# "<METHOD> <template> -> HTTP <code>" and leaves the status in
# PLATFORM_STATUS and the response body in PLATFORM_BODY (a variable, not a
# file, so a returned temporary password never touches disk).
platform_call() {
  local method="$1" template="$2" body="${3:-}"
  : "${API_URL:?API_URL must be read before calling the platform API}"
  local base="${API_URL%/}/" path="${template//\{tenantId\}/${TENANT_ID:-}}" config out

  platform_credentials
  config="user = \"${PLATFORM_AK}:${PLATFORM_SK}\""
  [[ -z "$PLATFORM_ST" ]] || config+=$'\n'"header = \"x-amz-security-token: ${PLATFORM_ST}\""

  local args=(-s -X "$method" --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --config -
    -w $'\n%{http_code}')
  if [[ -n "$body" ]]; then
    printf '%s' "$body" >"$PLATFORM_REQUEST_FILE"
    args+=(-H 'Content-Type: application/json' --data-binary "@${PLATFORM_REQUEST_FILE}")
  fi

  out="$(curl "${args[@]}" "${base}${path}" <<<"$config")" \
    || fail "${method} ${template}: curl failed"
  : >"$PLATFORM_REQUEST_FILE"

  PLATFORM_STATUS="${out##*$'\n'}"
  # shellcheck disable=SC2034  # read by the sourcing script
  PLATFORM_BODY="${out%$'\n'*}"
  echo "${method} ${template} -> HTTP ${PLATFORM_STATUS}"
}
