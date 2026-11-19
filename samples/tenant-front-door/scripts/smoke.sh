#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Smoke test of the tenant front door without a control plane (spec §10,
# the steps that need no hook). Deploys the front door in `single` mode, one
# demo cell, seeds the cell and two tenant routes straight into the route
# table, and checks the edge, the cell and the registrar live.
#
#   scripts/smoke.sh deploy    # support stack, front door, cell
#   scripts/smoke.sh check     # tenants, routes, checks; removes tenants and routes after
#
# Inputs (environment): SMOKE_APP_DOMAIN (a name below SMOKE_ZONE_NAME),
# SMOKE_ZONE_ID, SMOKE_ZONE_NAME. Region eu-central-1, edge in us-east-1.
# Needs the tenant-identity shared-pool deployment (its published
# parameters). Tokens and keys stay in shell variables and 0600 files.
#
# The stacks stay up after the run. Remove them with cdk destroy in the
# order cell, front door (edge-logging, main, edge), support.

set -euo pipefail
cd "$(dirname "$0")/.."

: "${SMOKE_APP_DOMAIN:?set SMOKE_APP_DOMAIN}" "${SMOKE_ZONE_ID:?set SMOKE_ZONE_ID}" "${SMOKE_ZONE_NAME:?set SMOKE_ZONE_NAME}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
REGION="$AWS_REGION"
APPLICATION_ID=tfd-smoke
FLEET=control-plane
CELL_ID=01KAF5M0000000000000000C01
IDENTITY_PREFIX=/application-plane/shared/identity
PARAM_EDGE=/application-plane/shared/front-door/edge
SMOKE_APP=(npx ts-node -P test/tsconfig.json --prefer-ts-exts test/smoke/smoke.app.ts)
TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT
BODY="$TMP/body"; HEAD="$TMP/head"; REQ="$TMP/req"
: >"$BODY"; : >"$HEAD"; : >"$REQ"; chmod 600 "$BODY" "$HEAD" "$REQ"

PASS=0; FAILS=0
note() { echo "  $*"; }
check() { # NAME WANT GOT
  if [[ "$3" =~ ^($2)$ ]]; then PASS=$((PASS + 1)); echo "  PASS $1 ($3)"; else
    FAILS=$((FAILS + 1)); echo "  FAIL $1: want $2, got $3 (body: $(head -c 160 "$BODY" | tr -d '\n'))"; fi
}
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
elapsed() { echo $(( $(date +%s) - $1 )); }

identity() {
  IDENTITY_API="$(param "$IDENTITY_PREFIX/apiUrl")"; [[ "$IDENTITY_API" == */ ]] || IDENTITY_API="$IDENTITY_API/"
  APP_CLIENT_ID="$(param "$IDENTITY_PREFIX/appClientId")"
  USER_POOL_ID="$(param "$IDENTITY_PREFIX/userPoolId")"
  ISSUER="https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}"
}

deploy() {
  identity
  local t0 t
  t0=$(date +%s); "${SMOKE_APP[@]}" >/dev/null
  npx cdk deploy TfdSmoke-support --app "${SMOKE_APP[*]}" --require-approval never --outputs-file /dev/null >"$TMP/support.log" 2>&1 || { tail -30 "$TMP/support.log"; exit 1; }
  echo "support stack: $(elapsed "$t0") s"
  local role secret
  role="$(out TfdSmoke-support EdgeOperatorRoleArn)"; secret="$(out TfdSmoke-support VendorIdpSecretArn)"
  t=$(date +%s)
  npx cdk deploy --all --require-approval never \
    --context appDomain="$SMOKE_APP_DOMAIN" \
    --context hostedZone="{\"zoneId\":\"$SMOKE_ZONE_ID\",\"zoneName\":\"$SMOKE_ZONE_NAME\"}" \
    --context applicationId="$APPLICATION_ID" \
    --context controlPlane="{\"apiUrl\":\"https://control-plane.example.com/\",\"accountId\":\"$(aws sts get-caller-identity --query Account --output text)\",\"region\":\"$REGION\",\"vendorIdp\":{\"tokenUrl\":\"https://idp.example.com/oauth2/token\",\"clientId\":\"tfd-smoke\",\"clientSecretArn\":\"$secret\"}}" \
    --context fleet="$FLEET" \
    --context edgeOperatorRoleArn="$role" \
    --context issuer="{\"clientId\":\"$APP_CLIENT_ID\",\"scopes\":\"openid\",\"authorizeEndpoint\":\"https://issuer.example.com/oauth2/authorize\",\"tokenEndpoint\":\"https://issuer.example.com/oauth2/token\",\"logoutEndpoint\":\"https://issuer.example.com/logout\"}" \
    >"$TMP/front-door.log" 2>&1 || { tail -40 "$TMP/front-door.log"; exit 1; }
  echo "front door stacks: $(elapsed "$t") s"
  local dist
  dist="$(param "$PARAM_EDGE" | jq -r .distributionArn)"
  t=$(date +%s)
  npx cdk deploy TfdSmoke-cell --app "${SMOKE_APP[*]}" --require-approval never \
    --context distributionArn="$dist" --context cellIssuer="$ISSUER" --context cellClientId="$APP_CLIENT_ID" \
    --context applicationId="$APPLICATION_ID" --context cellId="$CELL_ID" >"$TMP/cell.log" 2>&1 || { tail -30 "$TMP/cell.log"; exit 1; }
  echo "cell stack: $(elapsed "$t") s"
  echo "total deploy: $(elapsed "$t0") s"
}

# -- SigV4 and the tenant-identity platform API (credentials never printed) --
load_sigv4() { # [ROLE_ARN]
  local creds
  if [[ -n "${1:-}" ]]; then
    creds="$(aws sts assume-role --role-arn "$1" --role-session-name tfd-smoke --query Credentials --output json)"
  else
    creds="$(aws configure export-credentials --format process)"
  fi
  AK="$(jq -r .AccessKeyId <<<"$creds")"; SK="$(jq -r .SecretAccessKey <<<"$creds")"; ST="$(jq -r '.SessionToken // empty' <<<"$creds")"
}
signed() { # METHOD URL [JSON] -> status; body in $BODY
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$1" --aws-sigv4 "aws:amz:${REGION}:execute-api" --config -) config
  config="user = \"${AK}:${SK}\""
  [[ -n "$ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${ST}\""
  if [[ -n "${3:-}" ]]; then printf '%s' "$3" >"$REQ"; args+=(-H 'Content-Type: application/json' --data-binary "@$REQ"); fi
  curl "${args[@]}" "$2" <<<"$config"
}
TENANTS=()
create_tenant() { # NAME -> TENANT_ID, ADMIN_USER
  local st
  st="$(signed POST "${IDENTITY_API}platform/tenants" "$(jq -nc --arg n "$1" --arg e "success+$1@simulator.amazonses.com" '{name: $n, adminEmail: $e, scopes: ["app/use"]}')")"
  [[ "$st" == 201 ]] || { echo "CreateTenant $1: HTTP $st"; exit 1; }
  TENANT_ID="$(jq -r .tenant.tenantId "$BODY")"; ADMIN_USER="$(jq -r .admin.user.username "$BODY")"
  TENANTS+=("$TENANT_ID")
}
issue_token() { # TENANT_ID USER VAR
  local st pw
  pw="Tfd-Smoke-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')!"
  st="$(signed POST "${IDENTITY_API}platform/tenants/$1/users/$2/token" "$(printf '%s' "$pw" | jq -Rs '{password: .}')")"
  [[ "$st" == 200 ]] || { echo "IssueToken: HTTP $st"; exit 1; }
  printf -v "$3" '%s' "$(jq -r .accessToken "$BODY")"; : >"$BODY"
}

# edge METHOD PATH [TOKEN_VAR] [extra curl args...] -> status; headers in $HEAD, body in $BODY
edge() {
  local method="$1" path="$2" tv="${3:-}" config=""
  shift 3 || shift $#
  [[ -n "$tv" ]] && config="header = \"Authorization: Bearer ${!tv}\""
  curl -s -D "$HEAD" -o "$BODY" -w '%{http_code}' -X "$method" "$@" --config - "https://${SMOKE_APP_DOMAIN}${path}" <<<"$config"
}
header() { grep -i "^$1:" "$HEAD" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
has_header() { [[ -n "$(header "$1")" ]] && echo yes || echo no; }

wait_for() { # NAME WANT TOKEN_VAR — polls /api/whoami for up to 180 s until five answers in a row match
  local i st run=0
  for i in $(seq 1 90); do
    st="$(edge GET /api/whoami "$3")"
    if [[ "$st" =~ ^($2)$ ]]; then run=$((run + 1)); (( run >= 5 )) && break; else run=0; fi
    sleep 2
  done
  check "$1" "$2" "$st"
}

run_checks() {
  identity
  local edge_param registrar dist cell_url cell_domain account t0 st
  account="$(aws sts get-caller-identity --query Account --output text)"
  edge_param="$(param "$PARAM_EDGE")"
  registrar="$(jq -r .registrarUrl <<<"$edge_param")"; [[ "$registrar" == */ ]] || registrar="$registrar/"
  dist="$(jq -r .distributionArn <<<"$edge_param")"
  # The route table of this deployment: the registrar function's own setting.
  local registrar_fn
  registrar_fn="$(aws cloudformation describe-stack-resources --stack-name TenantFrontDoor-main \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'RegistrarFunction')].PhysicalResourceId | [0]" --output text)"
  kvs="$(aws lambda get-function-configuration --function-name "$registrar_fn" --query 'Environment.Variables.ROUTE_TABLE_ARN' --output text)"
  [[ "$kvs" == arn:*:key-value-store/* ]] || { echo "no route table ARN on the registrar function"; exit 1; }
  cell_domain="$(out TfdSmoke-cell ApiDomain)"; cell_url="$(out TfdSmoke-cell FunctionUrl)"
  note "distribution ${dist##*/}, route table ${kvs##*/}, cell ${cell_domain}"

  echo "1. tenants a, b (routed) and c (no route) in tenant-identity"
  A=""; B=""; C=""; A_TOKEN=""; B_TOKEN=""; C_TOKEN=""
  # Armed before the first tenant, so a failure at any later step removes
  # what the run made: tenants, namespace parameters, seeded routes.
  cleanup() {
    load_sigv4
    for t in "${TENANTS[@]}"; do signed DELETE "${IDENTITY_API}platform/tenants/$t" >/dev/null || true; done
    local routed=()
    for t in "$A" "$B"; do
      [[ -n "$t" ]] || continue
      routed+=("$t")
      aws ssm delete-parameter --name "/application-plane/tenants/$t/$APPLICATION_ID/smoke" >/dev/null 2>&1 || true
    done
    (( ${#routed[@]} == 0 )) || npx ts-node -P test/tsconfig.json test/smoke/seed.ts delete "$kvs" "$CELL_ID" "${routed[@]}" >/dev/null || true
  }
  trap 'cleanup; rm -f "$TMP"/*; rmdir "$TMP"' EXIT
  load_sigv4
  create_tenant "tfd-smoke-a-$$"; A="$TENANT_ID"; issue_token "$A" "$ADMIN_USER" A_TOKEN
  create_tenant "tfd-smoke-b-$$"; B="$TENANT_ID"; B_USER="$ADMIN_USER"; issue_token "$B" "$B_USER" B_TOKEN
  create_tenant "tfd-smoke-c-$$"; C="$TENANT_ID"; issue_token "$C" "$ADMIN_USER" C_TOKEN
  for t in "$A" "$B"; do aws ssm put-parameter --name "/application-plane/tenants/$t/$APPLICATION_ID/smoke" --type String --value smoke --overwrite >/dev/null; done
  t0=$(date +%s)
  npx ts-node -P test/tsconfig.json test/smoke/seed.ts put "$kvs" "$CELL_ID" "$account" "$cell_domain" "$A=Smoke A" "$B=Smoke B"
  note "waiting for the route table to reach the edge"
  wait_for "a routed after seed" 200 A_TOKEN
  note "route propagation: $(elapsed "$t0") s"
  local i counts=""
  # The first 200 means some edge servers have the route, not all: wait
  # until 90 s after the write, then check that every request is routed.
  # Spec §10 waits 60 s (ADR-0003, spike S-2); smoke runs saw the last
  # unrouted request 65 s after the write (design/spikes.md, Smoke run).
  local settle=$(( 90 - $(elapsed "$t0") ))
  (( settle > 0 )) && sleep "$settle"
  if [[ -n "${SMOKE_SOAK_WAIT:-}" ]]; then note "soak: waiting ${SMOKE_SOAK_WAIT} s more"; sleep "$SMOKE_SOAK_WAIT"; fi
  for i in $(seq 1 "${SMOKE_SOAK_COUNT:-60}"); do st="$(edge GET /api/whoami A_TOKEN)"; counts+="$st"$'\n'
    [[ "$st" == 200 ]] || note "soak miss: ${st} at $(elapsed "$t0") s after the write"; done
  note "soak GETs for a after propagation, by status: $(printf '%s' "$counts" | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  check "soak GETs for a all 200" "${SMOKE_SOAK_COUNT:-60}" "$(printf '%s' "$counts" | grep -c '^200$' || true)"

  echo "2. the SPA and router answers (§7.1 headers)"
  st="$(edge GET /)"; check "GET / 200" 200 "$st"
  check "GET / CSP" yes "$(has_header content-security-policy)"
  check "GET / HSTS" yes "$(has_header strict-transport-security)"
  check "GET / nosniff" nosniff "$(header x-content-type-options)"
  st="$(edge GET /config.json)"; check "GET /config.json 200" 200 "$st"
  check "config.json tenantClaim" tenant_id "$(jq -r .tenantClaim "$BODY" 2>/dev/null)"
  check "config.json CSP" yes "$(has_header content-security-policy)"
  st="$(edge GET /logout)"; check "GET /logout 302" 302 "$st"
  check "logout to issuer" yes "$([[ "$(header location)" == https://issuer.example.com/logout\?* ]] && echo yes || echo no)"
  check "logout Clear-Site-Data" yes "$(has_header clear-site-data)"
  st="$(edge GET /signin-state)"; check "GET /signin-state 404 (single)" 404 "$st"

  echo "3. /api/whoami through the edge to the cell"
  st="$(edge GET /api/whoami A_TOKEN)"; check "a's token 200" 200 "$st"
  check "a answered by cell" "$A" "$(jq -r '.tenantId // .tenant_id // empty' "$BODY" | tr a-z A-Z)"
  st="$(edge GET /api/whoami B_TOKEN)"; check "b's token 200" 200 "$st"
  check "b answered by cell" "$B" "$(jq -r '.tenantId // .tenant_id // empty' "$BODY" | tr a-z A-Z)"
  st="$(edge GET /api/whoami)"; check "no token 401" 401 "$st"
  check "401 has CSP" yes "$(has_header content-security-policy)"
  st="$(edge GET /api/whoami C_TOKEN)"; check "unrouted tenant 403" 403 "$st"
  st="$(edge GET /api/whoami A_TOKEN -H 'Sec-Fetch-Site: same-site')"; check "Sec-Fetch-Site same-site 403" 403 "$st"
  st="$(edge GET /api/whoami A_TOKEN -H "x-tenant-route: ${B,,}")"; check "client x-tenant-route ignored (200)" 200 "$st"
  check "client x-tenant-route ignored (a)" "$A" "$(jq -r '.tenantId // .tenant_id // empty' "$BODY" | tr a-z A-Z)"
  local FORGED head payload sig
  head="${A_TOKEN%%.*}"; sig="${A_TOKEN##*.}"; payload="${A_TOKEN#*.}"; payload="${payload%%.*}"
  payload="$(printf '%s' "$payload" | tr '_-' '/+')"; while (( ${#payload} % 4 )); do payload+='='; done
  payload="$(printf '%s' "$payload" | base64 -d | jq -c --arg b "$B" '.tenant_id = $b' | base64 -w0 | tr '/+' '_-' | tr -d '=')"
  FORGED="${head}.${payload}.${sig}"
  st="$(edge GET /api/whoami FORGED)"; check "forged payload naming b refused 403" 403 "$st"
  check "that 403 is the cell's, not the router's" yes "$(grep -q '"status":403' "$BODY" && echo no || echo yes)"
  local BIG; BIG="$(head -c 8186 /dev/zero | tr '\0' a)"
  st="$(edge GET /api/whoami BIG)"; check "Authorization over 8,192 bytes 401" "401|494" "$st"
  st="$(curl -s -o /dev/null -w '%{http_code}' "${cell_url}api/whoami")"; check "cell function URL direct 403" 403 "$st"
  local post_body='{"smoke":true}' post_sha
  post_sha="$(printf '%s' "$post_body" | sha256sum | cut -d' ' -f1)"
  st="$(edge POST /api/echo A_TOKEN -H 'Content-Type: application/json' -H "x-amz-content-sha256: ${post_sha}" --data-raw "$post_body")"
  check "POST with body hash reaches the cell (cell 404)" 404 "$st"
  check "POST answer is the cell's" "not found" "$(jq -r '.message // empty' "$BODY" 2>/dev/null)"
  st="$(edge POST /api/echo A_TOKEN -H 'Content-Type: application/json' --data-raw "$post_body")"
  check "POST without body hash refused 403" 403 "$st"
  check "that 403 is Lambda's, not the router's" yes "$(grep -q '"status":403' "$BODY" && echo no || echo yes)"

  echo "4. registrar with no control plane"
  st="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${registrar}tenants/${A}/status" -H 'Content-Type: application/json' --data-raw '{"status":"suspended"}')"
  check "unsigned registrar call 403" 403 "$st"
  load_sigv4 "$(out TfdSmoke-support EdgeOperatorRoleArn)"
  st="$(signed PUT "${registrar}cells/${CELL_ID}" "{\"apiDomain\":\"${cell_domain}\"}")"
  check "operator PutCellRoute 503 (control plane unreadable)" 503 "$st"
  t0=$(date +%s)
  st="$(signed PUT "${registrar}tenants/${B}/status" '{"status":"suspended"}')"
  check "operator suspends b with no control plane (ADR-0025) 200" 200 "$st"
  wait_for "b suspended at the edge 503" 503 B_TOKEN
  note "suspension propagation: $(elapsed "$t0") s"
  st="$(edge GET /api/whoami A_TOKEN)"; check "a still served 200" 200 "$st"
  st="$(signed PUT "${registrar}tenants/${C}/status" '{"status":"suspended"}')"
  check "status change for tenant with no route 409" 409 "$st"
  st="$(signed PUT "${registrar}tenants/${B}/status" '{"status":"active"}')"
  check "operator resumes b 200" 200 "$st"
  # The pool's access tokens are short-lived; a fresh one for the last wait.
  load_sigv4; issue_token "$B" "$B_USER" B_TOKEN
  wait_for "b served again 200" 200 B_TOKEN

  echo "result: ${PASS} passed, ${FAILS} failed"
  (( FAILS == 0 ))
}

case "${1:-}" in
  deploy) deploy ;;
  check) run_checks ;;
  *) echo "usage: $0 deploy|check" >&2; exit 2 ;;
esac
