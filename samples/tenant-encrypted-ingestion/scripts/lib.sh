# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# shellcheck shell=bash disable=SC2034
#
# Helpers shared by demo.sh and integ.sh. Source it; do not run it.
#
# Hygiene (scripts/CONVENTIONS.md): tokens, presigned URLs and SigV4 keys live
# in shell variables only. They reach curl through a config on stdin or a
# mode-0600 temp file, never through process arguments, and nothing here
# prints them.
#
# The caller sets: REGION, LIB_TMP (a mktemp -d directory it removes on exit).

IDENTITY_PREFIX="/application-plane/shared/identity"
PARAM_PREFIX="/application-plane/shared/ingestion"
# The scopes this sample registers (src/shared/constants.ts SCOPES), for callers.
DELIVER_SCOPE='ingestion/deliver'
READ_SCOPE='ingestion/read'

BODY="${LIB_TMP}/body"
REQ="${LIB_TMP}/request"
: >"$BODY"
: >"$REQ"
chmod 600 "$BODY" "$REQ"

fail() { echo "FAILED: $*" >&2; exit 1; }
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }

# load_sigv4: the ambient credentials for curl's --aws-sigv4 (never printed).
load_sigv4() {
  local creds
  creds="$(aws configure export-credentials --format process)" || fail "no AWS credentials found"
  SIGV4_AK="$(jq -r .AccessKeyId <<<"$creds")"
  SIGV4_SK="$(jq -r .SecretAccessKey <<<"$creds")"
  SIGV4_ST="$(jq -r '.SessionToken // empty' <<<"$creds")"
}

# signed BASE_URL METHOD PATH [JSON] -> HTTP status; body in $BODY.
signed() {
  local base="$1" method="$2" path="$3" data="${4:-}" config
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" --aws-sigv4 "aws:amz:${REGION}:execute-api" --config -)
  config="user = \"${SIGV4_AK}:${SIGV4_SK}\""
  [[ -n "$SIGV4_ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${SIGV4_ST}\""
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQ"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQ")
  fi
  curl "${args[@]}" "${base}${path}" <<<"$config"
}

# ingestion_init: this sample's published API URL and bucket.
ingestion_init() {
  INGESTION_API="$(param "${PARAM_PREFIX}/apiUrl")" || fail "parameter ${PARAM_PREFIX}/apiUrl not found; deploy the demo stack first"
  [[ "$INGESTION_API" == */ ]] || INGESTION_API="${INGESTION_API}/"
  INGESTION_BUCKET="$(param "${PARAM_PREFIX}/bucketName")"
  load_sigv4
}

# identity_init: tenant-identity's API (shared-pool).
identity_init() {
  IDENTITY_API="$(param "${IDENTITY_PREFIX}/apiUrl")" || fail "parameter ${IDENTITY_PREFIX}/apiUrl not found; deploy tenant-identity shared-pool first"
  [[ "$IDENTITY_API" == */ ]] || IDENTITY_API="${IDENTITY_API}/"
  load_sigv4
}

# platform METHOD PATH [JSON]: this sample's /platform (IAM).
platform() { signed "$INGESTION_API" "$@"; }
# identity_platform METHOD PATH [JSON]: tenant-identity's /platform (IAM).
identity_platform() { signed "$IDENTITY_API" "$@"; }

# tenant_call METHOD PATH TOKEN_VAR [JSON] -> HTTP status; body in $BODY.
# TOKEN_VAR is a variable NAME; its value reaches curl through stdin only.
tenant_call() {
  local method="$1" path="$2" token="${!3}" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" --config -)
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQ"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQ")
  fi
  curl "${args[@]}" "${INGESTION_API}${path}" <<<"header = \"Authorization: Bearer ${token}\""
}

# upload FILE: PUTs FILE to the presigned URL in $BODY with the returned
# headers (spec §7.5). The URL and headers go to curl through a config file
# (mode 0600), never argv. -> HTTP status.
upload() {
  local file="$1" cfg="${LIB_TMP}/upload.cfg"
  : >"$cfg"
  chmod 600 "$cfg"
  {
    printf 'url = "%s"\n' "$(jq -r .uploadUrl "$BODY")"
    jq -r '.headers | to_entries[] | "header = \"\(.key): \(.value)\""' "$BODY"
  } >"$cfg"
  curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary "@${file}" --config "$cfg"
  : >"$cfg"
}

# synthetic_pdf PAGES FILE: a small synthetic PDF with PAGES page objects.
synthetic_pdf() {
  {
    printf '%%PDF-1.7\n1 0 obj << /Type /Pages /Count %s >> endobj\n' "$1"
    for _ in $(seq "$1"); do printf '2 0 obj << /Type /Page >> endobj\n'; done
    printf '%%%%EOF\n'
  } >"$2"
}

# expect_status EXPECTED ACTUAL WHAT
expect_status() {
  [[ "$2" == "$1" ]] || fail "$3: expected HTTP $1, got $2"
  echo "  ok: $3 -> HTTP $2"
}
