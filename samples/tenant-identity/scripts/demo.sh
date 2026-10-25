#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo against one deployed TenantIdentity-<topology> stack.
#
#   scripts/demo.sh [topology]      # default: shared-pool-multi-tenant
#
# Walks the primary flow: onboard a tenant, sign its admin in (IssueToken test
# aid, ADR-0006), narrow the refresh token to the tenant and the admin scope
# (POST /oauth2/token, RFC 8693), call the tenant admin door with the narrowed
# token, then offboard the tenant and show that a fresh narrow and the admin
# door both stop working.
#
# Needs: bash, aws (v2), curl >= 7.75 (for --aws-sigv4), jq. The ambient AWS
# credentials must hold execute-api:Invoke on the deployed API, and AWS_REGION
# (or the profile's region) must name the Region the stack is deployed in.
#
# Hygiene (scripts/CONVENTIONS.md): the script never prints a token, refresh
# token, or password. It prints HTTP status codes, tenant ids, and claim
# names/values that are not credentials. The tenant it creates is deleted on
# exit, also when a step fails.

set -euo pipefail

TOPOLOGY="${1:-shared-pool-multi-tenant}"
case "$TOPOLOGY" in
  pool-per-tenant | shared-pool | shared-pool-multi-tenant) ;;
  *)
    echo "Unknown topology '$TOPOLOGY': use pool-per-tenant, shared-pool, or shared-pool-multi-tenant" >&2
    exit 2
    ;;
esac

for tool in aws curl jq; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 2; }
done

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || true)}}"
: "${REGION:?Set AWS_REGION to the Region the stack is deployed in}"
export AWS_REGION="$REGION"

STACK="${STACK_PREFIX:-TenantIdentity}-${TOPOLOGY}"
RUN_ID="$(date +%s)"
ADMIN_EMAIL="success+demo-${RUN_ID}-admin@simulator.amazonses.com"
USER_EMAIL="success+demo-${RUN_ID}-user@simulator.amazonses.com"
DEMO_PASSWORD="Demo-Pass-${RUN_ID}!"

GRANT_TYPE='urn:ietf:params:oauth:grant-type:token-exchange'
REFRESH_TYPE='urn:ietf:params:oauth:token-type:refresh_token'
ADMIN_SCOPE='tenant-admin/users'

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

# -- Credentials for SigV4 (held in variables, never printed) --------------
CREDS="$(aws configure export-credentials --format process)" \
  || fail "no AWS credentials found"
AK="$(jq -r .AccessKeyId <<<"$CREDS")"
SK="$(jq -r .SecretAccessKey <<<"$CREDS")"
ST="$(jq -r '.SessionToken // empty' <<<"$CREDS")"
unset CREDS

BODY_FILE="$(mktemp)"
REQUEST_FILE="$(mktemp)"
chmod 600 "$BODY_FILE" "$REQUEST_FILE"
TENANT_ID=""

cleanup() {
  local code=$?
  if [[ -n "$TENANT_ID" ]]; then
    platform DELETE "platform/tenants/${TENANT_ID}" >/dev/null 2>&1 || true
    echo "Cleanup: deleted tenant ${TENANT_ID}"
  fi
  rm -f "$BODY_FILE" "$REQUEST_FILE"
  exit "$code"
}
trap cleanup EXIT

# platform METHOD PATH [JSON] -> prints the HTTP status; body in $BODY_FILE.
# Sensitive credentials and request bodies reach curl through a stdin config
# and a mode-0600 temp file, never through process arguments. Other local users
# can read /proc/<pid>/cmdline while a request runs.
platform() {
  local method="$1" path="$2" data="${3:-}" config
  local args=(-s -o "$BODY_FILE" -w '%{http_code}' -X "$method"
    --aws-sigv4 "aws:amz:${REGION}:execute-api" --config -)
  config="user = \"${AK}:${SK}\""
  [[ -n "$ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${ST}\""
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQUEST_FILE"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQUEST_FILE")
  fi
  curl "${args[@]}" "${API_URL}${path}" <<<"$config"
}

# tenant METHOD PATH TOKEN [JSON] -> prints the HTTP status; body in $BODY_FILE.
tenant() {
  local method="$1" path="$2" token="$3" data="${4:-}"
  local args=(-s -o "$BODY_FILE" -w '%{http_code}' -X "$method" --config -)
  if [[ -n "$data" ]]; then
    printf '%s' "$data" >"$REQUEST_FILE"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQUEST_FILE")
  fi
  curl "${args[@]}" "${API_URL}${path}" <<<"header = \"Authorization: Bearer ${token}\""
}

urlencode() { jq -sRr @uri; }

# narrow REFRESH_TOKEN TENANT_ID -> prints the HTTP status; body in $BODY_FILE.
narrow() {
  printf 'grant_type=%s&client_id=%s&subject_token=%s&subject_token_type=%s&resource=%s&scope=%s' \
    "$(printf '%s' "$GRANT_TYPE" | urlencode)" \
    "$(printf '%s' "$CLIENT_ID" | urlencode)" \
    "$(printf '%s' "$1" | urlencode)" \
    "$(printf '%s' "$REFRESH_TYPE" | urlencode)" \
    "$(printf '%s' "urn:tenant-identity:tenant:$2" | urlencode)" \
    "$(printf '%s' "$ADMIN_SCOPE" | urlencode)" >"$REQUEST_FILE"
  curl -s -o "$BODY_FILE" -w '%{http_code}' -X POST "${API_URL}oauth2/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-binary "@$REQUEST_FILE"
}

# claims JWT -> the payload as JSON (decoded only, not verified).
claims() {
  local payload
  payload="$(cut -d. -f2 <<<"$1" | tr '_-' '/+')"
  while (( ${#payload} % 4 )); do payload+='='; done
  base64 -d <<<"$payload"
}

expect() { # expect WANT GOT WHAT
  [[ "$2" == "$1" ]] || fail "$3: expected HTTP $1, got $2 ($(jq -c '{message, error, reason}' "$BODY_FILE" 2>/dev/null || echo 'no body'))"
  echo "$3 -> HTTP $2"
}

# -- 1. Discover the stack -------------------------------------------------
step "1. Read the outputs of ${STACK} in ${REGION}"
output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
API_URL="$(output ApiUrl)" || fail "stack ${STACK} not found; deploy it first"
[[ "$API_URL" == */ ]] || API_URL="${API_URL}/"
echo "Found the API for topology ${TOPOLOGY}"

# -- 2. Onboard a tenant ---------------------------------------------------
step "2. Onboard tenant 'demo-${RUN_ID}' and its first admin (platform API, SigV4)"
status="$(platform POST platform/tenants \
  "$(jq -nc --arg n "demo-${RUN_ID}" --arg e "$ADMIN_EMAIL" '{name: $n, adminEmail: $e}')")"
expect 201 "$status" CreateTenant
TENANT_ID="$(jq -r .tenant.tenantId "$BODY_FILE")"
ADMIN_USERNAME="$(jq -r .admin.user.username "$BODY_FILE")"
echo "Tenant ${TENANT_ID} is $(jq -r .tenant.status "$BODY_FILE")"

if [[ "$TOPOLOGY" == pool-per-tenant ]]; then
  status="$(platform GET "platform/tenants/${TENANT_ID}")"
  expect 200 "$status" GetTenant
  CLIENT_ID="$(jq -r .tenant.appClientId "$BODY_FILE")"
  echo "This tenant has its own user pool and app client"
else
  CLIENT_ID="$(output AppClientId)"
  echo "This tenant shares the stack's user pool and app client"
fi

# -- 3. Sign the admin in --------------------------------------------------
step "3. Sign the admin in (IssueToken test aid, ADR-0006: remove before production)"
status="$(platform POST "platform/tenants/${TENANT_ID}/users/${ADMIN_USERNAME}/token" \
  "$(printf '%s' "$DEMO_PASSWORD" | jq -Rs '{password: .}')")"
expect 200 "$status" IssueToken
REFRESH_TOKEN="$(jq -r .refreshToken "$BODY_FILE")"
BROAD="$(jq -r .accessToken "$BODY_FILE")"
echo "Broad access token claims:"
claims "$BROAD" | jq -c '{tenant_id, tenants, scope, token_use} | with_entries(select(.value != null))'

step "3b. The broad token cannot use the admin door"
status="$(tenant GET tenant/users "$BROAD")"
[[ "$status" == 401 || "$status" == 403 ]] || fail "ListTenantUsers with a broad token: expected 401/403, got ${status}"
echo "ListTenantUsers with the broad token -> HTTP ${status}"

# -- 4. Narrow the token ---------------------------------------------------
step "4. Narrow the refresh token to this tenant and the admin scope (RFC 8693)"
status="$(narrow "$REFRESH_TOKEN" "$TENANT_ID")"
expect 200 "$status" ExchangeToken
NARROWED="$(jq -r .access_token "$BODY_FILE")"
echo "Narrowed access token claims:"
claims "$NARROWED" | jq -c '{tenant_id, tenants, scope, token_use} | with_entries(select(.value != null))'

step "4b. Narrowing to a tenant the admin does not belong to is refused"
status="$(narrow "$REFRESH_TOKEN" 01ARZ3NDEKTSV4RRFFQ69G5FAV)"
[[ "$status" == 400 ]] || fail "narrow to a foreign tenant: expected 400, got ${status}"
echo "ExchangeToken for a foreign tenant -> HTTP ${status} ($(jq -r .error "$BODY_FILE"))"

# -- 5. Use the admin door -------------------------------------------------
step "5. Manage users through the tenant admin door (narrowed bearer token)"
status="$(tenant POST tenant/users "$NARROWED" \
  "$(jq -nc --arg e "$USER_EMAIL" '{email: $e}')")"
expect 201 "$status" CreateTenantUser
status="$(tenant GET tenant/users "$NARROWED")"
expect 200 "$status" ListTenantUsers
echo "Tenant ${TENANT_ID} now has $(jq '.users | length' "$BODY_FILE") users"

# -- 6. Offboard -----------------------------------------------------------
step "6. Offboard the tenant (platform API, SigV4)"
status="$(platform DELETE "platform/tenants/${TENANT_ID}")"
expect 204 "$status" DeleteTenant
DELETED_ID="$TENANT_ID"
TENANT_ID=""   # nothing left for the exit trap to clean up

step "6b. After offboarding, a fresh narrow and the admin door both stop"
status="$(narrow "$REFRESH_TOKEN" "$DELETED_ID")"
[[ "$status" == 400 || "$status" == 401 ]] || fail "narrow after offboarding: expected 400/401, got ${status}"
echo "ExchangeToken for the deleted tenant -> HTTP ${status}"
status="$(tenant GET tenant/users "$NARROWED")"
[[ "$status" == 401 || "$status" == 403 ]] || fail "admin door after offboarding: expected 401/403, got ${status}"
echo "ListTenantUsers with the old narrowed token -> HTTP ${status}"

step "Demo complete for ${TOPOLOGY}"
