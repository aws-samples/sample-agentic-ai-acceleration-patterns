# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Helpers shared by demo.sh and integ.sh. Source it; do not run it.
#
# Hygiene (scripts/CONVENTIONS.md): tokens, passwords and SigV4 keys live in
# shell variables only. They reach curl through a config on stdin or a
# mode-0600 temp file, never through process arguments (other local users can
# read /proc/<pid>/cmdline), and nothing here prints them.
#
# The caller sets: REGION, LIB_TMP (a mktemp -d directory it removes on exit).

IDENTITY_PREFIX="/application-plane/shared/identity"
PARAM_PREFIX="/application-plane/shared/agent-runtime"
SESSION_HEADER="X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
GRANT_TYPE='urn:ietf:params:oauth:grant-type:token-exchange'
REFRESH_TYPE='urn:ietf:params:oauth:token-type:refresh_token'

BODY="${LIB_TMP}/body"
REQ="${LIB_TMP}/request"
: >"$BODY"
: >"$REQ"
chmod 600 "$BODY" "$REQ"

fail() { echo "FAILED: $*" >&2; exit 1; }
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }

# -- SigV4 credentials for tenant-identity's platform API (never printed) ---
load_sigv4() {
  local creds
  creds="$(aws configure export-credentials --format process)" || fail "no AWS credentials found"
  SIGV4_AK="$(jq -r .AccessKeyId <<<"$creds")"
  SIGV4_SK="$(jq -r .SecretAccessKey <<<"$creds")"
  SIGV4_ST="$(jq -r '.SessionToken // empty' <<<"$creds")"
}

# platform METHOD PATH [JSON] -> HTTP status; body in $BODY.
platform() {
  local method="$1" path="$2" data="${3:-}" config
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" --aws-sigv4 "aws:amz:${REGION}:execute-api" --config -)
  config="user = \"${SIGV4_AK}:${SIGV4_SK}\""
  [[ -n "$SIGV4_ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${SIGV4_ST}\""
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQ"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQ")
  fi
  curl "${args[@]}" "${IDENTITY_API}${path}" <<<"$config"
}

# identity_init: resolves tenant-identity's API and app client from SSM.
identity_init() {
  IDENTITY_API="$(param "${IDENTITY_PREFIX}/apiUrl")" || fail "tenant-identity parameter ${IDENTITY_PREFIX}/apiUrl not found; deploy tenant-identity shared-pool first"
  [[ "$IDENTITY_API" == */ ]] || IDENTITY_API="${IDENTITY_API}/"
  APP_CLIENT_ID="$(param "${IDENTITY_PREFIX}/appClientId")"
  local topology
  topology="$(param "${IDENTITY_PREFIX}/topology")"
  [[ "$topology" == shared-pool ]] || fail "tenant-identity topology is ${topology}; this sample needs shared-pool (ADR-0004)"
  load_sigv4
}

CREATED_TENANTS=()

# create_tenant NAME -> sets TENANT_ID and ADMIN_USERNAME.
create_tenant() {
  local status
  status="$(platform POST platform/tenants \
    "$(jq -nc --arg n "$1" --arg e "success+${1}-admin@simulator.amazonses.com" '{name: $n, adminEmail: $e}')")"
  [[ "$status" == 201 ]] || fail "CreateTenant $1: HTTP ${status}"
  TENANT_ID="$(jq -r .tenant.tenantId "$BODY")"
  ADMIN_USERNAME="$(jq -r .admin.user.username "$BODY")"
  CREATED_TENANTS+=("$TENANT_ID")
}

# create_user TENANT_ID LABEL -> sets USERNAME.
create_user() {
  local status
  status="$(platform POST "platform/tenants/$1/users" \
    "$(jq -nc --arg e "success+${2}@simulator.amazonses.com" '{email: $e}')")"
  [[ "$status" == 201 ]] || fail "CreateUser ${2}: HTTP ${status}"
  USERNAME="$(jq -r .user.username "$BODY")"
}

# issue_token TENANT_ID USERNAME PREFIX -> sets ${PREFIX}_ACCESS, ${PREFIX}_ID, ${PREFIX}_REFRESH.
# IssueToken is tenant-identity's test aid (its ADR-0006).
issue_token() {
  local status password
  password="Rt-Iso-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')!"
  status="$(platform POST "platform/tenants/$1/users/$2/token" "$(printf '%s' "$password" | jq -Rs '{password: .}')")"
  [[ "$status" == 200 ]] || fail "IssueToken for ${3}: HTTP ${status}"
  printf -v "${3}_ACCESS" '%s' "$(jq -r .accessToken "$BODY")"
  printf -v "${3}_ID" '%s' "$(jq -r .idToken "$BODY")"
  printf -v "${3}_REFRESH" '%s' "$(jq -r .refreshToken "$BODY")"
  : >"$BODY"
}

urlencode() { jq -sRr @uri; }

# tamper TOKEN_VAR -> the token with one signature character changed (never printed by callers).
# A middle character: the last base64url character of an RS256 signature
# carries padding bits, so changing it may leave the signature bytes intact.
tamper() {
  local t="${!1}" head sig c
  head="${t%.*}"; sig="${t##*.}"; c="${sig:5:1}"
  if [[ "$c" == A ]]; then c=B; else c=A; fi
  printf '%s.%s%s%s' "$head" "${sig:0:5}" "$c" "${sig:6}"
}

# narrow REFRESH_VAR TENANT_ID SCOPE OUT_VAR -> sets NARROW_STATUS, and OUT_VAR on 200 (RFC 8693, tenant-identity ADR-0009).
# Call it directly, never in $(...): a subshell would lose OUT_VAR.
narrow() {
  local refresh="${!1}" status
  printf 'grant_type=%s&client_id=%s&subject_token=%s&subject_token_type=%s&resource=%s&scope=%s' \
    "$(printf '%s' "$GRANT_TYPE" | urlencode)" \
    "$(printf '%s' "$APP_CLIENT_ID" | urlencode)" \
    "$(printf '%s' "$refresh" | urlencode)" \
    "$(printf '%s' "$REFRESH_TYPE" | urlencode)" \
    "$(printf '%s' "urn:tenant-identity:tenant:$2" | urlencode)" \
    "$(printf '%s' "$3" | urlencode)" >"$REQ"
  status="$(curl -s -o "$BODY" -w '%{http_code}' -X POST "${IDENTITY_API}oauth2/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' --data-binary "@$REQ")"
  : >"$REQ"
  if [[ "$status" == 200 ]]; then
    printf -v "$4" '%s' "$(jq -r .access_token "$BODY")"
    : >"$BODY"
  fi
  NARROW_STATUS="$status"
}

# delete_tenants: offboards every tenant this run created (exit trap).
delete_tenants() {
  local t
  for t in "${CREATED_TENANTS[@]:-}"; do
    [[ -n "$t" ]] || continue
    platform DELETE "platform/tenants/${t}" >/dev/null 2>&1 || true
  done
  CREATED_TENANTS=()
}

# -- The agentic-runtime-isolation endpoint ---------------------------------

LAST_TTFB=""
LAST_TOTAL=""
: >"${LIB_TMP}/timing"

# invoke ENDPOINT TOKEN_VAR JSON [SESSION_HEADER_VALUE] -> HTTP status; body in $BODY.
# TOKEN_VAR is a variable NAME (empty name: no Authorization header).
# Writes TTFB and total seconds for timing().
invoke() {
  local endpoint="$1" token_var="$2" json="$3" fake_session="${4:-}" config="" out status ttfb total
  [[ -n "$token_var" ]] && config="header = \"Authorization: Bearer ${!token_var}\""
  [[ -n "$fake_session" ]] && config+=$'\n'"header = \"${SESSION_HEADER}: ${fake_session}\""
  printf '%s' "$json" >"$REQ"
  out="$(curl -s -N --max-time 180 -o "$BODY" -w '%{http_code} %{time_starttransfer} %{time_total}' -X POST "$endpoint" \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' --data-binary "@$REQ" --config - <<<"$config")"
  read -r status ttfb total <<<"$out"
  printf '%s %s\n' "$ttfb" "$total" >"${LIB_TMP}/timing"
  echo "$status"
}

# timing: sets LAST_TTFB and LAST_TOTAL from the last invoke (it runs in $(...), so it cannot set them itself).
timing() { read -r LAST_TTFB LAST_TOTAL <"${LIB_TMP}/timing"; }

# The agent answers as SSE (ADR-0017): the report is the first `data:` event, the last event is `event: usage`.
report_json() { grep -m1 '^data: ' "$BODY" | sed 's/^data: //'; }
report_field() { report_json | jq -r "$1"; }
usage_json() { awk '/^event: usage/{u=1;next} u&&/^data: /{sub(/^data: /,""); print; exit}' "$BODY"; }
error_event() { awk '/^event: error/{u=1;next} u&&/^data: /{sub(/^data: /,""); print; exit}' "$BODY"; }
data_events() { grep -c '^data: ' "$BODY" || true; }

# expect_status WANT GOT WHAT (WANT may be "401|403").
expect_status() {
  [[ "$2" =~ ^(${1})$ ]] || fail "$3: expected HTTP $1, got $2"
  echo "  $3 -> HTTP $2"
}

# percentile P FILE -> the P-th percentile (nearest rank) of one number per line.
percentile() {
  sort -n "$2" | awk -v p="$1" '{v[NR]=$1} END {i=int((p/100)*NR+0.999999); if (i<1) i=1; if (i>NR) i=NR; printf "%.3f", v[i]}'
}
