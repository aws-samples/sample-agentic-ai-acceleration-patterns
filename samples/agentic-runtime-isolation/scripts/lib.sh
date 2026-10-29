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
# The scope a tenant admin narrows to for the tenant API (tenant-identity ADR-0009).
TENANT_ADMIN_SCOPE='tenant-admin/users'

# The scopes the demo's backends own (ADR-0025). MUST match DEFAULT_SCOPES and
# BILLING_SCOPES exported by src/demo.cdk.ts: the default backend owns one,
# billing owns two, any one of a backend's scopes opens that backend. A
# tenant holds a scope only when CreateTenant lists it (tenant-identity
# ADR-0035); a user holds it only when the tenant does and the tenant admin
# has not cut it (ADR-0036). The scripts create their tenants with these.
DEFAULT_SCOPE='default/chat'
BILLING_READ_SCOPE='billing/read'
BILLING_INVOKE_SCOPE='billing/invoke'
ALL_DEMO_SCOPES="${DEFAULT_SCOPE} ${BILLING_READ_SCOPE} ${BILLING_INVOKE_SCOPE}"

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

# scopes_json "a b c" -> ["a","b","c"] (an empty string is []).
scopes_json() { printf '%s' "$1" | jq -Rc 'split(" ") | map(select(length > 0))'; }

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

# tenant_api METHOD PATH TOKEN_VAR [JSON] -> HTTP status; body in $BODY.
# The tenant API (`/tenant/*`) takes a bearer token narrowed to
# tenant-admin/users; TOKEN_VAR is a variable NAME, never printed.
tenant_api() {
  local method="$1" path="$2" token_var="$3" data="${4:-}" config
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" --config -)
  config="header = \"Authorization: Bearer ${!token_var}\""
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQ"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQ")
  fi
  curl "${args[@]}" "${IDENTITY_API}${path}" <<<"$config"
}

# scope_catalogue_status -> the HTTP status of GET /platform/scopes (SigV4);
# body in $BODY. 200 is a tenant-identity with the scope catalogue (ADR-0025).
# A route the deployed API does not have is API Gateway's own answer, not
# the service's: with a signed request it is 404 "No method found matching
# route ..."; unsigned (or when the signature cannot be matched to a method)
# it is 403 "Missing Authentication Token". Either is a stale tenant-identity
# from before its ADR-0034.
scope_catalogue_status() { platform GET platform/scopes; }

# stale_identity STATUS -> 0 when STATUS and $BODY say the deployment lacks /platform/scopes.
stale_identity() {
  [[ "$1" =~ ^(403|404)$ ]] && grep -Eq 'Missing Authentication Token|No method found matching route' "$BODY"
}

CREATED_TENANTS=()

# create_tenant NAME [SCOPES] -> sets TENANT_ID and ADMIN_USERNAME.
# SCOPES is a space-separated list the tenant is entitled to (ADR-0025,
# tenant-identity ADR-0035); default: every demo scope. An absent list would
# leave the tenant with no scopes and every token refused at the ingress.
create_tenant() {
  local status
  status="$(platform POST platform/tenants \
    "$(jq -nc --arg n "$1" --arg e "success+${1}-admin@simulator.amazonses.com" --argjson s "$(scopes_json "${2-$ALL_DEMO_SCOPES}")" \
      '{name: $n, adminEmail: $e, scopes: $s}')")"
  [[ "$status" == 201 ]] || fail "CreateTenant $1: HTTP ${status}"
  TENANT_ID="$(jq -r .tenant.tenantId "$BODY")"
  ADMIN_USERNAME="$(jq -r .admin.user.username "$BODY")"
  CREATED_TENANTS+=("$TENANT_ID")
}

# set_user_scopes ADMIN_REFRESH_VAR TENANT_ID USERNAME SCOPES -> HTTP status of the PATCH; body in $BODY.
# The tenant admin narrows to tenant-admin/users and cuts the user's scopes
# to SCOPES (space-separated, a subset of the tenant's) through the tenant
# API, PATCH /tenant/users/{username} (tenant-identity ADR-0036). Call it
# directly, never in $(...).
set_user_scopes() {
  narrow "$1" "$2" "$TENANT_ADMIN_SCOPE" ADMIN_NARROWED
  [[ "$NARROW_STATUS" == 200 ]] || fail "narrow the tenant admin to ${TENANT_ADMIN_SCOPE}: HTTP ${NARROW_STATUS}"
  SET_SCOPES_STATUS="$(tenant_api PATCH "tenant/users/$3" ADMIN_NARROWED \
    "$(jq -nc --argjson s "$(scopes_json "$4")" '{scopes: $s}')")"
  ADMIN_NARROWED=""
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
# SCOPE may be several scopes separated by spaces. A scope the user does not
# hold (not in the catalogue, not the tenant's, or cut by the tenant admin)
# is 400 invalid_scope (ADR-0025); callers assert on NARROW_STATUS.
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

# oauth_error -> the RFC 6749 `error` code of the last refused exchange (body in $BODY).
oauth_error() { jq -r '.error // empty' "$BODY" 2>/dev/null; }

# expect_invalid_scope WHAT -> fails unless the last narrow was 400 invalid_scope.
expect_invalid_scope() {
  [[ "$NARROW_STATUS" == 400 && "$(oauth_error)" == invalid_scope ]] || fail "$1: expected HTTP 400 invalid_scope, got HTTP ${NARROW_STATUS} $(oauth_error)"
  echo "  $1 -> HTTP 400 invalid_scope"
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

# backend_url ENDPOINT_URL NAME -> the URL of one backend's route (ADR-0024).
# Tolerates either shape of the published endpointUrl: the ingress base
# (https://<api>/prod) or the default backend's full URL
# (https://<api>/prod/invocations, https://<gw>/default/invocations).
backend_url() {
  local base="${1%/}"
  base="${base%/invocations}"; base="${base%/default}"
  echo "${base}/$2/invocations"
}

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
