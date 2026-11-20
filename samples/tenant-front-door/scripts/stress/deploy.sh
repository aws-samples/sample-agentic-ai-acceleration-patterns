#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress slice, `deploy`: the front door in `single` mode on the smoke stack
# (test/smoke/smoke.app.ts): a stand-in control plane, the edge operator and
# global hook roles, the three front door stacks and one demo cell. Slice mode
# only; the platform run deploys the control plane and the cell itself.
#
# Inputs (environment): AWS_REGION, STRESS_PREFIX, STRESS_HOME from the runner,
# and STRESS_FD_ZONE_ID and STRESS_FD_ZONE_NAME: a public hosted zone in this
# account, the test subdomain the front door's `appDomain` goes under. The
# application domain is `<prefix in lower case>.<zone name>`, one per run
# prefix. INTEG_DEPLOY_CONCURRENCY (default 2) bounds the CDK's parallel
# stack deploys: API Gateway's control plane answers a deploy that runs
# more of them with 429 (six REST APIs at concurrency 6 failed in the
# runtime-isolation integration test; two worked).
#
# Needs the tenant-identity shared-pool deployment's published parameters in
# this Region, or in STRESS_FD_IDENTITY_REGION when it is another one. Prints one `stack=<name> deploy_seconds=<n>` line per stack.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${STRESS_FD_ZONE_ID:?set STRESS_FD_ZONE_ID to the hosted zone id of the test subdomain}"
: "${STRESS_FD_ZONE_NAME:?set STRESS_FD_ZONE_NAME to the name of that hosted zone}"
for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: ${tool}"
done

APP_DOMAIN="${PREFIX_LOWER}.${STRESS_FD_ZONE_NAME}"
mkdir -p -m 700 "$STATE_DIR"
# A new deploy starts the list of what teardown must check afresh.
rm -f "$RESOURCES"
cd "$SAMPLE_DIR"
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "deploy: account ${ACCOUNT}, ${AWS_REGION} (edge in ${EDGE_REGION}, identity in ${IDENTITY_REGION}), prefix ${PREFIX}, application domain ${APP_DOMAIN}"

# One front door per account and Region: the edge parameter has a fixed name (spec §6.4).
if ! stack_exists "$STACK_MAIN" && aws ssm get-parameter --name "$PARAM_EDGE" >/dev/null 2>&1; then
  fail "another front door holds ${PARAM_EDGE} in this account and ${AWS_REGION}: one front door per account and Region (spec §6.4); remove it or use another Region"
fi
# A rerun after a failed deploy reuses the stacks of this prefix that are already there.

IDENTITY_API="$(param "$IDENTITY_PREFIX/apiUrl" "$IDENTITY_REGION")" || fail "tenant-identity is not published in ${IDENTITY_REGION} (${IDENTITY_PREFIX}/apiUrl)"
APP_CLIENT_ID="$(param "$IDENTITY_PREFIX/appClientId" "$IDENTITY_REGION")"
USER_POOL_ID="$(param "$IDENTITY_PREFIX/userPoolId" "$IDENTITY_REGION")"
ISSUER="https://cognito-idp.${IDENTITY_REGION}.amazonaws.com/${USER_POOL_ID}"

# deploy STACK APP_KIND (smoke|fd): one CDK deploy of one stack, timed.
deploy_stack() {
  local stack="$1" kind="$2" start=$SECONDS secs
  echo "== deploy ${stack}"
  if [[ "$kind" == smoke ]]; then
    smoke_context_args
    npx cdk deploy "$stack" --exclusively --app "$SMOKE_APP" --output "${STATE_DIR}/cdk.out.smoke" "${SMOKE_CONTEXT[@]}" \
      --require-approval never --concurrency "$CONCURRENCY" >"${LOGS}/${stack}.log" 2>&1 || { tail -40 "${LOGS}/${stack}.log" >&2; fail "deploy ${stack}"; }
  else
    fd_context_args
    npx cdk deploy "$(fd_selector "$stack")" --exclusively --output "${STATE_DIR}/cdk.out.fd" "${FD_CONTEXT[@]}" \
      --require-approval never --concurrency "$CONCURRENCY" >"${LOGS}/${stack}.log" 2>&1 || { tail -40 "${LOGS}/${stack}.log" >&2; fail "deploy ${stack}"; }
  fi
  secs=$((SECONDS - start))
  echo "stack=${stack} deploy_seconds=${secs}"
  echo "$(date -u +%F) stack=${stack} deploy_seconds=${secs}" >>"$TIMINGS"
}

total_start=$SECONDS

# 1. The two callers of the registrar and the stand-in control plane.
jq -n --arg p "$PREFIX" --arg f "$FLEET" '{stackNamePrefix: $p, fleet: $f}' >"$CONTEXT"
chmod 600 "$CONTEXT"
deploy_stack "$STACK_SUPPORT" smoke
deploy_stack "$STACK_CP" smoke
OPERATOR_ROLE="$(stack_output "$STACK_SUPPORT" EdgeOperatorRoleArn)"
HOOK_ROLE="$(stack_output "$STACK_SUPPORT" GlobalHookRoleArn)"
CP_API="$(stack_output "$STACK_CP" ApiUrl)"
CP_TOKEN_URL="$(stack_output "$STACK_CP" TokenUrl)"
CP_CLIENT="$(stack_output "$STACK_CP" ClientId)"
CP_SECRET="$(stack_output "$STACK_CP" ClientSecretArn)"
CONTROL_PLANE="$(jq -nc --arg u "$CP_API" --arg a "$ACCOUNT" --arg r "$AWS_REGION" --arg t "$CP_TOKEN_URL" --arg c "$CP_CLIENT" --arg s "$CP_SECRET" \
  '{apiUrl: $u, accountId: $a, region: $r, vendorIdp: {tokenUrl: $t, clientId: $c, clientSecretArn: $s}}')"
FIXTURE_TABLE="$(stack_output "$STACK_CP" FixtureTable)"

# 2. The front door: edge (certificate, web ACL), main (distribution, router, route table, registrar), edge logging.
jq -n --arg d "$APP_DOMAIN" --arg zi "$STRESS_FD_ZONE_ID" --arg zn "$STRESS_FD_ZONE_NAME" --arg app "$APPLICATION_ID" --arg f "$FLEET" --arg p "$PREFIX" \
  --arg op "$OPERATOR_ROLE" --arg ac "$APP_CLIENT_ID" --argjson cp "$CONTROL_PLANE" --arg ci "$ISSUER" --arg ca "$APP_CLIENT_ID" \
  '{appDomain: $d, hostedZone: {zoneId: $zi, zoneName: $zn}, applicationId: $app, controlPlane: $cp, dedicatedDomains: "false", fleet: $f,
    edgeOperatorRoleArn: $op, issuer: {clientId: $ac, scopes: "openid", authorizeEndpoint: "https://issuer.example.com/oauth2/authorize",
    tokenEndpoint: "https://issuer.example.com/oauth2/token", logoutEndpoint: "https://issuer.example.com/logout"}, stackNamePrefix: $p,
    cellIssuer: $ci, cellClientId: $ca}' >"$CONTEXT"
deploy_stack "$STACK_EDGE" fd
deploy_stack "$STACK_MAIN" fd
deploy_stack "$STACK_LOGGING" fd

EDGE_PARAM="$(param "$PARAM_EDGE")"
DISTRIBUTION_ARN="$(present "distributionArn of ${PARAM_EDGE}" "$(jq -r .distributionArn <<<"$EDGE_PARAM")")"
REGISTRAR_URL="$(present "registrarUrl of ${PARAM_EDGE}" "$(jq -r .registrarUrl <<<"$EDGE_PARAM")")"
jq --arg d "$DISTRIBUTION_ARN" '. + {distributionArn: $d}' "$CONTEXT" >"${CONTEXT}.new"
mv "${CONTEXT}.new" "$CONTEXT"
chmod 600 "$CONTEXT"

# 3. The demo cell, granted to the distribution.
deploy_stack "$STACK_CELL" smoke

# 4. What the driver reads.
CELL_API="$(stack_output "$STACK_CELL" ApiDomain)"
CELL_URL="$(stack_output "$STACK_CELL" FunctionUrl)"
CELL_LOGS="$(resource "$STACK_CELL" AWS::Logs::LogGroup)"
EDGE_LOGS="$(resource "$STACK_LOGGING" AWS::Logs::LogGroup)"
ROUTER="$(resource "$STACK_MAIN" AWS::CloudFront::Function)"
jq -n \
  --arg region "$AWS_REGION" --arg edgeRegion "$EDGE_REGION" --arg account "$ACCOUNT" --arg domain "$APP_DOMAIN" --arg app "$APPLICATION_ID" \
  --arg registrar "$REGISTRAR_URL" --arg cell "$CELL_ID" --arg cellApi "$CELL_API" --arg cellUrl "$CELL_URL" \
  --arg cellLogs "$CELL_LOGS" --arg edgeLogs "$EDGE_LOGS" \
  --arg router "$ROUTER" --arg table "$FIXTURE_TABLE" --arg op "$OPERATOR_ROLE" --arg hook "$HOOK_ROLE" \
  --arg idApi "$IDENTITY_API" --arg idClient "$APP_CLIENT_ID" \
  '{region: $region, edgeRegion: $edgeRegion, accountId: $account, appDomain: $domain, applicationId: $app, registrarUrl: $registrar, cellId: $cell,
    cellApiDomain: $cellApi, cellFunctionUrl: $cellUrl, cellLogGroup: $cellLogs, edgeLogGroup: $edgeLogs, routerFunction: $router, fixtureTable: $table,
    operatorRoleArn: $op, hookRoleArn: $hook, identityApiUrl: $idApi, identityAppClientId: $idClient}' >"$OUTPUTS"
chmod 600 "$OUTPUTS"
echo "deploy: 6 stacks in $((SECONDS - total_start)) s; outputs in ${OUTPUTS}"
