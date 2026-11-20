#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step 24 and the ordered teardown of spec §6.2, sourced by
# scripts/integ.sh. It runs from the EXIT trap whether the steps passed,
# failed or stopped, and again by hand with `scripts/integ.sh teardown
# <run id>`: every part reads the run's state (state.env, the stacks'
# outputs) and skips what is already gone, and a failed part does not stop
# the ones after it. The tenant-identity shared pool is never touched.

TEARDOWN_FAILS=0
try() { # LABEL CMD...: one teardown part; a failure is counted and the teardown goes on
  local label="$1"
  shift
  if "$@"; then note "teardown: ${label}: done"; else TEARDOWN_FAILS=$((TEARDOWN_FAILS + 1)); note "teardown: ${label}: FAILED"; fi
}
stack_exists() { aws cloudformation describe-stacks --region "${2:-$REGION}" --stack-name "$1" >/dev/null 2>&1; }
cp_stack_exists() { in_cp aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" >/dev/null 2>&1; }

# The run's values that later parts need, from whatever is still deployed.
teardown_read() {
  if stack_exists "$S_SUPPORT"; then read_phase_1 2>/dev/null || true; fi
  [[ -n "${OPERATOR_PASSWORD:-}" || -z "${VENDOR_POOL:-}" ]] || set_operator_password
  if cp_stack_exists "$S_CP"; then read_phase_2 2>/dev/null || true; fi
  if stack_exists "$S_MAIN"; then read_phase_3 2>/dev/null || true; fi
  if stack_exists "$S_TEST_ROLE"; then TEST_ROLE="$(stack_out "$S_TEST_ROLE" TestRoleArn)"; fi
  HOOK_PARAMETER="/application-plane/applications/${APP}/shared/front-door-hook"
}
cp_up() { [[ -n "${CP_API:-}" && -n "${VENDOR_POOL:-}" ]]; }

# Before the control plane deletes anything: the hook parameter back to the
# registrar (step 22 breaks it), the probe hook gone (step 20).
restore_parameter_part() {
  [[ "${HOOK_PARAMETER_BROKEN:-no}" == yes && -n "${REGISTRAR:-}" ]] || return 0
  in_cp aws ssm put-parameter --region "$REGION" --name "$HOOK_PARAMETER" --overwrite --type String --value "$(jq -nc \
    --arg u "$REGISTRAR" --arg d "$APP_DOMAIN" --arg m "$MODE" '{version: 1, registrarUrl: $u, appDomain: $d, addressing: $m}')" >/dev/null \
    && state_set HOOK_PARAMETER_BROKEN no
}
probe_hook_part() {
  [[ "${PROBE_HOOK:-no}" == yes ]] && cp_up || return 0
  [[ "$(api DELETE hooks/tfd-probe)" =~ ^(200|404)$ ]] && state_set PROBE_HOOK no
}
# Step 14's TXT records, read from the zone with the driver's credentials.
txt_part() {
  local name="_tfd-challenge.${DD}." set
  set="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --start-record-name "$name" --start-record-type TXT \
    --max-items 1 --query "ResourceRecordSets[?Name=='${name}' && Type=='TXT'] | [0]" --output json)" || return 1
  [[ "$set" == null ]] && return 0
  [[ -n "${TEST_ROLE:-}" ]] || return 1
  as_test aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "$(jq -nc --argjson s "$set" '{Changes: [{Action: "DELETE", ResourceRecordSet: $s}]}')" >/dev/null
}
fixture_part() {
  [[ "${FIXTURE_WRITTEN:-no}" == yes && -n "${TEST_ROLE:-}" && -n "${KVS:-}" ]] || return 0
  edge_tool host-delete "$KVS" dedicated-a.example.com >/dev/null && state_set FIXTURE_WRITTEN no
}

# §6.2 (1): every deployment, then every cell, of both applications, through the control plane.
records_part() {
  cp_up || return 0
  local app id rc=0
  for app in "$APP" "$PLAIN_APP"; do
    api GET "deployments?applicationId=${app}" >/dev/null
    for id in $(jq -r '.deployments[]?.tenantId' "$BODY"); do
      api DELETE "$(deployment_path "$id" "$app")" >/dev/null
    done
    for id in $(jq -r '.deployments[]?.tenantId' "$BODY"); do
      api_gone "$(deployment_path "$id" "$app")" 2400 || { note "deployment ${id}/${app} not gone"; rc=1; }
    done
  done
  for app in "$APP" "$PLAIN_APP"; do
    api GET "cells?applicationId=${app}" >/dev/null
    for id in $(jq -r '.cells[]?.cellId' "$BODY"); do
      api DELETE "cells/${id}" >/dev/null
      api_gone "cells/${id}" 2400 || { note "cell ${id} not gone"; rc=1; }
    done
  done
  return $rc
}
# §6.2 (2): the two global hooks; this is the control plane's only front door.
hooks_part() {
  cp_up || return 0
  api_token
  CONTROL_PLANE_URL="$CP_API" CONTROL_PLANE_TOKEN="$CP_TOKEN" bash scripts/register-hooks.sh --delete
}
# §6.2 (3): the policy out of globalHookManagedPolicyArns, and an update of the control plane.
control_plane_policy_part() {
  cp_stack_exists "$S_CP" || return 0
  deploy_control_plane control-plane-unhook
}
# §6.2 (4), (5): RouteHookAccess, which keeps its parameter, then the parameter.
route_hook_access_part() { cp_stack_exists "$S_RHA" || return 0; destroy_one FrontDoor/RouteHookAccess route-hook-access; }
hook_parameter_part() {
  cp_stack_exists "$S_CP_SETUP" || return 0
  in_cp aws ssm delete-parameter --region "$REGION" --name "$HOOK_PARAMETER" >/dev/null 2>&1 || true
}
# §6.2 (6) and the test's own stacks.
edge_stacks_part() {
  local rc=0
  stack_exists "$S_TEST_ROLE" && { destroy_one "$S_TEST_ROLE" test-role || rc=1; }
  cp_stack_exists "$S_CELL_A" && { destroy_one "$S_CELL_A" cell-a || rc=1; }
  stack_exists "$S_CELL_B" && { destroy_one "$S_CELL_B" cell-b || rc=1; }
  stack_exists "$S_EDGE_LOGGING" us-east-1 && { destroy_one FrontDoor/EdgeLogging edge-logging || rc=1; }
  stack_exists "$S_MAIN" && { destroy_one FrontDoor/Main main || rc=1; }
  stack_exists "$S_EDGE" us-east-1 && { destroy_one FrontDoor/Edge edge || rc=1; }
  stack_exists "$S_INGRESS" && { destroy_one "$S_INGRESS" agent-ingress || rc=1; }
  return $rc
}
# The control plane's records, then the tenants in tenant-identity.
cp_records_part() {
  cp_up || return 0
  local id rc=0 app account
  for id in "${TENANT_A:-}" "${TENANT_B:-}" "${TENANT_C:-}"; do
    [[ -n "$id" ]] || continue
    api DELETE "tenants/${id}" >/dev/null
    api_gone "tenants/${id}" 600 || rc=1
  done
  for app in "$APP" "$PLAIN_APP"; do
    api DELETE "applications/${app}" >/dev/null
    api_gone "applications/${app}" 600 || rc=1
  done
  for account in "$EDGE_ACCOUNT" "$CP_ACCOUNT"; do
    api DELETE "accounts/${account}" >/dev/null
    api_gone "accounts/${account}" 600 || rc=1
  done
  return $rc
}
identity_part() {
  local id
  for id in "${TENANT_A:-}" "${TENANT_B:-}" "${TENANT_C:-}" "${TENANT_U:-}"; do
    [[ -n "$id" ]] && ti_delete "$IDENTITY_API" "$id"
  done
  [[ -n "${MT_TENANT:-}" && -n "${MT_API:-}" ]] && ti_delete "$MT_API" "$MT_TENANT"
  return 0
}
control_plane_part() {
  local p1="" p2="" rc=0
  if cp_stack_exists "$S_CP"; then
    timed destroy control-plane cp_cdk destroy-control-plane "$CP_ACCOUNT" destroy "$S_CP" --force \
      --context "stackName=$S_CP" --context "fleetName=$FLEET" \
      --context "vendorIdpIssuerUrl=$VENDOR_ISSUER" --context "vendorIdpAudience=$VENDOR_OPERATOR_CLIENT" &
    p1=$!
  fi
  if stack_exists "$S_CELL_ACCOUNT"; then
    timed destroy cell-account cp_cdk destroy-cell-account "$EDGE_ACCOUNT" destroy "$S_CELL_ACCOUNT" --force \
      --context "fleetName=$FLEET" --context "cellAccount=$(jq -nc --arg cp "$CP_ACCOUNT" '{controlPlaneAccountId: $cp}')" &
    p2=$!
  fi
  [[ -z "$p1" ]] || wait "$p1" || rc=1
  [[ -z "$p2" ]] || wait "$p2" || rc=1
  return $rc
}
setup_part() {
  local rc=0
  cp_stack_exists "$S_CP_SETUP" && { destroy_one "$S_CP_SETUP" cp-setup || rc=1; }
  stack_exists "$S_SUPPORT" && { destroy_one "$S_SUPPORT" support || rc=1; }
  return $rc
}

teardown() {
  section "24. remove the fixture, then the ordered teardown (spec §6.2)"
  teardown_read
  try "hook parameter restored" restore_parameter_part
  try "probe hook" probe_hook_part
  try "step 14 TXT records" txt_part
  try "step 2 fixture key" fixture_part
  try "(1) deployments and cells through the control plane" records_part
  try "(2) register-hooks.sh --delete" hooks_part
  try "(3) RouteHookAccess policy out of the control plane" control_plane_policy_part
  try "(4) RouteHookAccess stack" route_hook_access_part
  try "(5) hook parameter" hook_parameter_part
  try "(6) front door, cells, test role, agent ingress" edge_stacks_part
  try "control plane records" cp_records_part
  try "tenant-identity tenants" identity_part
  try "control plane and the edge account's role pair" control_plane_part
  try "leftovers in the control plane's account" leftovers_cp
  try "control plane setup and support stacks" setup_part
  try "leftovers in the edge account" leftovers_edge
  check "teardown parts" 0 "$TEARDOWN_FAILS"
}

# -- Leftover check ----------------------------------------------------------------------
LEFT=0
left() { LEFT=$((LEFT + 1)); note "LEFTOVER $*"; }
leftovers_cp() {
  cp_stack_exists "$S_CP_SETUP" || { note "the control plane setup stack is gone: its account's leftovers cannot be read (check by hand)"; return 1; }
  local s name id
  for s in "$S_CP" "$S_RHA" "$S_CELL_A"; do cp_stack_exists "$s" && left "stack $s (control plane's account)"; done
  in_cp aws ssm get-parameter --region "$REGION" --name "$HOOK_PARAMETER" >/dev/null 2>&1 && left "hook parameter $HOOK_PARAMETER"
  in_cp aws iam get-policy --policy-arn "arn:aws:iam::${CP_ACCOUNT}:policy/tenant-front-door-route-hook-${APP}" >/dev/null 2>&1 \
    && left "policy tenant-front-door-route-hook-${APP}"
  for name in api cell-build tenant-build global-hook app-hook cell-provisioning tenant-provisioning; do
    in_cp aws iam get-role --role-name "${FLEET}-${name}" >/dev/null 2>&1 && left "role ${FLEET}-${name} (control plane's account)"
  done
  for id in "${TENANT_A:-}" "${TENANT_C:-}"; do
    [[ -n "$id" ]] || continue
    [[ "$(in_cp aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/tenants/${id}" --recursive --query 'length(Parameters)' --output text)" == 0 ]] \
      || left "parameters under /application-plane/tenants/${id} (control plane's account)"
  done
  for id in "${CELL_A:-}" "${PLAIN_CELL:-}"; do
    [[ -n "$id" ]] || continue
    [[ "$(in_cp aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/cells/${id}" --recursive --query 'length(Parameters)' --output text)" == 0 ]] \
      || left "parameters under /application-plane/cells/${id} (control plane's account)"
  done
  note "expected harness leftovers (default Lambda log groups): $(in_cp aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "/aws/lambda/${PREFIX}" --query 'logGroups[].logGroupName' --output text 2>/dev/null | wc -w) in the control plane's account"
  (( LEFT == 0 ))
}
leftovers_edge() {
  local before=$LEFT r s name id arn
  for r in "$REGION" us-east-1; do
    for s in $(aws cloudformation list-stacks --region "$r" --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" --output text); do
      [[ "$s" == "$PREFIX"-* || "$s" == "$FLEET"-* ]] && left "stack $s ($r)"
    done
  done
  for name in "$R_EDGE_OPERATOR" "$R_TEST" "$R_STRANGER" "${FLEET}-cell-provisioning" "${FLEET}-tenant-provisioning"; do
    aws iam get-role --role-name "$name" >/dev/null 2>&1 && left "role $name"
  done
  aws iam get-policy --policy-arn "arn:aws:iam::${EDGE_ACCOUNT}:policy/${PAIR_PROBE_POLICY}" >/dev/null 2>&1 && left "policy ${PAIR_PROBE_POLICY}"
  for id in "${TENANT_B:-}"; do
    [[ -n "$id" ]] || continue
    [[ "$(aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/tenants/${id}" --recursive --query 'length(Parameters)' --output text)" == 0 ]] \
      || left "parameters under /application-plane/tenants/${id}"
  done
  if [[ -n "${CELL_B:-}" ]]; then
    [[ "$(aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/cells/${CELL_B}" --recursive --query 'length(Parameters)' --output text)" == 0 ]] \
      || left "parameters under /application-plane/cells/${CELL_B}"
  fi
  aws ssm get-parameter --region "$REGION" --name /application-plane/shared/front-door/edge >/dev/null 2>&1 && left "the edge parameter"
  for name in "$DD" "probe.${DD}"; do
    for arn in $(aws acm list-certificates --region us-east-1 --includes 'keyTypes=RSA_2048,EC_prime256v1,EC_secp384r1' \
        --query "CertificateSummaryList[?DomainName=='${name}'].CertificateArn" --output text); do
      left "certificate for ${name}: ${arn##*/}"
    done
  done
  [[ "$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --start-record-name "_tfd-challenge.${DD}." --start-record-type TXT \
    --max-items 1 --query "length(ResourceRecordSets[?Name=='_tfd-challenge.${DD}.'])" --output text)" == 0 ]] || left "TXT records at _tfd-challenge.${DD}"
  note "expected harness leftovers (default Lambda log groups): $(aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "/aws/lambda/${PREFIX}" --query 'logGroups[].logGroupName' --output text 2>/dev/null | wc -w) in the edge account"
  (( LEFT == before ))
}
