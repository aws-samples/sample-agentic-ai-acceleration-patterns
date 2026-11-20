#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The steps of spec §10, sourced by scripts/integ.sh. Each step_NN runs the
# checks of step NN in this run's mode; integration-test.md has the table.
# A check prints PASS, FAIL or SKIP and the run goes on; a step whose
# precondition failed (a record that never became ACTIVE) stops the run,
# because every later step would fail for the same reason.

host_of() { echo "${1,,}.${APP_DOMAIN}"; }           # a tenant's pooled host (host mode)
front() { if [[ "$MODE" == host ]]; then host_of "$1"; else echo "$APP_DOMAIN"; fi; }
json_get() { jq -r "$1" "$BODY" 2>/dev/null || true; }
entry() { edge_tool entry "$KVS" "$1"; }               # a redacted route table entry
need() { "$@" || die "precondition failed: $* ($(head -c 200 "$BODY" | tr -cd '[:print:]'))"; }
# api_expect NAME WANT METHOD PATH [JSON]: one control plane call with a status check.
# It returns 0 and leaves LAST_OK yes or no, so a mismatch is a FAIL and the run goes on.
api_expect() {
  local st
  st="$(api "$3" "$4" "${5:-}")"
  check "$1" "$2" "$st"
  if [[ "$st" =~ ^($2)$ ]]; then LAST_OK=yes; else LAST_OK=no; fi
}

# -- Step 1: accounts, the front door, the hooks, the demo application ----------------
step_01() {
  section "1. control plane, account role pairs, PutAccount, stand-in ingress, front door, hooks, demo application"
  deploy_phase_1
  deploy_phase_2
  api_expect "PutAccount control plane's account (VENDOR) 202" 202 PUT "accounts/${CP_ACCOUNT}" '{"owner":"VENDOR","maxCells":3}'
  api_expect "PutAccount edge account (TENANT, external id) 202" 202 PUT "accounts/${EDGE_ACCOUNT}" \
    "$(jq -nc --arg x "$EXTERNAL_ID" '{owner: "TENANT", maxCells: 1, externalId: $x}')"
  need api_poll "accounts/${CP_ACCOUNT}" .account.status ACTIVE 300 5
  need api_poll "accounts/${EDGE_ACCOUNT}" .account.status ACTIVE 300 5
  check "GetAccount edge account: an external id is set" true "$(api_status "accounts/${EDGE_ACCOUNT}" .account.externalIdConfigured)"
  deploy_phase_3
  deploy_phase_4
  deploy_phase_5
  api GET hooks >/dev/null
  check "ListHooks names front-door-post and front-door-pre" "front-door-post,front-door-pre" "$(json_get '[.hooks[].hookId] | sort | join(",")')"
  local definition
  definition="$(application_definition "test/integ/app/cell" "test/integ/app/tenant" create.sh update.sh delete.sh)"
  definition="$(jq -c '. + {
    parameters: [{name: "TFD_PROBE", default: "off"}, {name: "TFD_PROBE_PEER", default: "none"}],
    cellParameters: [{name: "FRONT_DOOR_OUTPUT", default: "on"}, {name: "TFD_CELL_PROBE", default: "off"}, {name: "TFD_CELL_PROBE_PEER", default: "none"}]}' <<<"$definition")"
  api_expect "PutApplication demo application 202" 202 PUT "applications/${APP}" "$definition"
  need api_poll "applications/${APP}" .application.status ACTIVE 300 5
  state_set APP_REGISTERED yes
}
# application_definition CELL_DIR TENANT_DIR CREATE UPDATE DELETE: the PutApplication body, from the run's source zip.
application_definition() {
  local root=samples/tenant-front-door
  jq -nc --arg loc "${SOURCE_BUCKET}/${SOURCE_KEY}" --arg ver "$SOURCE_VERSION" --arg c "$root/$1" --arg t "$root/$2" \
    --arg cr "$3" --arg up "$4" --arg de "$5" '{
      source: {type: "S3", location: $loc, sourceVersion: $ver},
      cellScripts: {create: ($c + "/" + $cr), update: ($c + "/" + $up), delete: ($c + "/" + $de)},
      tenantScripts: {create: ($t + "/" + $cr), update: ($t + "/" + $up), delete: ($t + "/" + $de)},
      maxTenants: 3, placementStrategy: "FILL"}'
}

# create_tenant T NAME: one tenant in the control plane and the same id in tenant-identity.
create_tenant() {
  local t="${1^^}" id
  api_expect "CreateTenant $1 202" 202 POST tenants "$(jq -nc --arg n "$2" '{name: $n}')"
  [[ "$LAST_OK" == yes ]] || die "CreateTenant $1"
  id="$(json_get .tenant.tenantId)"
  state_set "TENANT_${t}" "$id"
  need api_poll "tenants/${id}" .tenant.status ACTIVE 300 5
  ti_tenant "$IDENTITY_API" "$id" "$2"
  state_set "TI_USER_${t}" "$TI_ADMIN"
}
# create_deployment T [ACCOUNT] [APP]: a deployment, polled to ACTIVE; sets DEPLOYED_CELL.
create_deployment() {
  local id_var="TENANT_${1^^}" body
  body="$(jq -nc --arg app "${3:-$APP}" --arg e "success+tfd-integ-$1@simulator.amazonses.com" --arg acc "${2:-}" \
    '{applicationId: $app, adminEmail: $e} + (if $acc == "" then {} else {accountId: $acc} end)')"
  api_expect "CreateDeployment $1 in ${3:-$APP} 202" 202 POST "tenants/${!id_var}/deployments" "$body"
  [[ "$LAST_OK" == yes ]] || return 1
  api_poll "$(deployment_path "${!id_var}" "${3:-$APP}")" .deployment.status ACTIVE 1800 30 || true
  check "deployment $1 in ${3:-$APP} ACTIVE" ACTIVE "$POLLED" || true
  DEPLOYED_CELL="$(json_get .deployment.cellId)"
  [[ "$POLLED" == ACTIVE ]]
}

# -- Step 2 -------------------------------------------------------------------------------
step_02() {
  section "2. tenants a (vendor-owned cell A) and b (tenant-owned cell B); the dedicated-domain fixture"
  create_tenant a "tfd-integ-a-${RUN_ID}"
  create_tenant b "tfd-integ-b-${RUN_ID}"
  need create_deployment a
  state_set CELL_A "$DEPLOYED_CELL"
  check "a's cell is in the control plane's account" "$CP_ACCOUNT" "$(api_status "cells/${CELL_A}" .cell.accountId)"
  check "cell A ran front-door-post" ".*front-door-post.*" "$(last_hooks "cells/${CELL_A}" .cell)"
  check "a's deployment ran front-door-post" ".*front-door-post.*" "$(last_hooks "$(deployment_path "$TENANT_A")" .deployment)"
  need create_deployment b "$EDGE_ACCOUNT"
  state_set CELL_B "$DEPLOYED_CELL"
  check "b's cell is in the edge account" "$EDGE_ACCOUNT" "$(api_status "cells/${CELL_B}" .cell.accountId)"
  check "cell B ran front-door-post" ".*front-door-post.*" "$(last_hooks "cells/${CELL_B}" .cell)"
  check "b's deployment ran front-door-post" ".*front-door-post.*" "$(last_hooks "$(deployment_path "$TENANT_B")" .deployment)"
  check "tenant#a names cell A" "${CELL_A,,}" "$(entry "tenant#${TENANT_A,,}" | jq -r .c)"
  check "cell#B is in the edge account" "$EDGE_ACCOUNT" "$(entry "cell#${CELL_B,,}" | jq -r .ac)"
  if [[ "$MODE" == host ]]; then
    check "host#a names a" "${TENANT_A,,}" "$(entry "host#$(host_of "$TENANT_A")" | jq -r .t)"
  fi
  # The one write that bypasses the registrar (P-3).
  edge_tool host-put "$KVS" dedicated-a.example.com "$TENANT_A" "$CP_ACCOUNT" >/dev/null
  state_set FIXTURE_WRITTEN yes
  local start; start=$(date +%s)
  while (( $(elapsed "$start") < 120 )); do
    test_fn GET /config.json dedicated-a.example.com
    [[ "$(tf_status)" == 200 ]] && break
    sleep 10
  done
  check "fixture host answers /config.json in TestFunction (after $(elapsed "$start") s)" 200 "$(tf_status)"
}

# -- Step 3 -------------------------------------------------------------------------------
step_03() {
  section "3. the SPA and the router's own answers carry the §7.1 headers"
  local host st
  host="$(front "$TENANT_A")"
  st="$(edge GET "$host" /)"; check "GET / 200" 200 "$st"; check_headers "GET /"
  local asset; asset="$({ grep -o '/assets/[A-Za-z0-9._-]*' "$BODY" || true; } | head -1)"
  st="$(edge GET "$host" "${asset:-/assets/none}")"; check "an /assets/* load 200" 200 "$st"
  st="$(edge GET "$host" /config.json)"; check "GET /config.json 200" 200 "$st"; check_headers "/config.json"
  skip "the inline callback script order and its hash in script-src: SPA build tests (test/spa/build.test.ts)"
  skip "no CSP violation on /callback or /?code= in a browser: no browser in the driver (spec §10, run by hand)"
  if [[ "$MODE" == single ]]; then
    st="$(edge GET "$host" /signin-state)"; check "/signin-state 404 (single)" 404 "$st"; check_headers "404"
    st="$(edge GET "$host" /logout)"; check "/logout 302" 302 "$st"; check_headers "/logout 302"
    local loc; loc="$(header location)"
    check "/logout goes to the issuer's logout endpoint with client_id" yes "$(yes_no grep -q "client_id=${IDENTITY_CLIENT}" <<<"$loc")"
    check "/logout names logout_uri https://<appDomain>/" yes "$(yes_no grep -qF "logout_uri=$(jq -rn --arg u "https://${APP_DOMAIN}/" '$u|@uri')" <<<"$loc")"
    check "/logout Clear-Site-Data" '"storage", "cache"' "$(header clear-site-data)"
    test_fn GET /config.json dedicated-a.example.com
    check "dedicated domain /config.json names signInHost <appDomain>" "(https://)?${APP_DOMAIN}" "$(tf_body | jq -r .signInHost 2>/dev/null)"
  fi
}

# -- Step 4 -------------------------------------------------------------------------------
step_04() {
  section "4. /api/whoami reaches each tenant's cell"
  token_for a A_TOKEN; token_for b B_TOKEN
  local st
  st="$(edge GET "$(front "$TENANT_A")" /api/whoami A_TOKEN)"; check "a's token 200" 200 "$st"
  check "a answered by cell A" "${TENANT_A}:cell-a" "$(body_tenant):$(body_cell)"
  st="$(edge GET "$(front "$TENANT_B")" /api/whoami B_TOKEN)"; check "b's token 200" 200 "$st"
  check "b answered by cell B, in the edge account" "${TENANT_B}:cell-b" "$(body_tenant):$(body_cell)"
  note "each cell reads the token from x-tenant-token only (the demo cell API); a 200 is that read"
}

# -- Steps 5 to 10 (single) -----------------------------------------------------------------
step_05() {
  section "5. no token, a tenants token, an oversized Authorization: 401 at the edge, no origin line"
  local t0 st MT_TOKEN BIG
  t0="$(now_ms)"
  st="$(edge GET "$APP_DOMAIN" /api/whoami)"; check "no token 401" 401 "$st"; check_headers "401"
  multi_tenant_token MT_TOKEN
  st="$(edge GET "$APP_DOMAIN" /api/whoami MT_TOKEN)"; check "a token with tenants and no tenant_id 401" 401 "$st"
  BIG="$(head -c 8186 /dev/zero | tr '\0' a)"
  st="$(edge GET "$APP_DOMAIN" /api/whoami BIG)"; check "Authorization one byte over 8,192 401" 401 "$st"
  test_fn GET /api/whoami "$APP_DOMAIN" '' "$(head -c 8185 /dev/zero | tr '\0' a | jq -Rc '{authorization: ("Bearer " + .)}' | headers_file exact)"
  check "TestFunction with an Authorization of exactly 8,192 bytes: no compute-limit error" yes "$(yes_no test -z "$TF_ERR")"
  note "TestFunction compute utilisation ${TF_COMPUTE:-?}"
  sleep 20
  check "no cell A log line" 0 "$(log_count "$CELL_A_LOG" "$REGION" '' "$t0" cp)"
  local fails_before=$FAILS
  check "no cell B log line" 0 "$(log_count "$CELL_B_LOG" "$REGION" '' "$t0")"
  if (( FAILS > fails_before )); then
    note "cell B lines in the window: $(as_test aws logs filter-log-events --region "$REGION" --log-group-name "$CELL_B_LOG" --start-time "$t0" \
      --query 'events[].message' --output json 2>/dev/null | jq -rc '[.[] | (fromjson? // {}) | {type, message, reason, path, status}] | .[:5]')"
  fi
}
# multi_tenant_token VAR: a token of tenant-identity's shared-pool-multi-tenant topology (tenants claim, no tenant_id).
multi_tenant_token() {
  local api
  api="$(stack_out TenantIdentity-shared-pool-multi-tenant ApiUrl "$IDENTITY_REGION")"
  [[ "$api" == */ ]] || api="$api/"
  if [[ -z "${MT_TENANT:-}" ]]; then
    MT_TENANT="$(ulid)"
    # Saved before the create, so a create that times out is still removed.
    state_set MT_TENANT "$MT_TENANT"; state_set MT_API "$api"
    ti_tenant "$api" "$MT_TENANT" "tfd-integ-mt-${RUN_ID}" '[]'
    state_set MT_USER "$TI_ADMIN"
  fi
  ti_token "$api" "$MT_TENANT" "$MT_USER" "$1"
}
# ulid: a random id of the ULID form (26 Crockford base32 characters).
ulid() { rand_chars '0-9A-HJKMNP-TV-Z' 26; }

step_06() {
  section "6. a token for an unregistered tenant: 403 at the edge"
  local st U_TOKEN
  if [[ -z "${TENANT_U:-}" ]]; then
    state_set TENANT_U "$(ulid)"
    ti_tenant "$IDENTITY_API" "$TENANT_U" "tfd-integ-u-${RUN_ID}"
    state_set TI_USER_U "$TI_ADMIN"
  fi
  ti_token "$IDENTITY_API" "$TENANT_U" "$TI_USER_U" U_TOKEN
  st="$(edge GET "$APP_DOMAIN" /api/whoami U_TOKEN)"; check "unregistered tenant 403" 403 "$st"; check_headers "403"
}

step_07() {
  section "7. a payload edited to name b, with a's signature: reaches cell B, refused there"
  token_for a A_TOKEN
  local FORGED head payload sig st t0
  head="${A_TOKEN%%.*}"; sig="${A_TOKEN##*.}"; payload="${A_TOKEN#*.}"; payload="${payload%%.*}"
  payload="$(printf '%s' "$payload" | tr '_-' '/+')"; while (( ${#payload} % 4 )); do payload+='='; done
  payload="$(printf '%s' "$payload" | base64 -d | jq -c --arg b "${TENANT_B,,}" '.tenant_id = $b' | base64 -w0 | tr '/+' '_-' | tr -d '=')"
  FORGED="${head}.${payload}.${sig}"
  t0="$(now_ms)"
  st="$(edge GET "$APP_DOMAIN" /api/whoami FORGED)"; check "forged token 403" 403 "$st"
  sleep 20
  check "cell B logged the refusal" "[1-9][0-9]*" "$(log_count "$CELL_B_LOG" "$REGION" '"invalid_token"' "$t0")"
}

step_08() {
  section "8. a client x-tenant-route or x-tenant-token is ignored"
  token_for a A_TOKEN; token_for b B_TOKEN
  local st config
  st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN -H "x-tenant-route: ${TENANT_B,,}")"
  check "x-tenant-route: b ignored" "200:${TENANT_A}" "${st}:$(body_tenant)"
  # The second token reaches curl in a 0600 file, never on its command line.
  config="$TMP/x-token"; printf 'header = "x-tenant-token: %s"\n' "$B_TOKEN" >"$config"; chmod 600 "$config"
  st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN -K "$config")"
  : >"$config"
  check "x-tenant-token with b's token ignored" "200:${TENANT_A}" "${st}:$(body_tenant)"
}

step_09() {
  section "9. Sec-Fetch-Site: same-site on /api/* is 403"
  token_for a A_TOKEN
  local st; st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN -H 'Sec-Fetch-Site: same-site')"
  check "same-site 403" 403 "$st"; check_headers "403 same-site"
}

step_10() {
  section "10. the cells' function URLs refuse a direct call"
  check "cell A direct 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${CELL_A_URL}api/whoami" || echo 000)"
  check "cell B direct 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${CELL_B_URL}api/whoami" || echo 000)"
  skip "SPA bucket policy, versioning and Block Public Access: template tests (test/edge/stacks.test.ts)"
  skip "a chunk with no integrity entry fails the SPA build: test/spa/build.test.ts"
}

# -- Steps 11 to 13: the pair roles and the operator --------------------------------------------
step_11() {
  section "11. the edge account's tenant role cannot write routes; the operator's domain limits"
  api_expect "UpdateDeployment b with the step 11 probe 202" 202 PUT "$(deployment_path "$TENANT_B")" \
    "$(jq -nc --arg p "$TENANT_A" '{parameters: {TFD_PROBE: "step11", TFD_PROBE_PEER: $p}}')"
  api_poll "$(deployment_path "$TENANT_B")" .deployment.status ACTIVE 1200 30 || true
  check "b's update ACTIVE: the tenant role got 403 on every call" ACTIVE "$POLLED"
  check_eq "tenant role answers" '{"put-own-route":"403","put-peer-route":"403","put-own-custom-domain":"403"}' \
    "$(aws ssm get-parameter --region "$REGION" --name "/application-plane/tenants/${TENANT_B}/${APP}/registrar-probe" --query Parameter.Value --output text 2>/dev/null)"
  check "no host# key for dedicated-b.example.com" null "$(entry host#dedicated-b.example.com)"
  token_for a A_TOKEN
  local st; st="$(edge GET "$(front "$TENANT_A")" /api/whoami A_TOKEN)"; check "a still routed to cell A" "200:cell-a" "${st}:$(body_cell)"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}" "$(jq -nc --arg d "$(host_of "$TENANT_A")" '{customDomain: $d}')")"
  check "operator: b with customDomain a.<appDomain> 400" 400 "$st"
  if [[ "$MODE" == host ]]; then
    st="$(edge GET "$(host_of "$TENANT_A")" /config.json)"; check "a.<appDomain> still names a" "200:${TENANT_A}" "${st}:$(body_tenant)"
  fi
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}" '{"customDomain":"dedicated-a.example.com"}')"
  check "operator: b with a's dedicated domain 409" 409 "$st"
  check "the fixture still names a" "${TENANT_A,,}" "$(entry host#dedicated-a.example.com | jq -r .t)"
}

step_12() {
  section "12. no cell role and no stranger in the edge account can delete a cell route"
  api_expect "UpdateCell B with the step 12 probe 202" 202 PUT "cells/${CELL_B}" \
    "$(jq -nc --arg p "$CELL_A" '{parameters: {TFD_CELL_PROBE: "step12", TFD_CELL_PROBE_PEER: $p}}')"
  api_poll "cells/${CELL_B}" .cell.status ACTIVE 1200 30 || true
  check "cell B's update ACTIVE: the edge account's cell role got 403" ACTIVE "$POLLED"
  check_eq "edge account cell role answers" '{"delete-own-cell":"403","delete-peer-cell":"403"}' \
    "$(aws ssm get-parameter --region "$REGION" --name "/application-plane/cells/${CELL_B}/registrar-probe" --query Parameter.Value --output text 2>/dev/null)"
  api_expect "UpdateCell A with the step 12 probe 202" 202 PUT "cells/${CELL_A}" \
    "$(jq -nc --arg p "$CELL_B" '{parameters: {TFD_CELL_PROBE: "step12", TFD_CELL_PROBE_PEER: $p}}')"
  api_poll "cells/${CELL_A}" .cell.status ACTIVE 1200 30 || true
  check "cell A's update ACTIVE: the control plane account's cell role got 403" ACTIVE "$POLLED"
  check_eq "control plane account cell role answers" '{"delete-own-cell":"403","delete-peer-cell":"403"}' \
    "$(in_cp aws ssm get-parameter --region "$REGION" --name "/application-plane/cells/${CELL_A}/registrar-probe" --query Parameter.Value --output text 2>/dev/null)"
  local st; st="$(as "$STRANGER" PUT "tenants/${TENANT_B}" '{}')"
  check "an edge-account stranger with Invoke 403" 403 "$st"
}

step_13() {
  section "13. a suspended tenant cannot lift its suspension"
  token_for a A_TOKEN; token_for b B_TOKEN
  local st
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}/status" '{"status":"suspended"}')"; check "operator suspends b 200" 200 "$st"
  propagate 90
  st="$(edge GET "$APP_DOMAIN" /api/whoami B_TOKEN)"; check "b's token 503" 503 "$st"; check_headers "503"
  st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN)"; check "a still served" 200 "$st"
  api_expect "UpdateDeployment b with the step 13 probe 202" 202 PUT "$(deployment_path "$TENANT_B")" '{"parameters":{"TFD_PROBE":"step13"}}'
  api_poll "$(deployment_path "$TENANT_B")" .deployment.status ACTIVE 1200 30 || true
  check "b's update ACTIVE: the tenant role got 403 on DeleteTenantRoute and PutTenantRoute" ACTIVE "$POLLED"
  check_eq "tenant role answers" '{"delete-own-route":"403","put-own-route":"403"}' \
    "$(aws ssm get-parameter --region "$REGION" --name "/application-plane/tenants/${TENANT_B}/${APP}/registrar-probe" --query Parameter.Value --output text 2>/dev/null)"
  check "b's entry still suspended after front-door-post" suspended "$(entry "tenant#${TENANT_B,,}" | jq -r .s)"
  propagate 90
  token_for b B_TOKEN
  st="$(edge GET "$APP_DOMAIN" /api/whoami B_TOKEN)"; check "b's token still 503" 503 "$st"
}

# -- Step 14: the domain challenge (single only) ---------------------------------------------
TXT_VALUES=()
# txt_publish VALUE...: replaces the challenge name's TXT records (none: deletes them), waits for INSYNC and past the TTL.
txt_publish() {
  local name="_tfd-challenge.${DD}" change id start
  if (( $# == 0 )); then
    (( ${#TXT_VALUES[@]} == 0 )) && return 0
    change="$(jq -nc --arg n "$name" --args '{Changes: [{Action: "DELETE", ResourceRecordSet: {Name: $n, Type: "TXT", TTL: 60,
      ResourceRecords: [$ARGS.positional[] | {Value: ("\"" + . + "\"")}]}}]}' "${TXT_VALUES[@]}")"
  else
    change="$(jq -nc --arg n "$name" --args '{Changes: [{Action: "UPSERT", ResourceRecordSet: {Name: $n, Type: "TXT", TTL: 60,
      ResourceRecords: [$ARGS.positional[] | {Value: ("\"" + . + "\"")}]}}]}' "$@")"
  fi
  id="$(as_test aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "$change" --query ChangeInfo.Id --output text)" \
    || { check "TXT change accepted" yes no; return 1; }
  TXT_VALUES=("$@")
  state_set TXT_PUBLISHED "$(( $# > 0 ? 1 : 0 ))"
  start=$(date +%s)
  until [[ "$(as_test aws route53 get-change --id "$id" --query ChangeInfo.Status --output text)" == INSYNC ]]; do
    (( $(elapsed "$start") > 300 )) && { check "TXT change INSYNC" INSYNC timeout; return 1; }
    sleep 5
  done
  note "TXT change INSYNC after $(elapsed "$start") s; waiting 65 s past the 60 s TTL"
  sleep 65
}
random_token() { rand_chars 'A-Za-z0-9_-' 43; }
dd_call() { as "$EDGE_OPERATOR" PUT "tenants/$1" "$(jq -nc --arg d "$2" '{customDomain: $d}')"; }
certs_for() { # DOMAIN -> ARNs of the registrar's certificates (this distribution's tag) for DOMAIN
  local arn
  for arn in $(as_test aws acm list-certificates --region us-east-1 --includes 'keyTypes=RSA_2048,EC_prime256v1,EC_secp384r1' \
      --query "CertificateSummaryList[?DomainName=='$1'].CertificateArn" --output text); do
    [[ "$(as_test aws acm list-tags-for-certificate --region us-east-1 --certificate-arn "$arn" \
      --query "Tags[?Key=='tenant-front-door:distribution'].Value | [0]" --output text)" == "$DIST_ID" ]] && echo "$arn"
  done
  return 0
}
utc_window() { # waits until at least 15 minutes remain before 00:00 UTC
  local left=$(( 86400 - $(date -u +%s) % 86400 ))
  if (( left < 900 )); then note "waiting $((left + 30)) s for the new UTC day"; sleep $((left + 30)); fi
}
sweeper_item_put() { # the entry item of b for <dd>, as after two missed days
  local yesterday; yesterday="$(date -u -d yesterday +%F)"
  as_test aws dynamodb put-item --region "$REGION" --table-name "$SWEEPER_TABLE" --item "$(jq -nc --arg sk "${TENANT_B,,}#${DD}" --arg y "$yesterday" '{
    pk: {S: "ENTRY"}, sk: {S: $sk}, lastCheckedDay: {S: $y}, lastOutcome: {S: "miss"},
    missStreak: {N: "2"}, errorStreak: {N: "0"}, missBefore: {N: "1"}, errorBefore: {N: "0"}}')"
}
sweeper_item() { as_test aws dynamodb get-item --region "$REGION" --table-name "$SWEEPER_TABLE" --consistent-read \
  --key "$(jq -nc --arg sk "${TENANT_B,,}#${DD}" '{pk: {S: "ENTRY"}, sk: {S: $sk}}')" --output json; }
sweeper_run() { # hand run of the daily re-check, then waits for today's page of one entry
  local today item run start t0="$1"
  today="$(date -u +%F)"
  as_test aws lambda invoke --region "$REGION" --function-name "$SWEEPER" --cli-binary-format raw-in-base64-out \
    --payload '{"job":"recheck"}' "$TMP/recheck.json" >/dev/null
  start=$(date +%s)
  while (( $(elapsed "$start") < 120 )); do
    item="$(sweeper_item)"
    run="$(as_test aws dynamodb get-item --region "$REGION" --table-name "$SWEEPER_TABLE" --consistent-read \
      --key "$(jq -nc --arg d "$today" '{pk: {S: "RUN"}, sk: {S: $d}}')" --output json)"
    [[ "$(jq -r '.Item.lastCheckedDay.S // empty' <<<"$item")" == "$today" && "$(jq -r '.Item.pagesFinished.NS // [] | join(",")' <<<"$run")" == *1* ]] && break
    sleep 3
  done
  SWEEP_ITEM="$item"
  check "the hand run's page finished (after $(elapsed "$start") s): pagesStarted 1, pagesFinished {1}" "1:1" \
    "$(jq -r '.Item.pagesStarted.N // "?"' <<<"$run"):$(jq -r '.Item.pagesFinished.NS // [] | join(",")' <<<"$run")"
  sleep 15
  note "the page's GetKey reads took $(as_test aws logs filter-log-events --region "$REGION" --log-group-name "$SWEEPER_LOG" --start-time "$t0" \
    --filter-pattern '"page reads"' --query 'events[-1].message' --output text 2>/dev/null | jq -r '.readMs // "?"' 2>/dev/null) ms (the 2 s limit is chosen, not measured)"
}

step_14() {
  section "14. the domain challenge (ADR-0018)"
  local st TA TB RANDOM_VALUE t0 cert arn1 arn2 arn3 token
  RANDOM_VALUE="tfd-verify=$(random_token)"
  # The name holds a record before the registrar first looks it up (spike S-10).
  txt_publish "$RANDOM_VALUE" || true
  st="$(dd_call "$TENANT_A" "$DD")"
  check "operator sets <dd> for a: 202 domain-challenge" "202:domain-challenge" "${st}:$(json_get .stage)"
  TA="$(json_get .record.value)"
  check "a's challenge record form" yes "$(yes_no test "${#TA}" -eq 54)"
  check "a's entry holds d, dk and dx" "${DD}:true:true" "$(entry "tenant#${TENANT_A,,}" | jq -r '"\(.d):\(.dkPresent // false):\(.dx != null)"')"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_A}" '{}')"; check "a drops the domain 200" 200 "$st"
  check "a's entry holds no d, dk or dx" "null:false:false" "$(entry "tenant#${TENANT_A,,}" | jq -r '"\(.d):\(.dkPresent // false):\(.dx != null)"')"
  check "no certificate for <dd>" "" "$(certs_for "$DD" | tr '\n' ' ' | sed 's/ $//')"
  st="$(dd_call "$TENANT_B" "$DD")"
  TB="$(json_get .record.value)"
  check "operator sets <dd> for b: 202 with a new token" "202:yes" "${st}:$(yes_no test -n "$TB" -a "$TB" != "$TA")"
  txt_publish "$TA" "$RANDOM_VALUE" || true
  st="$(dd_call "$TENANT_B" "$DD")"
  check "b's repeat with the former holder's and a random token: 202 mismatch" "202:mismatch" "${st}:$(json_get .challenge)"
  check "still no certificate for <dd>" "" "$(certs_for "$DD" | tr '\n' ' ' | sed 's/ $//')"
  txt_publish "$TA" "$RANDOM_VALUE" "$TB" || true
  st="$(dd_call "$TENANT_B" "$DD")"
  check "b's repeat with its token: 202 certificate" "202:certificate" "${st}:$(json_get .stage)"
  check "ACM's validation record returned" CNAME "$(json_get .record.type)"
  cert="$(certs_for "$DD")"
  check "one certificate for <dd>" 1 "$(grep -c . <<<"$cert" || true)"
  check "the certificate is tagged with b" "${TENANT_B,,}" "$(as_test aws acm list-tags-for-certificate --region us-east-1 --certificate-arn "${cert%%$'\n'*}" \
    --query "Tags[?Key=='tenant-front-door:tenant'].Value | [0]" --output text 2>/dev/null)"
  st="$(dd_call "$TENANT_A" "$DD")"; check "a's call for <dd> now 409" 409 "$st"
  check "a's entry got no token" false "$(entry "tenant#${TENANT_A,,}" | jq -r '.dkPresent // false')"

  # The repeat request within ACM's hour, made as the registrar would (test-only probe).
  token="$(rand_chars 'a-z0-9' 32)"
  local tags=(Key=tenant-front-door:tenant,Value="${TENANT_B,,}" Key=tenant-front-door:distribution,Value="$DIST_ID" Key=TenantId,Value="$TENANT_B")
  arn1="$(as_test aws acm request-certificate --region us-east-1 --domain-name "probe.${DD}" --validation-method DNS --idempotency-token "$token" --tags "${tags[@]}" --query CertificateArn --output text 2>&1)"
  arn2="$(as_test aws acm request-certificate --region us-east-1 --domain-name "probe.${DD}" --validation-method DNS --idempotency-token "$token" --tags "${tags[@]}" --query CertificateArn --output text 2>&1)"
  check "the repeat request returns the same ARN, with no AccessDenied" "yes" "$(yes_no test "$arn1" = "$arn2" -a "${arn1#arn:}" != "$arn1")"
  as_test aws acm delete-certificate --region us-east-1 --certificate-arn "$arn1" >/dev/null 2>&1 || true
  arn3="$(as_test aws acm request-certificate --region us-east-1 --domain-name "probe.${DD}" --validation-method DNS --idempotency-token "$token" --tags "${tags[@]}" --query CertificateArn --output text 2>&1)"
  if [[ "$arn3" == "$arn1" ]]; then note "after the delete, ACM returned the deleted ARN for the same token (the registrar reads that as no certificate)"
  else note "after the delete, ACM returned a new certificate for the same token; deleting it"
    as_test aws acm delete-certificate --region us-east-1 --certificate-arn "$arn3" >/dev/null 2>&1 || true; fi

  # The daily re-check: a pass, then a third missed day (the sweeper table shortcut).
  utc_window; t0="$(now_ms)"; sweeper_item_put; sweeper_run "$t0"
  check "re-check with the token published: pass, streaks 0" "pass:0:0" \
    "$(jq -r '"\(.Item.lastOutcome.S):\(.Item.missStreak.N):\(.Item.errorStreak.N)"' <<<"$SWEEP_ITEM")"
  check "no three-miss line" 0 "$(log_count "$SWEEPER_LOG" "$REGION" '"three-miss"' "$t0")"
  txt_publish "$TA" "$RANDOM_VALUE" || true
  utc_window; t0="$(now_ms)"; sweeper_item_put; sweeper_run "$t0"
  check "re-check without it: the third miss" "miss:3:2:0" \
    "$(jq -r '"\(.Item.lastOutcome.S):\(.Item.missStreak.N):\(.Item.missBefore.N):\(.Item.errorStreak.N)"' <<<"$SWEEP_ITEM")"
  check "one three-miss line for b and <dd>" 1 "$(log_count "$SWEEPER_LOG" "$REGION" "\"three-miss\" \"${TENANT_B,,}\" \"${DD}\"" "$t0")"
  check "the three-miss line holds no token" 0 "$(log_count "$SWEEPER_LOG" "$REGION" "\"${TB#tfd-verify=}\"" "$t0")"
  sleep 60
  check "the re-check metric counted one" "1(\\.0)?" "$(as_test aws cloudwatch get-metric-data --region "$REGION" \
    --start-time "$(date -u -d '-15 min' +%FT%TZ)" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --metric-data-queries "$(jq -nc --arg d "$DIST_ID" '[{
      Id: "m", MetricStat: {Metric: {Namespace: "TenantFrontDoor", MetricName: "DomainChallengeThreeMiss",
      Dimensions: [{Name: "DistributionId", Value: $d}]}, Period: 1200, Stat: "Sum"}}]')" \
    --query 'MetricDataResults[0].Values | sum(@)' --output text 2>/dev/null)"

  # The guard: dedicatedDomains cannot go off while b holds <dd>.
  ctx_set dedicatedDomains false
  if deploy_one FrontDoor/Main guard-refused >/dev/null 2>&1; then st=passed; else st=failed; fi
  check "turning dedicatedDomains off while b holds <dd> fails" failed "$st"
  check "the main stack rolled back" UPDATE_ROLLBACK_COMPLETE "$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$S_MAIN" --query 'Stacks[0].StackStatus' --output text)"
  check "b's entry still holds <dd>" "$DD" "$(entry "tenant#${TENANT_B,,}" | jq -r .d)"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}" '{}')"; check "b drops <dd> 200" 200 "$st"
  txt_publish || true
  local start; start=$(date +%s)
  while [[ -n "$(certs_for "$DD")" ]] && (( $(elapsed "$start") < 1200 )); do sleep 60; done
  check "the sweeper deleted the certificate (after $(elapsed "$start") s)" "" "$(certs_for "$DD" | tr '\n' ' ' | sed 's/ $//')"
  deploy_one FrontDoor/Main dedicated-off && st=passed || st=failed
  check "turning dedicatedDomains off now succeeds" passed "$st"
  st="$(dd_call "$TENANT_A" "$DD")"; check "a's call for <dd> with dedicatedDomains off 400" 400 "$st"
}

# -- Steps 15 and 16 ----------------------------------------------------------------------------
step_15() {
  section "15. per-tenant counts and the registrar's logs"
  sleep 60
  local events counts
  events="$(as_test aws logs filter-log-events --region us-east-1 --log-group-name "$EDGE_LOG" --start-time "$RUN_T0_MS" --query 'events[].message' --output json 2>/dev/null || echo '[]')"
  counts="$(jq -c '[.[] | fromjson? | .["viewer-request-log-data"] // "-" | ascii_downcase] | group_by(.) | map({(.[0]): length}) | add // {}' <<<"$events")"
  note "requests per viewer-request-log-data value: $counts"
  check "a is counted" yes "$(yes_no jq -e --arg t "${TENANT_A,,}" '.[$t] > 0' <<<"$counts")"
  check "b is counted" yes "$(yes_no jq -e --arg t "${TENANT_B,,}" '.[$t] > 0' <<<"$counts")"
  if [[ "$MODE" == host ]]; then
    check "x-host-header agrees with the field on a's host" 0 "$(jq --arg h "$(host_of "$TENANT_A")" --arg t "${TENANT_A,,}" \
      '[.[] | fromjson? | select(.["x-host-header"] == $h) | select((.["viewer-request-log-data"] // "" | ascii_downcase) != $t)] | length' <<<"$events")"
    check "an /assets/* load on a's host names a" yes "$(yes_no jq -e --arg h "$(host_of "$TENANT_A")" --arg t "${TENANT_A,,}" \
      'any(.[] | fromjson? ; .["x-host-header"] == $h and (.["cs-uri-stem"] | startswith("/assets/")) and ((.["viewer-request-log-data"] // "") | ascii_downcase) == $t)' <<<"$events")"
    check "login.<appDomain> leaves the field empty" 0 "$(jq --arg h "login.${APP_DOMAIN}" \
      '[.[] | fromjson? | select(.["x-host-header"] == $h) | select((.["viewer-request-log-data"] // "-") != "-")] | length' <<<"$events")"
  fi
  # The refused calls of steps 11 to 13 (step 11 alone in host mode: steps 12 and 13 are single-mode steps).
  local refused last=13
  [[ "$MODE" == host ]] && last=11
  refused="$(as_test aws logs filter-log-events --region "$REGION" --log-group-name "$ACCESS_LOG" \
    --start-time "${STEP_START_MS[11]}" --end-time "${STEP_END_MS[$last]}" \
    --filter-pattern '{ $.status = "403" }' --query 'events[].message' --output json 2>/dev/null | jq -r '[.[] | fromjson | .callerAccount] | unique | join(",")' || true)"
  check "access log names the edge account on the refused calls of step 11" yes "$(yes_no grep -q "$EDGE_ACCOUNT" <<<"$refused")"
  if [[ "$MODE" == single ]]; then
    check "access log names the control plane's account on the refused calls of step 12" yes "$(yes_no grep -q "$CP_ACCOUNT" <<<"$refused")"
  fi
  # The global hook role's writes, counted in each step's own window.
  check "registrar log names the global hook role on the writes of step 2" "[1-9][0-9]*" \
    "$(log_count "$REGISTRAR_LOG" "$REGION" '{ $.role = "hook" }' "${STEP_START_MS[02]}" "" "${STEP_END_MS[02]}")"
  if [[ "$MODE" == single ]]; then
    check "registrar log names the global hook role on the write of step 13" "[1-9][0-9]*" \
      "$(log_count "$REGISTRAR_LOG" "$REGION" '{ $.role = "hook" }' "${STEP_START_MS[13]}" "" "${STEP_END_MS[13]}")"
  fi
}

step_16() {
  section "16. deleting b's deployment removes b's route before the delete script"
  local t0; t0="$(now_ms)"
  api_expect "DeleteDeployment b 202" 202 DELETE "$(deployment_path "$TENANT_B")"
  check "b's deployment is gone" yes "$(yes_no api_gone "$(deployment_path "$TENANT_B")")"
  state_set B_DEPLOYMENT_DELETED yes
  check "b's entry is gone" null "$(entry "tenant#${TENANT_B,,}")"
  token_for b B_TOKEN
  wait_status "b's token 403 once the entry is gone" 403 "$APP_DOMAIN" /api/whoami B_TOKEN 180
  sleep 15
  check "registrar log names the global hook role on the delete" "[1-9][0-9]*" "$(log_count "$REGISTRAR_LOG" "$REGION" '{ $.role = "hook" }' "$t0")"
}

# -- Steps 17 and 18 (host) -----------------------------------------------------------------------
step_17() {
  section "17. host addressing: tenant hosts, the rate rules"
  token_for a A_TOKEN; token_for b B_TOKEN
  local ha hb st start sent first rule
  ha="$(host_of "$TENANT_A")"; hb="$(host_of "$TENANT_B")"
  st="$(edge GET "$ha" /config.json)"; check "a's host /config.json names a" "200:${TENANT_A}" "${st}:$(body_tenant)"
  st="$(edge GET "nobody-${RUN_ID}.${APP_DOMAIN}" /config.json)"; check "unregistered host 404" 404 "$st"; check_headers "host 404"
  st="$(edge GET "$ha" /api/whoami)"; check "a's host, no token 401" 401 "$st"
  check "WWW-Authenticate: Bearer" 'Bearer.*' "$(header www-authenticate)"
  local t0; t0="$(now_ms)"
  st="$(edge GET "$hb" /api/whoami A_TOKEN)"; check "a's token on b's host 403" 403 "$st"
  sleep 20; check "no cell B line for it" 0 "$(log_count "$CELL_B_LOG" "$REGION" '' "$t0")"
  # The per-IP rule above the per-host one for this step, then back (ADR-0021).
  ctx_set ipRequestsPer5Min "$(( TENANT_RATE * 10 ))"
  start=$(date +%s); deploy_one FrontDoor/Edge rate-up || check "edge update for the rate step" ok failed
  local updated; updated=$(date +%s)
  note "the web ACL update took $(( updated - start )) s; waiting 60 s for the edge"
  sleep 60
  local attempt
  for attempt in 1 2 3 4; do
    first=""; rule=""; sent=0; start=$(date +%s)
    while (( $(elapsed "$start") < 300 )); do
      for _ in 1 2 3 4 5 6 7 8; do edge GET "$ha" /api/whoami A_TOKEN >"$TMP/rate.$_" & done; wait
      sent=$((sent + 8))
      if grep -qx 429 "$TMP"/rate.*; then first=429; st="$(edge GET "$ha" /api/whoami A_TOKEN)"; rule="$(header x-tfd-rate-rule)"; break; fi
    done
    note "attempt ${attempt}: ${sent} requests, first 429 after $(elapsed "$start") s, rule ${rule:-none}"
    if [[ "$first" == 429 && "$rule" == host ]]; then
      note "the check passed $(elapsed "$updated") s after the stack update finished"
      break
    fi
    [[ "$first" == 429 ]] || break
    (( attempt < 4 )) || break
    note "the old per-IP value still applies: waiting out the 5-minute window"; sleep 300
  done
  check "a over its rate: 429 from the per-host rule" "429:host" "${first:-none}:${rule:-none}"
  st="$(edge GET "$hb" /api/whoami B_TOKEN)"; check "b still served" 200 "$st"
  ctx_set ipRequestsPer5Min "$IP_RATE"
  deploy_one FrontDoor/Edge rate-down || check "edge update back" ok failed
  test_fn GET /api/whoami "$APP_DOMAIN"
  check "TestFunction with Host <appDomain>: 404" 404 "$(tf_status)"
}

step_18() {
  section "18. the sign-in host (ADR-0016)"
  local ha login st state loc logout_state
  ha="$(host_of "$TENANT_A")"; login="login.${APP_DOMAIN}"
  st="$(edge GET "$ha" "/signin-state?nonce=integnonce000000000000" '' -H 'Sec-Fetch-Site: same-origin')"
  state="$(json_get .state)"; check "/signin-state same-origin returns a state" "200:yes" "${st}:$(yes_no test -n "$state")"
  st="$(edge GET "$ha" "/signin-state?nonce=integnonce000000000000" '' -H 'Sec-Fetch-Site: cross-site')"; check "cross-site 403" 403 "$st"
  st="$(edge GET "$ha" "/signin-state?nonce=bad" '' -H 'Sec-Fetch-Site: same-origin')"; check "malformed nonce 400" 400 "$st"
  st="$(edge GET "$login" "/callback?code=integcode&state=${state}")"; loc="$(header location)"
  check "the sign-in host sends the code to a's /callback" "302:yes" "${st}:$(yes_no grep -q "^https://${ha}/callback?code=integcode" <<<"$loc")"
  skip "a real sign-in through the issuer and the SPA's exchange: needs a browser and the issuer's callback URLs (spec §10, run by hand)"
  st="$(edge GET "$login" "/callback?code=integcode")"; check "no state 400" 400 "$st"
  st="$(edge GET "$login" "/callback?code=integcode&state=${state}x")"; check "changed state 400" 400 "$st"
  st="$(edge GET "$login" "/callback?code=integcode&state=$(edge_tool state "$KVS" "nobody-${RUN_ID}.${APP_DOMAIN}")")"; check "unregistered host's state 400" 400 "$st"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_B}/status" '{"status":"suspended"}')"; check "operator suspends b 200" 200 "$st"
  propagate 90
  st="$(edge GET "$login" "/callback?code=integcode&state=$(edge_tool state "$KVS" "$(host_of "$TENANT_B")")")"; check "suspended tenant's host 400" 400 "$st"
  st="$(edge GET "$login" "/callback?code=integcode&state=$(edge_tool state "$KVS" "$ha" -10)")"
  check "expired state: 302 to a's /" "302:https://${ha}/" "${st}:$(header location)"
  test_fn GET /config.json dedicated-a.example.com
  check "dedicated domain /config.json names signInHost a's host" "(https://)?${ha}" "$(tf_body | jq -r .signInHost 2>/dev/null)"
  test_fn GET /signin-state dedicated-a.example.com '{"nonce":{"value":"integnonce000000000000"}}' "$(echo '{"sec-fetch-site":"same-origin"}' | headers_file same-origin)"
  check "dedicated domain /signin-state 400" 400 "$(tf_status)"
  test_fn GET /logout dedicated-a.example.com
  check "dedicated domain /logout 400" 400 "$(tf_status)"
  st="$(edge GET "$login" "/callback?code=integcode&state=$(edge_tool state "$KVS" dedicated-a.example.com)")"; check "a dedicated domain's state 400" 400 "$st"
  st="$(edge GET "$ha" /logout)"; loc="$(header location)"
  check "/logout on a's host 302 to the issuer" 302 "$st"
  check "/logout carries client_id, response_type=code and the sign-in host's redirect_uri" yes "$(yes_no bash -c '
    [[ "$1" == *"client_id=$2"* && "$1" == *response_type=code* && "$1" == *"redirect_uri=$3"* && "$1" == *state=* ]]' _ "$loc" "$IDENTITY_CLIENT" \
    "$(jq -rn --arg u "https://${login}/callback" '$u|@uri')")"
  check "/logout Clear-Site-Data" '"storage", "cache"' "$(header clear-site-data)"
  logout_state="$(sed -n 's/.*[?&]state=\([^&]*\).*/\1/p' <<<"$loc")"
  st="$(edge GET "$login" "/callback?state=${logout_state}")"
  check "after the issuer's sign-out, the sign-in host sends a's / with no code or state" "302:https://${ha}/" "${st}:$(header location)"
  st="$(edge GET "$login" /logout)"; check "login.<appDomain>/logout: the signed-out page" 200 "$st"
}

# -- Steps 19 to 23 ------------------------------------------------------------------------------
step_19() {
  section "19. an application without a front door"
  local before after definition
  definition="$(application_definition test/integ/app/plain test/integ/app/plain noop.sh noop.sh noop.sh | jq -c '.maxTenants = 1')"
  api_expect "PutApplication ${PLAIN_APP} 202" 202 PUT "applications/${PLAIN_APP}" "$definition"
  need api_poll "applications/${PLAIN_APP}" .application.status ACTIVE 300 5
  state_set PLAIN_REGISTERED yes
  before="$(entry "tenant#${TENANT_A,,}")"
  need create_deployment a "" "$PLAIN_APP"
  state_set PLAIN_CELL "$DEPLOYED_CELL"
  check "${PLAIN_APP}'s cell ran front-door-post" ".*front-door-post.*" "$(last_hooks "cells/${PLAIN_CELL}" .cell)"
  check "a's ${PLAIN_APP} deployment ran front-door-post" ".*front-door-post.*" "$(last_hooks "$(deployment_path "$TENANT_A" "$PLAIN_APP")" .deployment)"
  check "no cell# for ${PLAIN_APP}'s cell" null "$(entry "cell#${PLAIN_CELL,,}")"
  after="$(entry "tenant#${TENANT_A,,}")"
  check "a's entry unchanged" yes "$(yes_no test "$before" = "$after")"
}

step_20() {
  section "20. the shared role outside its operation (tfd-probe)"
  local hook
  hook="$(jq -nc --arg loc "${SOURCE_BUCKET}/${SOURCE_KEY}" --arg ver "$SOURCE_VERSION" '{
    events: ["CELL_UPDATE", "DEPLOYMENT_UPDATE"], phase: "POST", source: {type: "S3", location: $loc, sourceVersion: $ver},
    script: "samples/tenant-front-door/test/integ/hooks/probe-hook.sh", timeoutMinutes: 10}')"
  api_expect "PutHook tfd-probe 200" 200 PUT hooks/tfd-probe "$hook"
  state_set PROBE_HOOK yes
  api_expect "UpdateDeployment a 202" 202 PUT "$(deployment_path "$TENANT_A")" '{}'
  api_poll "$(deployment_path "$TENANT_A")" .deployment.status ACTIVE 1200 30 || true
  check "a's update ACTIVE: tfd-probe got 409 and 409" ACTIVE "$POLLED"
  api_expect "UpdateCell A 202" 202 PUT "cells/${CELL_A}" '{"removeParameters":["TFD_CELL_PROBE","TFD_CELL_PROBE_PEER"]}'
  api_poll "cells/${CELL_A}" .cell.status ACTIVE 1200 30 || true
  check "cell A's update ACTIVE: tfd-probe got 409 and 400" ACTIVE "$POLLED"
  token_for a A_TOKEN
  local st; st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN)"; check "a still served by cell A" "200:cell-a" "${st}:$(body_cell)"
  api_expect "DeleteHook tfd-probe 200" 200 DELETE hooks/tfd-probe
  [[ "$LAST_OK" == no ]] || state_set PROBE_HOOK no
}

step_21() {
  section "21. a cell event without frontDoorApiDomain"
  api_expect "UpdateCell A with FRONT_DOOR_OUTPUT off 202" 202 PUT "cells/${CELL_A}" '{"parameters":{"FRONT_DOOR_OUTPUT":"off"}}'
  api_poll "cells/${CELL_A}" .cell.status UPDATE_FAILED 1200 30 || true
  check "cell A UPDATE_FAILED naming front-door-post" "UPDATE_FAILED:yes" "${POLLED}:$(yes_no grep -q front-door-post <<<"$(json_get '.cell.statusReason // ""')")"
  token_for a A_TOKEN
  local st; st="$(edge GET "$APP_DOMAIN" /api/whoami A_TOKEN)"; check "a still served" 200 "$st"
  api_expect "UpdateCell A removing FRONT_DOOR_OUTPUT 202" 202 PUT "cells/${CELL_A}" '{"removeParameters":["FRONT_DOOR_OUTPUT"]}'
  api_poll "cells/${CELL_A}" .cell.status ACTIVE 1200 30 || true
  check "cell A ACTIVE again" ACTIVE "$POLLED"
}

# break_hook_parameter / restore_hook_parameter: the front door hook parameter's registrarUrl, in the control plane's account.
HOOK_PARAMETER_VALUE=""
break_hook_parameter() {
  HOOK_PARAMETER_VALUE="$(in_cp aws ssm get-parameter --region "$REGION" --name "$HOOK_PARAMETER" --query Parameter.Value --output text)"
  state_set HOOK_PARAMETER_BROKEN yes
  in_cp aws ssm put-parameter --region "$REGION" --name "$HOOK_PARAMETER" --overwrite --type String \
    --value "$(jq -c --arg u "${REGISTRAR}integ-broken/" '.registrarUrl = $u' <<<"$HOOK_PARAMETER_VALUE")" >/dev/null
}
restore_hook_parameter() {
  [[ -n "$HOOK_PARAMETER_VALUE" ]] || return 0
  in_cp aws ssm put-parameter --region "$REGION" --name "$HOOK_PARAMETER" --overwrite --type String --value "$HOOK_PARAMETER_VALUE" >/dev/null
  state_set HOOK_PARAMETER_BROKEN no
}
skipped_count() { # HookSkipped since T (ISO)
  in_cp aws cloudwatch get-metric-data --region "$REGION" --start-time "$1" --end-time "$(date -u -d '+5 min' +%FT%TZ)" \
    --metric-data-queries "$(jq -nc --arg ns "${FLEET}/hooks" '[{Id: "s", MetricStat: {Metric: {Namespace: $ns, MetricName: "HookSkipped"}, Period: 3600, Stat: "Sum"}}]')" \
    --query 'MetricDataResults[0].Values | sum(@)' --output text 2>/dev/null
}

step_22() {
  section "22. a skipped delete hook, and a suspension across a re-created deployment"
  local st since dt
  create_tenant c "tfd-integ-c-${RUN_ID}"
  need create_deployment c
  check "c is in cell A" "$CELL_A" "$DEPLOYED_CELL"
  token_for c C_TOKEN
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_C}/status" '{"status":"suspended"}')"; check "operator suspends c 200" 200 "$st"
  propagate 90
  st="$(edge GET "$APP_DOMAIN" /api/whoami C_TOKEN)"; check "c's token 503" 503 "$st"
  dt="$(entry "tenant#${TENANT_C,,}" | jq -r .dt)"
  since="$(date -u +%FT%TZ)"
  break_hook_parameter
  api_expect "DeleteDeployment c with the hook parameter broken 202" 202 DELETE "$(deployment_path "$TENANT_C")"
  check "c's deployment is deleted after front-door-pre is skipped" yes "$(yes_no api_gone "$(deployment_path "$TENANT_C")" 2400)"
  sleep 90
  check "the control plane counted the skip" "[1-9].*" "$(skipped_count "$since")"
  check "c's entry stays suspended" suspended "$(entry "tenant#${TENANT_C,,}" | jq -r .s)"
  restore_hook_parameter
  need create_deployment c
  check "the new deployment replaced the entry (another dt), still suspended" "yes:suspended" \
    "$(entry "tenant#${TENANT_C,,}" | jq -r --arg dt "$dt" '"\(if (.dt | tostring) != $dt then "yes" else "no" end):\(.s)"')"
  token_for c C_TOKEN
  st="$(edge GET "$APP_DOMAIN" /api/whoami C_TOKEN)"; check "c's token still 503" 503 "$st"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_C}/status" '{"status":"active"}')"; check "operator resumes c 200" 200 "$st"
  propagate 90
  st="$(edge GET "$APP_DOMAIN" /api/whoami C_TOKEN)"; check "c served by cell A" "200:cell-a" "${st}:$(body_cell)"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_C}/status" '{"status":"suspended"}')"; check "operator suspends c again 200" 200 "$st"
  api_expect "DeleteDeployment c with the parameter intact 202" 202 DELETE "$(deployment_path "$TENANT_C")"
  check "c's deployment is deleted" yes "$(yes_no api_gone "$(deployment_path "$TENANT_C")")"
  check "front-door-pre removed c's entry" null "$(entry "tenant#${TENANT_C,,}")"
  propagate 90
  st="$(edge GET "$APP_DOMAIN" /api/whoami C_TOKEN)"; check "c's token 403" 403 "$st"
  need create_deployment c
  check "the new entry is active (AR-31)" active "$(entry "tenant#${TENANT_C,,}" | jq -r .s)"
  token_for c C_TOKEN
  wait_status "c served by cell A" 200 "$APP_DOMAIN" /api/whoami C_TOKEN 180
  break_hook_parameter
  api_expect "DeleteDeployment c with the parameter broken again 202" 202 DELETE "$(deployment_path "$TENANT_C")"
  check "c's deployment is deleted after the skip" yes "$(yes_no api_gone "$(deployment_path "$TENANT_C")" 2400)"
  restore_hook_parameter
  st="$(as "$EDGE_OPERATOR" DELETE "tenants/${TENANT_C}")"; check "operator DeleteTenantRoute c 200" 200 "$st"
  propagate 90
  st="$(edge GET "$APP_DOMAIN" /api/whoami C_TOKEN)"; check "c's token 403" 403 "$st"
}

step_23() {
  section "23. /agents/* on the tenant-only distribution (ADR-0019)"
  token_for a A_TOKEN
  local host auth path st U_TOKEN t0
  host="$(front "$TENANT_A")"
  auth="$(auth_headers A_TOKEN)"
  test_fn POST /agents/support-bot/invocations "$host" '{"x":{"value":"1"}}' "$auth"
  check "the agent route is rewritten" "/support-bot/invocations:1:${TENANT_A,,}" \
    "$(jq -r '"\(.request.uri):\(.request.querystring.x.value):\(.request.headers["x-tenant-route"].value)"' <<<"$TF_OUT")"
  for path in /agents /agents/ /agents/support-bot /agents/support-bot/invocations/ /agents/Support-Bot/invocations \
      "/agents/$(printf 'b%.0s' {1..33})/invocations" /agents/support-bot/delegations /agents//invocations \
      /agents/%73upport-bot/invocations /agents/..%2fentitlements/invocations; do
    test_fn POST "$path" "$host" '' "$auth"
    check "router 404 for ${path}" 404 "$(tf_status)"
  done
  test_fn POST /agents/entitlements/invocations "$host" '' "$auth"
  check "/agents/entitlements/invocations passes, rewritten" /entitlements/invocations "$(jq -r .request.uri <<<"$TF_OUT")"
  [[ "$MODE" == host ]] && return
  test_fn POST /agents/support-bot/invocations "$host"
  check "agent route, no token 401" 401 "$(tf_status)"
  ti_token "$IDENTITY_API" "$TENANT_U" "$TI_USER_U" U_TOKEN
  test_fn POST /agents/support-bot/invocations "$host" '' "$(auth_headers U_TOKEN)"
  check "agent route, unregistered tenant 403" 403 "$(tf_status)"
  test_fn POST /agents/support-bot/invocations "$host" '' "$(auth_headers A_TOKEN '{"sec-fetch-site":"same-site"}')"
  check "agent route, same-site 403" 403 "$(tf_status)"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_A}/status" '{"status":"suspended"}')"; check "operator suspends a 200" 200 "$st"
  state_set A_SUSPENDED yes
  propagate 90
  st="$(edge POST "$APP_DOMAIN" /agents/support-bot/invocations A_TOKEN)"
  check "suspended a on the agent route 503, Retry-After 300" "503:300" "${st}:$(header retry-after)"
  st="$(as "$EDGE_OPERATOR" PUT "tenants/${TENANT_A}/status" '{"status":"active"}')"; check "operator resumes a 200" 200 "$st"
  state_set A_SUSPENDED no
  propagate 90
  # One streamed call through the real distribution; each line is stamped on arrival.
  t0="$(now_ms)"
  token_for a A_TOKEN
  curl -sN --max-time 30 -X POST --config - "https://${APP_DOMAIN}/agents/support-bot/invocations" \
    <<<"header = \"Authorization: Bearer ${A_TOKEN}\"" | while IFS= read -r line; do
      [[ "$line" == data:* ]] && printf '%s %s\n' "$(date +%s%3N)" "${line#data: }"; done >"$TMP/stream"
  check "ten events streamed" 10 "$(grep -c . "$TMP/stream" || true)"
  local lag gaps
  lag="$(head -1 "$TMP/stream" | while read -r got ev; do echo $(( got - $(jq -r .at <<<"$ev") )); done)"
  note "first event arrived ${lag:-?} ms after the stand-in wrote it (two hosts' clocks)"
  check "first byte within 1 s of the stand-in's first write" yes "$(yes_no test "${lag:-99999}" -gt -1000 -a "${lag:-99999}" -lt 1000)"
  gaps="$(awk 'NR>1 { printf "%d ", $1 - prev } { prev = $1 }' "$TMP/stream")"
  note "client gaps between events (ms): $gaps"
  check "one event per read, gaps near 500 ms" yes "$(yes_no awk -v g="$gaps" 'BEGIN { n = split(g, a, " "); ok = n == 9; for (i = 1; i <= n; i++) if (a[i] < 300 || a[i] > 800) ok = 0; exit !ok }')"
  sleep 20
  local rec
  rec="$(as_test aws logs filter-log-events --region "$REGION" --log-group-name "$INGRESS_LOG" --start-time "$t0" \
    --filter-pattern '"agent-ingress-request"' --query 'events[-1].message' --output text 2>/dev/null || true)"
  check "the stand-in saw the stage path without /agents" /prod/support-bot/invocations "$(jq -r .stagePath <<<"$rec" 2>/dev/null)"
  check "the stand-in saw x-tenant-route a" "${TENANT_A,,}" "$(jq -r .tenantRoute <<<"$rec" 2>/dev/null)"
  check "the stand-in saw the viewer's bearer" "$(printf 'Bearer %s' "$A_TOKEN" | sha256sum | cut -c1-16)" "$(jq -r .authorizationFingerprint <<<"$rec" 2>/dev/null)"
  t0="$(now_ms)"
  st="$(edge POST "$APP_DOMAIN" /agents A_TOKEN)"; check "POST /agents: CloudFront's own 403" 403 "$st"
  st="$(edge POST "$APP_DOMAIN" /agents/ A_TOKEN)"; check "POST /agents/: the router's 404" 404 "$st"
  sleep 20
  check "the stand-in logged neither" 0 "$(log_count "$INGRESS_LOG" "$REGION" '"agent-ingress-request"' "$t0")"
}

# The steps each mode runs (spec §10: integ.host.ts repeats the steps marked host).
STEPS_SINGLE=(01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 19 20 21 22 23)
STEPS_HOST=(01 02 03 04 11 15 17 18 23)
