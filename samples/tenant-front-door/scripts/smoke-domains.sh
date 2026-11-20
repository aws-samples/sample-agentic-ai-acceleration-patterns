#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Live check of dedicated domains (spec §3.4 step 5, ADR-0018) against the
# smoke deployment: `scripts/smoke.sh deploy` with SMOKE_DEDICATED_DOMAINS=true,
# which also deploys the stand-in control plane (test/smoke/smoke.app.ts).
#
#   scripts/smoke-domains.sh
#
# Inputs (environment): SMOKE_APP_DOMAIN, SMOKE_ZONE_ID, SMOKE_ZONE_NAME and
# SMOKE_DEDICATED_DOMAIN, a name in the zone outside SMOKE_APP_DOMAIN.
#
# The run: the stand-in global hook role registers the cell and a tenant
# route through the registrar, which reads the stand-in control plane; the
# edge operator role sets the dedicated domain; the run publishes the
# challenge and ACM's validation record in the TfdSmoke-dns stack, and
# repeats the call until the domain is routed. It then checks the
# certificate and distribution tenant tags, serves the SPA and the cell API
# on the domain through the stack's connection group, runs the daily
# re-check by hand, drops the domain and runs the removal job until the
# distribution tenant and the certificate are gone. Tokens and keys stay
# in shell variables and 0600 files (scripts/CONVENTIONS.md).

set -euo pipefail
cd "$(dirname "$0")/.."

: "${SMOKE_APP_DOMAIN:?set SMOKE_APP_DOMAIN}" "${SMOKE_ZONE_ID:?set SMOKE_ZONE_ID}" "${SMOKE_DEDICATED_DOMAIN:?set SMOKE_DEDICATED_DOMAIN}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
REGION="$AWS_REGION"
DD="$SMOKE_DEDICATED_DOMAIN"
APPLICATION_ID=tfd-smoke
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
    FAILS=$((FAILS + 1)); echo "  FAIL $1: want $2, got $3 (body: $(head -c 200 "$BODY" | tr -d '\n'))"; fi
}
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
elapsed() { echo $(( $(date +%s) - $1 )); }
cf() { aws cloudfront --region us-east-1 "$@"; }
acm() { aws acm --region us-east-1 "$@"; }

# -- SigV4 (credentials never printed) ----------------------------------------
load_sigv4() { # [ROLE_ARN]
  local creds
  if [[ -n "${1:-}" ]]; then
    creds="$(aws sts assume-role --role-arn "$1" --role-session-name tfd-smoke-domains --query Credentials --output json)"
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
as() { # ROLE_VAR METHOD URL [JSON]: one call as the named role
  load_sigv4 "${!1}"; signed "$2" "$3" "${4:-}"
}

# -- tenant-identity ------------------------------------------------------------
TENANTS=()
create_tenant() { # NAME -> TENANT_ID, ADMIN_USER
  local st
  load_sigv4
  st="$(signed POST "${IDENTITY_API}platform/tenants" "$(jq -nc --arg n "$1" --arg e "success+$1@simulator.amazonses.com" '{name: $n, adminEmail: $e, scopes: ["app/use"]}')")"
  [[ "$st" == 201 ]] || { echo "CreateTenant $1: HTTP $st"; exit 1; }
  TENANT_ID="$(jq -r .tenant.tenantId "$BODY")"; ADMIN_USER="$(jq -r .admin.user.username "$BODY")"
  TENANTS+=("$TENANT_ID")
}
issue_token() { # TENANT_ID USER VAR
  local st pw
  load_sigv4
  pw="Tfd-Smoke-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')!"
  st="$(signed POST "${IDENTITY_API}platform/tenants/$1/users/$2/token" "$(printf '%s' "$pw" | jq -Rs '{password: .}')")"
  [[ "$st" == 200 ]] || { echo "IssueToken: HTTP $st"; exit 1; }
  printf -v "$3" '%s' "$(jq -r .accessToken "$BODY")"; : >"$BODY"
}

# -- the stand-in control plane's fixtures --------------------------------------
fixture() { # PATH JSON
  aws dynamodb put-item --table-name "$FIXTURES" --item "$(jq -nc --arg p "$1" --arg b "$2" '{pk: {S: $p}, body: {S: $b}}')" >/dev/null
}
unfixture() { aws dynamodb delete-item --table-name "$FIXTURES" --key "$(jq -nc --arg p "$1" '{pk: {S: $p}}')" >/dev/null || true; }
cell_fixture() { fixture "/cells/$CELL_ID" "$(jq -nc --arg a "$ACCOUNT" --arg s "$1" '{cell: {applicationId: "tfd-smoke", accountId: $a, status: $s}}')"; }
deployment_fixture() { # TENANT STATUS
  fixture "/tenants/$1/deployments/$APPLICATION_ID" \
    "$(jq -nc --arg a "$ACCOUNT" --arg c "$CELL_ID" --arg s "$2" --arg t "$CREATED_AT" '{accountId: $a, deployment: {applicationId: "tfd-smoke", cellId: $c, status: $s, createdAt: $t}}')"
}

# -- the edge, on the dedicated domain through the connection group ------------
dd_get() { # PATH [TOKEN_VAR] -> status; body in $BODY
  local config=""
  [[ -n "${2:-}" ]] && config="header = \"Authorization: Bearer ${!2}\""
  curl -s -o "$BODY" -w '%{http_code}' --max-time 15 --connect-to "${DD}:443:${ROUTING}:443" --config - "https://${DD}$1" <<<"$config" || true
}

# -- the TfdSmoke-dns stack: the run's records, replaced on each deploy -------
dns_deploy() { # JSON list of {name, type, value}
  local t
  t=$(date +%s)
  npx cdk deploy TfdSmoke-dns --app "${SMOKE_APP[*]}" --require-approval never \
    --context dnsRecords="$1" --context zoneId="$SMOKE_ZONE_ID" >"$TMP/dns.log" 2>&1 || { tail -30 "$TMP/dns.log"; exit 1; }
  note "TfdSmoke-dns deployed in $(elapsed "$t") s"
}

domain_call() { # -> status; body in $BODY (the operator's PutTenantRoute with the domain)
  as OPERATOR PUT "${REGISTRAR}tenants/${A}" "$(jq -nc --arg d "$DD" '{customDomain: $d}')"
}

# ---------------------------------------------------------------------------------

IDENTITY_API="$(param "$IDENTITY_PREFIX/apiUrl")"; [[ "$IDENTITY_API" == */ ]] || IDENTITY_API="$IDENTITY_API/"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
EDGE="$(param "$PARAM_EDGE")"
REGISTRAR="$(jq -r .registrarUrl <<<"$EDGE")"; [[ "$REGISTRAR" == */ ]] || REGISTRAR="$REGISTRAR/"
DIST_ID="$(jq -r .distributionArn <<<"$EDGE")"; DIST_ID="${DIST_ID##*/}"
ROUTING="$(out TenantFrontDoor-main RoutingEndpoint)"
FIXTURES="$(out TfdSmoke-control-plane FixtureTable)"
OPERATOR="$(out TfdSmoke-support EdgeOperatorRoleArn)"
HOOK="$(out TfdSmoke-support GlobalHookRoleArn)"
CELL_DOMAIN="$(out TfdSmoke-cell ApiDomain)"
SWEEPER=""
for fn in $(aws cloudformation describe-stack-resources --stack-name TenantFrontDoor-main \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text); do
  if [[ "$(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables.SWEEPER_TABLE_NAME' --output text)" != None ]]; then SWEEPER="$fn"; fi
done
[[ -n "$SWEEPER" ]] || { echo "no sweeper function: deploy with SMOKE_DEDICATED_DOMAINS=true"; exit 1; }
SWEEPER_TABLE="$(aws lambda get-function-configuration --function-name "$SWEEPER" --query 'Environment.Variables.SWEEPER_TABLE_NAME' --output text)"
note "distribution ${DIST_ID}, routing endpoint ${ROUTING}, domain ${DD}"

A=""; A_TOKEN=""; T_START=$(date +%s)
cleanup() {
  [[ -n "$A" ]] && { as OPERATOR DELETE "${REGISTRAR}tenants/${A}" >/dev/null || true; }
  as OPERATOR DELETE "${REGISTRAR}cells/${CELL_ID}" >/dev/null 2>&1 || true
  load_sigv4
  for t in "${TENANTS[@]}"; do signed DELETE "${IDENTITY_API}platform/tenants/$t" >/dev/null || true; done
  if [[ -n "$A" ]]; then
    aws ssm delete-parameter --name "/application-plane/tenants/$A/$APPLICATION_ID/smoke" >/dev/null 2>&1 || true
    unfixture "/tenants/$A"; unfixture "/tenants/$A/deployments/$APPLICATION_ID"
  fi
  unfixture "/cells/$CELL_ID"
}
trap 'cleanup; rm -f "$TMP"/*; rmdir "$TMP"' EXIT

echo "1. the hook role registers the cell and tenant a through the stand-in control plane"
create_tenant "tfd-smoke-dd-$$"; A="$TENANT_ID"; issue_token "$A" "$ADMIN_USER" A_TOKEN
aws ssm put-parameter --name "/application-plane/tenants/$A/$APPLICATION_ID/smoke" --type String --value smoke --overwrite >/dev/null
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cell_fixture UPDATING
fixture "/tenants/$A" "$(jq -nc '{tenant: {name: "Smoke Dedicated"}}')"
deployment_fixture "$A" UPDATING
st="$(as HOOK PUT "${REGISTRAR}cells/${CELL_ID}" "$(jq -nc --arg d "$CELL_DOMAIN" '{apiDomain: $d}')")"
check "hook PutCellRoute while the cell is UPDATING 200" 200 "$st"
st="$(as HOOK PUT "${REGISTRAR}tenants/${A}" '{}')"
check "hook PutTenantRoute while the deployment is UPDATING 200" 200 "$st"
check "the entry's dt is the record's createdAt" "$(date -u -d "$CREATED_AT" +%s)000" "$(jq -r .dt "$BODY")"
st="$(as HOOK PUT "${REGISTRAR}tenants/${A}" "$(jq -nc --arg d "$DD" '{customDomain: $d}')")"
check "hook PutTenantRoute with a customDomain 403" 403 "$st"
cell_fixture ACTIVE; deployment_fixture "$A" ACTIVE
st="$(as HOOK PUT "${REGISTRAR}tenants/${A}" '{}')"
check "hook PutTenantRoute once the deployment is ACTIVE 409" 409 "$st"

if [[ "${SMOKE_GUARD:-}" == 1 ]]; then
  echo "G. the guard refuses turning dedicatedDomains off while a tenant holds a domain"
  st="$(domain_call)"
  check "operator sets the domain: 202" 202 "$st"
  tg=$(date +%s)
  if SMOKE_DEDICATED_DOMAINS=false scripts/smoke.sh deploy >"$TMP/guard.log" 2>&1; then guard_deploy=passed; else guard_deploy=failed; fi
  note "switch-off deploy ${guard_deploy} after $(elapsed "$tg") s"
  check "the switch-off deploy fails" failed "$guard_deploy"
  check "the main stack rolled back" UPDATE_ROLLBACK_COMPLETE "$(aws cloudformation describe-stacks --stack-name TenantFrontDoor-main --query 'Stacks[0].StackStatus' --output text)"
  check "the guard's reason is in the stack events" yes "$(aws cloudformation describe-stack-events --stack-name TenantFrontDoor-main \
    --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].ResourceStatusReason" --output text | grep -q 'cannot be turned off while' && echo yes || echo no)"
  st="$(domain_call)"
  check "the registrar still serves the domain flow: 202" 202 "$st"
  st="$(as OPERATOR PUT "${REGISTRAR}tenants/${A}" '{}')"
  check "operator drops the domain 200" 200 "$st"
  echo "result: ${PASS} passed, ${FAILS} failed"
  (( FAILS == 0 )); exit
fi

echo "2. the domain challenge (sub-steps 1 and 2)"
t0=$(date +%s)
st="$(domain_call)"
check "operator sets the domain: 202" 202 "$st"
check "stage domain-challenge" domain-challenge "$(jq -r .stage "$BODY")"
CHALLENGE_NAME="$(jq -r .record.name "$BODY")"; CHALLENGE_VALUE="$(jq -r .record.value "$BODY")"
check "record name" "_tfd-challenge.${DD}" "$CHALLENGE_NAME"
check "record value form (tfd-verify= and 43 characters)" yes "$([[ "$CHALLENGE_VALUE" =~ ^tfd-verify=[A-Za-z0-9_-]{43}$ ]] && echo yes || echo no)"
check "expiresAt about 7 days out" yes "$(jq -r --argjson now "$(date +%s)" '(.expiresAt - $now) | if . > 604000 and . < 604900 then "yes" else "no" end' "$BODY")"
st="$(domain_call)"
check "repeat before publishing: 202 missing (mismatch when an earlier run left its record)" "202:(missing|mismatch)" "${st}:$(jq -r .challenge "$BODY")"
dns_deploy "$(jq -nc --arg n "$CHALLENGE_NAME" --arg v "$CHALLENGE_VALUE" '[{name: $n, type: "TXT", value: $v}]')"
stage=domain-challenge
for i in $(seq 1 40); do
  st="$(domain_call)"; stage="$(jq -r '.stage // "routed"' "$BODY")"
  [[ "$stage" != domain-challenge ]] && break
  sleep 20
done
note "challenge passed after $(elapsed "$t0") s: HTTP ${st}, stage ${stage}"
check "challenge passes, certificate requested: 202 certificate" "202:certificate" "${st}:${stage}"

echo "3. the certificate (sub-steps 3 and 4)"
for i in $(seq 1 10); do
  [[ "$(jq -r '.record.type // empty' "$BODY")" == CNAME ]] && break
  sleep 5; st="$(domain_call)"
done
VAL_NAME="$(jq -r .record.name "$BODY")"; VAL_VALUE="$(jq -r .record.value "$BODY")"
check "ACM validation record returned" CNAME "$(jq -r .record.type "$BODY")"
CERT_ARN="$(acm list-certificates --includes 'keyTypes=RSA_2048,EC_prime256v1,EC_secp384r1' --query "CertificateSummaryList[?DomainName=='${DD}'].CertificateArn | [0]" --output text)"
TAGS="$(acm list-tags-for-certificate --certificate-arn "$CERT_ARN" --output json)"
check "certificate tag tenant" "${A,,}" "$(jq -r '.Tags[] | select(.Key=="tenant-front-door:tenant") | .Value' <<<"$TAGS")"
check "certificate tag distribution" "$DIST_ID" "$(jq -r '.Tags[] | select(.Key=="tenant-front-door:distribution") | .Value' <<<"$TAGS")"
check "certificate tag TenantId" "$A" "$(jq -r '.Tags[] | select(.Key=="TenantId") | .Value' <<<"$TAGS")"
dns_deploy "$(jq -nc --arg n "$CHALLENGE_NAME" --arg v "$CHALLENGE_VALUE" --arg cn "$VAL_NAME" --arg cv "$VAL_VALUE" \
  '[{name: $n, type: "TXT", value: $v}, {name: $cn, type: "CNAME", value: $cv}]')"
t1=$(date +%s)
for i in $(seq 1 60); do
  st="$(domain_call)"
  [[ "$st" == 200 ]] && break
  [[ "$st" == 202 ]] || note "repeat: HTTP ${st} $(head -c 160 "$BODY")"
  sleep 30
done
note "routed $(elapsed "$t1") s after the validation record, $(elapsed "$t0") s after the first call"
check "certificate issued, distribution tenant made, host# written: 200" 200 "$st"
check "certificate ISSUED" ISSUED "$(acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text)"
st="$(domain_call)"
check "a repeat once routed: 200" 200 "$st"

echo "4. the distribution tenant (sub-step 5)"
DT="$(cf get-distribution-tenant-by-domain --domain "$DD" --output json)"
DT_ID="$(jq -r .DistributionTenant.Id <<<"$DT")"; DT_ARN="$(jq -r .DistributionTenant.Arn <<<"$DT")"
check "on this distribution" "$DIST_ID" "$(jq -r .DistributionTenant.DistributionId <<<"$DT")"
check "in the stack's connection group" "$(cf list-distribution-tenants --query "DistributionTenantList[?Domains[0].Domain=='${SMOKE_APP_DOMAIN}'].ConnectionGroupId | [0]" --output text)" "$(jq -r .DistributionTenant.ConnectionGroupId <<<"$DT")"
check "with the certificate" "$CERT_ARN" "$(jq -r .DistributionTenant.Customizations.Certificate.Arn <<<"$DT")"
check "name within CloudFront's limit" 'tfd-[0-9a-f]{32}' "$(jq -r .DistributionTenant.Name <<<"$DT")"
DT_TAGS="$(cf list-tags-for-resource --resource "$DT_ARN" --output json)"
check "distribution tenant tag tenant" "${A,,}" "$(jq -r '.Tags.Items[] | select(.Key=="tenant-front-door:tenant") | .Value' <<<"$DT_TAGS")"
check "distribution tenant tag distribution" "$DIST_ID" "$(jq -r '.Tags.Items[] | select(.Key=="tenant-front-door:distribution") | .Value' <<<"$DT_TAGS")"
t2=$(date +%s)
for i in $(seq 1 60); do
  st="$(dd_get /)"; [[ "$st" == 200 ]] && break; sleep 15
done
note "served on ${DD} $(elapsed "$t2") s after the 200"
check "GET / on the dedicated domain 200" 200 "$st"
st="$(dd_get /config.json)"
check "GET /config.json on the dedicated domain 200" 200 "$st"
check "config.json names the tenant" "$A" "$(jq -r .tenantId "$BODY")"
check "config.json signs in on the shared host" "$SMOKE_APP_DOMAIN" "$(jq -r .signInHost "$BODY" | sed 's#^https://##')"
st="$(dd_get /api/whoami A_TOKEN)"
check "GET /api/whoami on the dedicated domain 200" 200 "$st"
check "answered by the cell for a" "$A" "$(jq -r .tenantId "$BODY")"

echo "5. the daily re-check, run by hand"
aws lambda invoke --function-name "$SWEEPER" --cli-binary-format raw-in-base64-out --payload '{"job":"recheck"}' "$TMP/lister.json" >/dev/null
check "lister ran" null "$(jq -r '.errorMessage // null' "$TMP/lister.json")"
for i in $(seq 1 12); do
  OUTCOME="$(aws dynamodb get-item --table-name "$SWEEPER_TABLE" --key "$(jq -nc --arg s "${A,,}#${DD}" '{pk: {S: "ENTRY"}, sk: {S: $s}}')" --query 'Item.lastOutcome.S' --output text)"
  [[ "$OUTCOME" != None ]] && break; sleep 5
done
check "page recorded a pass for the domain" pass "$OUTCOME"

echo "6. drop the domain (release), then the removal job"
st="$(as OPERATOR PUT "${REGISTRAR}tenants/${A}" '{}')"
check "operator drops the domain 200" 200 "$st"
check "the distribution tenant is disabled by the release" False "$(cf get-distribution-tenant --identifier "$DT_ID" --query DistributionTenant.Enabled --output text)"
t3=$(date +%s)
gone_dt=no; gone_cert=no
for i in $(seq 1 40); do
  aws lambda invoke --function-name "$SWEEPER" --cli-binary-format raw-in-base64-out --payload '{"job":"remove"}' "$TMP/remove.json" >/dev/null
  cf get-distribution-tenant --identifier "$DT_ID" >/dev/null 2>&1 || gone_dt=yes
  acm describe-certificate --certificate-arn "$CERT_ARN" >/dev/null 2>&1 || gone_cert=yes
  [[ "$gone_dt$gone_cert" == yesyes ]] && break
  sleep 60
done
note "removal took $(elapsed "$t3") s"
check "removal job deleted the distribution tenant" yes "$gone_dt"
check "removal job deleted the certificate" yes "$gone_cert"
sleep 90
st="$(dd_get /)"
check "the dropped domain no longer serves the SPA" "000|403|404|421|5[0-9][0-9]" "$st"

note "total $(elapsed "$T_START") s"
echo "result: ${PASS} passed, ${FAILS} failed"
(( FAILS == 0 ))
