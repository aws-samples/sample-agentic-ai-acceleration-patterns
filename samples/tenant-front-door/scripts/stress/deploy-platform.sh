#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress slice, `deploy` in platform mode: front-door phase one (stress spec
# §3.5, stress ADR-0016) against the real control plane the `control-plane`
# slice deployed. In order, each stack timed:
#
#   1. the support stack, with only the edge operator role the registrar admits
#      (no stand-in global hook role: the control plane owns `<fleet>-global-hook`)
#   2. the edge, main and edge-logging stacks, `agentIngress` unset, so the edge
#      refuses `/agents/*` until phase two (`slice.sh step phase-two`)
#   3. the same app again with `registrarUrl`, which adds the RouteHookAccess
#      stack (front-door ADR-0027) in the control plane's account and Region
#
# and then writes `tenant-front-door.json` (phase 1) for the control-plane slice
# (hook policy ARN for `globalHookManagedPolicyArns`) and the slices that call
# the edge, and the slice's own `outputs.json`.
#
# Inputs (environment): AWS_REGION, STRESS_PREFIX, STRESS_HOME from the runner;
# STRESS_FD_ZONE_ID and STRESS_FD_ZONE_NAME as in slice mode (the application
# domain is `<prefix in lower case>.<zone name>`). Reads `identity.json` (tenant-identity slice) and
# `control-plane-connection.json` (control-plane slice) from
# $STRESS_HOME/$STRESS_PREFIX/; each missing field is named with the slice that
# writes it. The prefix is used in one mode only: slice mode and platform mode
# both name their support stack `<prefix>-support`.
#
# A rerun after a failed deploy reuses the stacks already there. Prints one
# `stack=<name> deploy_seconds=<n>` line per stack, ids and seconds only.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${STRESS_FD_ZONE_ID:?set STRESS_FD_ZONE_ID to the hosted zone id of the test subdomain}"
: "${STRESS_FD_ZONE_NAME:?set STRESS_FD_ZONE_NAME to the name of that hosted zone}"
for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: ${tool}"
done

IDENTITY_MANIFEST="${MANIFEST_DIR}/identity.json"
CONNECTION="${MANIFEST_DIR}/control-plane-connection.json"
APP_DOMAIN="${PREFIX_LOWER}.${STRESS_FD_ZONE_NAME}"
mkdir -p -m 700 "$STATE_DIR"
rm -f "$RESOURCES"
cd "$SAMPLE_DIR"
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

# What the other slices wrote. A field that is missing stops the deploy before it creates a stack.
IDENTITY_API="$(manifest_field "$IDENTITY_MANIFEST" tenant-identity .apiUrl)"
APP_CLIENT_ID="$(manifest_field "$IDENTITY_MANIFEST" tenant-identity .appClientId)"
CP_REGION="$(manifest_field "$CONNECTION" control-plane .region)"
CP_ACCOUNT="$(manifest_field "$CONNECTION" control-plane .accountId)"
FLEET="$(manifest_field "$CONNECTION" control-plane .fleet)"
APPLICATION_ID="$(manifest_field "$CONNECTION" control-plane .applicationId)"
CP_API="$(manifest_field "$CONNECTION" control-plane .apiUrl)"
CP_TOKEN_URL="$(manifest_field "$CONNECTION" control-plane .vendorIdp.tokenUrl)"
CP_CLIENT="$(manifest_field "$CONNECTION" control-plane .vendorIdp.clientId)"
CP_SECRET="$(manifest_field "$CONNECTION" control-plane .vendorIdp.clientSecretArn)"

# The registrar, the control plane and the hook stack share one Region and one account (front-door spec §3.1).
[[ "$CP_REGION" == "$AWS_REGION" ]] || fail "AWS_REGION is ${AWS_REGION} but ${CONNECTION} names the control plane's Region ${CP_REGION}: the front door deploys in the control plane's Region"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" == "$CP_ACCOUNT" ]] || fail "these credentials are for account ${ACCOUNT}, but ${CONNECTION} names the control plane's account ${CP_ACCOUNT}: the front door and the control plane run in the platform account"
echo "deploy (platform): account ${ACCOUNT}, ${AWS_REGION} (edge in ${EDGE_REGION}), prefix ${PREFIX}, application domain ${APP_DOMAIN}, application ${APPLICATION_ID}, fleet ${FLEET}"

# One front door per account and Region: the edge parameter has a fixed name (spec §6.4).
if ! stack_exists "$STACK_MAIN" && aws ssm get-parameter --name "$PARAM_EDGE" >/dev/null 2>&1; then
  fail "another front door holds ${PARAM_EDGE} in this account and ${AWS_REGION}: one front door per account and Region (spec §6.4); remove it or use another Region"
fi

total_start=$SECONDS

# 1. The edge operator role, alone. A fresh context.json first: smoke_context_args and the teardown read it.
jq -n --arg p "$PREFIX" --arg f "$FLEET" '{stackNamePrefix: $p, fleet: $f}' | json_private "$CONTEXT"
deploy_stack "$STACK_SUPPORT" smoke
OPERATOR_ROLE="$(stack_output "$STACK_SUPPORT" EdgeOperatorRoleArn)"

# 2. The front door: edge (certificate, web ACL), main (distribution, router, route table, registrar), edge logging.
CONTROL_PLANE="$(jq -nc --arg u "$CP_API" --arg a "$CP_ACCOUNT" --arg r "$CP_REGION" --arg t "$CP_TOKEN_URL" --arg c "$CP_CLIENT" --arg s "$CP_SECRET" \
  '{apiUrl: $u, accountId: $a, region: $r, vendorIdp: {tokenUrl: $t, clientId: $c, clientSecretArn: $s}}')"
jq -n --arg d "$APP_DOMAIN" --arg zi "$STRESS_FD_ZONE_ID" --arg zn "$STRESS_FD_ZONE_NAME" --arg app "$APPLICATION_ID" --arg f "$FLEET" --arg p "$PREFIX" \
  --arg op "$OPERATOR_ROLE" --arg ac "$APP_CLIENT_ID" --argjson cp "$CONTROL_PLANE" \
  '{appDomain: $d, hostedZone: {zoneId: $zi, zoneName: $zn}, applicationId: $app, controlPlane: $cp, dedicatedDomains: "false", fleet: $f,
    edgeOperatorRoleArn: $op, issuer: {clientId: $ac, scopes: "openid", authorizeEndpoint: "https://issuer.example.com/oauth2/authorize",
    tokenEndpoint: "https://issuer.example.com/oauth2/token", logoutEndpoint: "https://issuer.example.com/logout"}, stackNamePrefix: $p}' | json_private "$CONTEXT"
deploy_stack "$STACK_EDGE" fd
deploy_stack "$STACK_MAIN" fd
deploy_stack "$STACK_LOGGING" fd

EDGE_PARAM="$(param "$PARAM_EDGE")"
DISTRIBUTION_ARN="$(present "distributionArn of ${PARAM_EDGE}" "$(jq -r .distributionArn <<<"$EDGE_PARAM")")"
REGISTRAR_URL="$(present "registrarUrl of ${PARAM_EDGE}" "$(jq -r .registrarUrl <<<"$EDGE_PARAM")")"

# 3. The same app with `registrarUrl`: RouteHookAccess, the hook parameter and the hook policy.
jq --arg r "$REGISTRAR_URL" '. + {registrarUrl: $r}' "$CONTEXT" | json_private "$CONTEXT"
deploy_stack "$STACK_HOOK" fd
HOOK_POLICY="$(stack_output "$STACK_HOOK" RouteHookPolicyArn)"

# 4. What the other slices and the driver read.
EDGE_LOGS="$(resource "$STACK_LOGGING" AWS::Logs::LogGroup)"
ROUTER="$(resource "$STACK_MAIN" AWS::CloudFront::Function)"
jq -n --arg e "https://${APP_DOMAIN}" --arg r "$REGISTRAR_URL" --arg d "$APP_DOMAIN" --arg a "$DISTRIBUTION_ARN" --arg h "$HOOK_POLICY" --arg o "$OPERATOR_ROLE" \
  '{edgeUrl: $e, registrarUrl: $r, agentBackend: "default", appDomain: $d, distributionArn: $a, hookPolicyArn: $h, operatorRoleArn: $o, phase: 1}' | json_private "$FD_MANIFEST"
jq -n \
  --arg region "$AWS_REGION" --arg edgeRegion "$EDGE_REGION" --arg account "$ACCOUNT" --arg domain "$APP_DOMAIN" --arg app "$APPLICATION_ID" \
  --arg registrar "$REGISTRAR_URL" --arg edgeLogs "$EDGE_LOGS" --arg router "$ROUTER" --arg op "$OPERATOR_ROLE" \
  --arg idApi "$IDENTITY_API" --arg idClient "$APP_CLIENT_ID" \
  '{region: $region, edgeRegion: $edgeRegion, accountId: $account, appDomain: $domain, applicationId: $app, registrarUrl: $registrar,
    edgeLogGroup: $edgeLogs, routerFunction: $router, operatorRoleArn: $op, identityApiUrl: $idApi, identityAppClientId: $idClient}' | json_private "$OUTPUTS"
echo "deploy (platform): 5 stacks in $((SECONDS - total_start)) s; manifest ${FD_MANIFEST} (phase 1), outputs in ${OUTPUTS}"
