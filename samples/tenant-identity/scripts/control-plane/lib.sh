#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared helpers for the control-plane mount scripts (ADR-0028, mounting spec
# §7). Sourced by scripts/control-plane/{tenant,cell}/*.sh, never run.
#
#   read_identity_param NAME VAR    -> VAR=/application-plane/shared/identity/NAME
#   refuse_tiered TOPOLOGY          -> exit 1 with the M-R-7 text when tiered
#   platform_call METHOD TEMPLATE [BODY] [QUERY]
#                                   -> SigV4 call to the platform API; sets
#                                      PLATFORM_STATUS and PLATFORM_BODY
#   PLATFORM_REQUEST_FILE           -> mode-0600 scratch file for anything that
#                                      must reach a command without argv
#
# Runs inside the control-plane tenant/cell CodeBuild project (image
# standard:7.0: bash, AWS CLI v2, curl >= 7.75, jq) as the tenant build role.
# Hygiene (scripts/CONVENTIONS.md, spec M-P-5): no set -x; SigV4 credentials
# reach curl through a config on stdin, request bodies and the parked password
# through a mode-0600 temp file, never on a command line; the log shows method,
# path template and HTTP status, never a body, password, credential or e-mail.

set -euo pipefail

: "${AWS_REGION:?AWS_REGION env var is required}"
: "${OPERATOR_ID:?OPERATOR_ID env var is required}"

for tool in aws curl jq; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done

IDENTITY_NS="/application-plane/shared/identity"
TIERED_REFUSAL="tiered identity needs a per-tenant tier; not supported when mounted"

fail() { echo "FAILED: $*" >&2; exit 1; }

# M-P-1: TENANT_ID is spliced unencoded into URL paths and SSM parameter names,
# so it must be the control plane's ULID (Crockford base32, 26 chars). The
# message carries no value.
if [[ -n "${TENANT_ID:-}" ]]; then
  [[ "$TENANT_ID" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]] || fail "TENANT_ID is not a ULID"
fi

# Private scratch directory (mode 0700), removed on every exit. Holds the
# request body file and the CLI's stderr; nothing in it outlives the script.
PLATFORM_SCRATCH="$(mktemp -d)"
chmod 700 "$PLATFORM_SCRATCH"
trap 'rm -rf "$PLATFORM_SCRATCH"' EXIT

# Anything that must reach a command without going through argv (a request
# body, the parked password) travels through this file: other local users can
# read /proc/<pid>/cmdline while a command runs. Truncate it after each use.
PLATFORM_REQUEST_FILE="$PLATFORM_SCRATCH/request"
: >"$PLATFORM_REQUEST_FILE"
chmod 600 "$PLATFORM_REQUEST_FILE"
PLATFORM_ERR_FILE="$PLATFORM_SCRATCH/stderr"

# aws_error_class FILE -> the error class in "An error occurred (Class) when
# calling ..." captured in FILE, or "unknown error". Never the full text.
aws_error_class() {
  local err class="unknown error"
  err="$(cat "$1" 2>/dev/null || true)"
  [[ "$err" =~ \(([A-Za-z0-9_.]+)\) ]] && class="${BASH_REMATCH[1]}"
  printf '%s' "$class"
}

# read_identity_param NAME VAR -> stores the value of the shared identity
# parameter in VAR. ParameterNotFound exits 1 naming the parameter and the
# fix (spec §7.1 step 1); any other CLI error exits 1 naming the parameter and
# the error class, so a denied read is not mistaken for a missing deployment.
# Logs the parameter name only.
read_identity_param() {
  local name="${IDENTITY_NS}/$1" value class
  if ! value="$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text 2>"$PLATFORM_ERR_FILE")"; then
    class="$(aws_error_class "$PLATFORM_ERR_FILE")"
    : >"$PLATFORM_ERR_FILE"
    [[ "$class" != ParameterNotFound ]] \
      || fail "parameter ${name} is missing; deploy tenant-identity in ${AWS_REGION} first"
    fail "get-parameter ${name} failed (${class})"
  fi
  [[ -n "$value" && "$value" != None ]] || fail "parameter ${name} is empty"
  printf -v "$2" '%s' "$value"
  echo "Read ${name}"
}

# refuse_tiered TOPOLOGY -> exit 1 with the M-R-7 text when the deployment is tiered.
refuse_tiered() {
  [[ "$1" != tiered ]] || fail "$TIERED_REFUSAL"
}

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

# platform_call METHOD TEMPLATE [BODY] [QUERY]
#
# TEMPLATE is the route with `{tenantId}` unexpanded, e.g.
# `platform/tenants/{tenantId}`; it is what the log line shows. QUERY is an
# already URL-encoded query string (e.g. a pagination token) appended after
# `?`; it is never logged. Needs API_URL (from read_identity_param apiUrl).
# Prints exactly "<METHOD> <template> -> HTTP <code>" and leaves the status in
# PLATFORM_STATUS and the response body in PLATFORM_BODY (a variable, not a
# file, so a returned temporary password never touches disk). A transport
# failure exits 1 with curl's exit code (6 DNS, 7 connect, 28 timeout, 60 TLS).
platform_call() {
  local method="$1" template="$2" body="${3:-}" query="${4:-}"
  : "${API_URL:?API_URL must be read before calling the platform API}"
  local base="${API_URL%/}/" path="${template//\{tenantId\}/${TENANT_ID:-}}" config out rc=0
  [[ -z "$query" ]] || path+="?${query}"

  platform_credentials
  config="user = \"${PLATFORM_AK}:${PLATFORM_SK}\""
  [[ -z "$PLATFORM_ST" ]] || config+=$'\n'"header = \"x-amz-security-token: ${PLATFORM_ST}\""

  local args=(-s -X "$method" --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --config -
    -w $'\n%{http_code}')
  if [[ -n "$body" ]]; then
    printf '%s' "$body" >"$PLATFORM_REQUEST_FILE"
    args+=(-H 'Content-Type: application/json' --data-binary "@${PLATFORM_REQUEST_FILE}")
  fi

  out="$(curl "${args[@]}" "${base}${path}" <<<"$config")" || rc=$?
  : >"$PLATFORM_REQUEST_FILE"
  [[ "$rc" -eq 0 ]] || fail "${method} ${template}: curl exit ${rc}"

  PLATFORM_STATUS="${out##*$'\n'}"
  # shellcheck disable=SC2034  # read by the sourcing script
  PLATFORM_BODY="${out%$'\n'*}"
  echo "${method} ${template} -> HTTP ${PLATFORM_STATUS}"
}
