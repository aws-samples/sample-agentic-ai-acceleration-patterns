#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step 24 and the ordered teardown of spec §6.2, sourced by
# scripts/integ.sh. It runs from the EXIT trap whether the steps passed,
# failed or stopped, and again by hand with `scripts/integ.sh teardown
# <run id> <mode>`. Every part reads the run's state (state.env, the
# stacks' outputs) and ends in one of three ways:
#
#   done     it removed something
#   skipped  there was nothing to remove: the AWS answer said "does not
#            exist", or the run's state says the thing was never made
#   FAILED   it could not act, or could not tell whether there was
#            anything to remove (any other AWS error counts here)
#
# A failed part does not stop the ones after it, and a rerun picks up what
# is left. The tenant-identity shared pool is only read, except for
# DeleteTenant on this run's own tenants.

TEARDOWN_FAILS=0
CP_PART_FAILS=0
# try LABEL CMD...: one teardown part (0 done, 3 skipped, anything else FAILED).
try() {
  local label="$1" rc=0
  shift
  "$@" || rc=$?
  case "$rc" in
    0) note "teardown: ${label}: done" ;;
    3) note "teardown: ${label}: skipped" ;;
    *) TEARDOWN_FAILS=$((TEARDOWN_FAILS + 1)); note "teardown: ${label}: FAILED" ;;
  esac
  return 0
}
# try_cp LABEL CMD...: a part in, or for, the control plane's account. A
# failure here keeps the setup and support stacks (setup_part), because a
# rerun needs the driver's access role and the vendor IdP they hold.
try_cp() {
  local before=$TEARDOWN_FAILS
  try "$@"
  (( TEARDOWN_FAILS == before )) || CP_PART_FAILS=$((CP_PART_FAILS + 1))
  return 0
}
# part_rc FAILED ACTED: a part's result from its two flags.
part_rc() { (( $1 == 0 )) || return 1; (( $2 == 0 )) && return 3; return 0; }
clip() { tr -cd '[:print:]' | head -c 200; }
# marker NAME: a yes/no state marker. Unset means "no" in a run whose state
# records its deploy phase, and "yes" (the safe guess) in an older one.
marker() {
  local v="${!1:-}"
  [[ -n "$v" ]] || { if [[ -n "${DEPLOY_PHASE:-}" ]]; then v=no; else v=yes; fi; }
  echo "$v"
}

# -- Existence -------------------------------------------------------------------------
# stack_state STACK [REGION] [cp]: 0 the stack exists, 1 CloudFormation says
# it does not exist, 2 any other error (no credentials, access denied,
# throttling), which the caller counts as a failure.
stack_state() {
  local err runner=()
  [[ "${3:-}" == cp ]] && runner=(in_cp)
  if err="$("${runner[@]}" aws cloudformation describe-stacks --region "${2:-$REGION}" --stack-name "$1" \
      --query 'Stacks[0].StackStatus' --output text 2>&1 >/dev/null)"; then
    return 0
  fi
  [[ "$err" == *"does not exist"* ]] && return 1
  note "cannot tell whether stack $1 exists: $(clip <<<"$err")"
  return 2
}

# The control plane's account is seen through the driver's access role in
# the setup stack. CP_REACH: yes, no (the role cannot be assumed) or gone
# (the setup stack was removed by an earlier teardown, after a clean check).
CP_REACH=unknown
CP_ACCESS_WHY=""
# cp_access: 0 the account can be read, 3 nothing of the run can be there,
# 1 the driver cannot see it.
cp_access() {
  case "$CP_REACH" in
    yes) return 0 ;;
    gone) CP_ACCESS_WHY="${S_CP_SETUP} was removed after a clean leftover check"; return 3 ;;
  esac
  if (( ${DEPLOY_PHASE:-9} < 2 )); then
    CP_ACCESS_WHY="${R_CP_ACCESS} cannot be assumed and deploy phase 2 never started, so only ${S_CP_SETUP} can be there"
    return 3
  fi
  CP_ACCESS_WHY="${R_CP_ACCESS} cannot be assumed"
  return 1
}
cp_stack_state() { # STACK: as stack_state, in the control plane's account
  local rc=0
  cp_access || rc=$?
  case "$rc" in
    0) stack_state "$1" "$REGION" cp ;;
    3) if [[ "$1" == "$S_CP_SETUP" && "$CP_REACH" != gone ]]; then
         note "cannot tell whether $1 exists: ${CP_ACCESS_WHY}"; return 2
       fi
       return 1 ;;
    *) note "cannot tell whether $1 exists: ${CP_ACCESS_WHY}"; return 2 ;;
  esac
}
# destroy_if SELECTOR LABEL STACK REGION edge|cp: 0 destroyed, 3 not there, 1 failed or cannot tell.
destroy_if() {
  local n=0
  if [[ "$5" == cp ]]; then cp_stack_state "$3" || n=$?; else stack_state "$3" "$4" || n=$?; fi
  case "$n" in
    0) destroy_one "$1" "$2" ;;
    1) return 3 ;;
    *) return 1 ;;
  esac
}
# set_state VAR CMD...: VAR holds CMD's exit status.
set_state() { local __v="$1" __rc=0; shift; "$@" || __rc=$?; printf -v "$__v" '%s' "$__rc"; }

# -- Before any part ----------------------------------------------------------------------
# teardown_credentials: the driver's own credentials still work and still
# point at the edge account. Without them every part would fail, so the
# teardown stops and names the command that resumes it.
teardown_credentials() {
  local account
  account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || account=""
  if [[ -z "$account" ]]; then
    FAILS=$((FAILS + 1))
    echo "  FAIL teardown not started: the driver's credentials are gone (sts get-caller-identity failed), so nothing was removed"
    echo "  refresh them, then resume with: scripts/integ.sh teardown ${RUN_ID} ${MODE}"
    return 1
  fi
  if [[ "$account" != "$EDGE_ACCOUNT" ]]; then
    FAILS=$((FAILS + 1))
    echo "  FAIL teardown not started: the credentials now point at account ${account}, not the edge account ${EDGE_ACCOUNT}"
    echo "  switch back, then resume with: scripts/integ.sh teardown ${RUN_ID} ${MODE}"
    return 1
  fi
}

# The run's values that later parts need, from whatever is still deployed.
teardown_read() {
  # Every value a part may read starts empty, so a run that stopped early
  # never trips `set -u` in the middle of its teardown.
  local v
  for v in VENDOR_POOL VENDOR_ISSUER VENDOR_OPERATOR_CLIENT VENDOR_READER_CLIENT VENDOR_READER_SECRET VENDOR_TOKEN_URL \
      EDGE_OPERATOR STRANGER EDGE_PROBE_POLICY AGENT_INGRESS_URL INGRESS_LOG INGRESS_LOG_ARN SOURCE_BUCKET SOURCE_KEY \
      CP_PROBE_POLICY SOURCE_VERSION CP_API REGISTRAR DIST_ARN DIST_ID KVS ROUTER_ARN ROUTER_NAME TEST_ROLE HOOK_POLICY \
      OPERATOR_PASSWORD; do
    [[ -n "${!v+x}" ]] || printf -v "$v" '%s' ''
  done
  HOOK_PARAMETER="/application-plane/applications/${APP}/shared/front-door-hook"
  if [[ "${CP_SETUP_REMOVED:-no}" == yes ]]; then
    CP_REACH=gone
  elif in_cp aws sts get-caller-identity --query Arn --output text >/dev/null 2>"$TMP/read.err"; then
    CP_REACH=yes
  else
    CP_REACH=no
    note "the driver's access role ${R_CP_ACCESS} cannot be assumed: $(clip <"$TMP/read.err")"
  fi
  set_state SUPPORT_STATE stack_state "$S_SUPPORT"
  if [[ "$SUPPORT_STATE" == 0 ]]; then
    read_phase_1 2>"$TMP/read.err" || note "some outputs of phase 1 cannot be read ($(tail -1 "$TMP/read.err" | clip)); the parts that need them fail"
  fi
  if [[ -z "$OPERATOR_PASSWORD" && -n "$VENDOR_POOL" ]]; then
    set_operator_password || note "the operator's password cannot be set in ${VENDOR_POOL}; the parts that call the control plane fail"
  fi
  set_state CP_STATE cp_stack_state "$S_CP"
  if [[ "$CP_STATE" == 0 ]]; then
    read_phase_2 2>"$TMP/read.err" || note "the control plane's API URL cannot be read ($(tail -1 "$TMP/read.err" | clip))"
  fi
  set_state MAIN_STATE stack_state "$S_MAIN"
  if [[ "$MAIN_STATE" == 0 ]]; then
    read_phase_3 2>"$TMP/read.err" || note "some outputs of the main stack cannot be read ($(tail -1 "$TMP/read.err" | clip)); the parts that need them fail"
  fi
  set_state TEST_ROLE_STATE stack_state "$S_TEST_ROLE"
  if [[ "$TEST_ROLE_STATE" == 0 ]]; then
    TEST_ROLE="$(stack_out "$S_TEST_ROLE" TestRoleArn 2>/dev/null)" || TEST_ROLE=""
    [[ "$TEST_ROLE" == arn:* ]] || TEST_ROLE=""
  fi
  return 0
}
# cp_api_ready: 0 the control plane's API can be called, 3 the control plane is gone, 1 it exists but cannot be called.
cp_api_ready() {
  case "$CP_STATE" in
    1) return 3 ;;
    0) ;;
    *) note "cannot tell whether ${S_CP} exists"; return 1 ;;
  esac
  [[ -n "$CP_API" ]] || { note "${S_CP} exists, but its API URL cannot be read"; return 1; }
  [[ -n "$VENDOR_POOL" && -n "$VENDOR_OPERATOR_CLIENT" && -n "$OPERATOR_PASSWORD" ]] \
    || { note "${S_CP} exists, but the vendor IdP in ${S_SUPPORT} cannot be read or its operator's password cannot be set"; return 1; }
  api_token || { note "the operator cannot sign in to the vendor IdP"; return 1; }
}
# api_accepted STATUS: a delete the control plane took, or one it already
# has in hand; api_gone afterwards decides whether the record is gone.
api_accepted() { [[ "$1" =~ ^(200|202|204|404|409)$ ]]; }

# -- The parts, in order -----------------------------------------------------------------
# Before the control plane deletes anything: the hook parameter back to the
# registrar (step 22 breaks it), the probe hook gone (step 20).
restore_parameter_part() {
  [[ "${HOOK_PARAMETER_BROKEN:-no}" == yes ]] || return 3
  local rc=0
  cp_access || rc=$?
  if (( rc == 3 )); then state_set HOOK_PARAMETER_BROKEN no; return 3; fi
  (( rc == 0 )) || { note "the hook parameter is still broken (step 22): ${CP_ACCESS_WHY}"; return 1; }
  local err
  if ! err="$(in_cp aws ssm get-parameter --region "$REGION" --name "$HOOK_PARAMETER" 2>&1 >/dev/null)"; then
    if [[ "$err" == *ParameterNotFound* ]]; then state_set HOOK_PARAMETER_BROKEN no; return 3; fi
    note "the hook parameter cannot be read: $(clip <<<"$err")"
    return 1
  fi
  [[ -n "$REGISTRAR" ]] || {
    note "the hook parameter is still broken (step 22) and the registrar URL cannot be read from the edge parameter;"
    note "every delete below would wait out three front-door-pre attempts"
    return 1
  }
  in_cp aws ssm put-parameter --region "$REGION" --name "$HOOK_PARAMETER" --overwrite --type String --value "$(jq -nc \
    --arg u "$REGISTRAR" --arg d "$APP_DOMAIN" --arg m "$MODE" '{version: 1, registrarUrl: $u, appDomain: $d, addressing: $m}')" >/dev/null \
    || return 1
  state_set HOOK_PARAMETER_BROKEN no
}
probe_hook_part() {
  [[ "${PROBE_HOOK:-no}" == yes ]] || return 3
  local rc=0 st
  cp_api_ready || rc=$?
  if (( rc == 3 )); then state_set PROBE_HOOK no; return 3; fi
  (( rc == 0 )) || return 1
  st="$(api DELETE hooks/tfd-probe)"
  [[ "$st" =~ ^(200|204|404)$ ]] || { note "DeleteHook tfd-probe: HTTP ${st}"; return 1; }
  state_set PROBE_HOOK no
}
# Step 14's TXT records, read from the zone with the driver's credentials.
txt_part() {
  local name="_tfd-challenge.${DD}." set
  set="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --start-record-name "$name" --start-record-type TXT \
    --max-items 1 --query "ResourceRecordSets[?Name=='${name}' && Type=='TXT'] | [0]" --output json)" \
    || { note "the zone's records cannot be read"; return 1; }
  [[ "$set" == null ]] && return 3
  [[ -n "$TEST_ROLE" ]] || { note "TXT records at ${name} stay: the test role cannot be read"; return 1; }
  as_test aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "$(jq -nc --argjson s "$set" '{Changes: [{Action: "DELETE", ResourceRecordSet: $s}]}')" >/dev/null
}
fixture_part() {
  [[ "${FIXTURE_WRITTEN:-no}" == yes ]] || return 3
  if [[ "$MAIN_STATE" == 1 ]]; then state_set FIXTURE_WRITTEN no; return 3; fi
  [[ -n "$TEST_ROLE" && -n "$KVS" ]] || { note "the fixture key stays: the test role or the route table cannot be read"; return 1; }
  edge_tool host-delete "$KVS" dedicated-a.example.com >/dev/null || return 1
  state_set FIXTURE_WRITTEN no
}

# §6.2 (1): every deployment, then every cell, of both applications, through the control plane.
records_part() {
  local rc=0 st app id ids failed=0 acted=0
  cp_api_ready || rc=$?
  (( rc == 0 )) || return "$rc"
  for app in "$APP" "$PLAIN_APP"; do
    st="$(api GET "deployments?applicationId=${app}")"
    [[ "$st" == 200 ]] || { note "ListDeployments ${app}: HTTP ${st}"; failed=1; continue; }
    ids="$(jq -r '.deployments[]?.tenantId' "$BODY")"
    for id in $ids; do
      acted=1
      st="$(api DELETE "$(deployment_path "$id" "$app")")"
      api_accepted "$st" || { note "DeleteDeployment ${id} in ${app}: HTTP ${st}"; failed=1; }
    done
    for id in $ids; do
      api_gone "$(deployment_path "$id" "$app")" 2400 || { note "deployment ${id} in ${app} not gone"; failed=1; }
    done
  done
  for app in "$APP" "$PLAIN_APP"; do
    st="$(api GET "cells?applicationId=${app}")"
    [[ "$st" == 200 ]] || { note "ListCells ${app}: HTTP ${st}"; failed=1; continue; }
    for id in $(jq -r '.cells[]?.cellId' "$BODY"); do
      acted=1
      st="$(api DELETE "cells/${id}")"
      api_accepted "$st" || { note "DeleteCell ${id}: HTTP ${st}"; failed=1; }
      api_gone "cells/${id}" 2400 || { note "cell ${id} not gone"; failed=1; }
    done
  done
  part_rc "$failed" "$acted"
}
# §6.2 (2): the two global hooks; this is the control plane's only front door.
hooks_part() {
  [[ "$(marker HOOKS_REGISTERED)" == yes ]] || return 3
  local rc=0
  cp_api_ready || rc=$?
  if (( rc == 3 )); then state_set HOOKS_REGISTERED no; return 3; fi
  (( rc == 0 )) || return 1
  CONTROL_PLANE_URL="$CP_API" CONTROL_PLANE_TOKEN="$CP_TOKEN" bash scripts/register-hooks.sh --delete || return 1
  state_set HOOKS_REGISTERED no
}
# §6.2 (3): the policy out of globalHookManagedPolicyArns, and an update of the control plane.
control_plane_policy_part() {
  [[ "$(marker HOOK_POLICY_ATTACHED)" == yes ]] || return 3
  case "$CP_STATE" in
    1) state_set HOOK_POLICY_ATTACHED no; return 3 ;;
    0) ;;
    *) return 1 ;;
  esac
  [[ -n "$VENDOR_ISSUER" && -n "$VENDOR_OPERATOR_CLIENT" && -n "$VENDOR_READER_CLIENT" && -n "$CP_PROBE_POLICY" ]] \
    || { note "the control plane update cannot be synthesised: outputs of ${S_SUPPORT} or ${S_CP_SETUP} cannot be read"; return 1; }
  deploy_control_plane control-plane-unhook || return 1
  state_set HOOK_POLICY_ATTACHED no
}
# §6.2 (4), (5): RouteHookAccess, which keeps its parameter, then the parameter.
route_hook_access_part() { destroy_if FrontDoor/RouteHookAccess route-hook-access "$S_RHA" "" cp; }
hook_parameter_part() {
  local rc=0 err
  cp_access || rc=$?
  (( rc == 0 )) || { (( rc == 3 )) || note "the hook parameter: ${CP_ACCESS_WHY}"; return "$rc"; }
  if err="$(in_cp aws ssm delete-parameter --region "$REGION" --name "$HOOK_PARAMETER" 2>&1 >/dev/null)"; then return 0; fi
  [[ "$err" == *ParameterNotFound* ]] && return 3
  note "DeleteParameter ${HOOK_PARAMETER}: $(clip <<<"$err")"
  return 1
}
# §6.2 (6) and the test's own stacks.
edge_stacks_part() {
  local spec sel label stack region where n failed=0 acted=0
  for spec in "${S_TEST_ROLE}|test-role|${S_TEST_ROLE}||edge" "${S_CELL_A}|cell-a|${S_CELL_A}||cp" \
      "${S_CELL_B}|cell-b|${S_CELL_B}||edge" "FrontDoor/EdgeLogging|edge-logging|${S_EDGE_LOGGING}|us-east-1|edge" \
      "FrontDoor/Main|main|${S_MAIN}||edge" "FrontDoor/Edge|edge|${S_EDGE}|us-east-1|edge" \
      "${S_INGRESS}|agent-ingress|${S_INGRESS}||edge"; do
    IFS='|' read -r sel label stack region where <<<"$spec"
    n=0
    destroy_if "$sel" "$label" "$stack" "$region" "$where" || n=$?
    case "$n" in 0) acted=1 ;; 3) ;; *) failed=1 ;; esac
  done
  part_rc "$failed" "$acted"
}
# The control plane's records, then the tenants in tenant-identity.
cp_records_part() {
  local rc=0 st id app account failed=0 acted=0
  cp_api_ready || rc=$?
  (( rc == 0 )) || return "$rc"
  for id in "${TENANT_A:-}" "${TENANT_B:-}" "${TENANT_C:-}"; do
    [[ -n "$id" ]] || continue
    st="$(api DELETE "tenants/${id}")"; api_accepted "$st" || { note "DeleteTenant ${id}: HTTP ${st}"; failed=1; }; [[ "$st" =~ ^2 ]] && acted=1
    api_gone "tenants/${id}" 600 || { note "tenant ${id} not gone"; failed=1; }
  done
  for app in "$APP" "$PLAIN_APP"; do
    st="$(api DELETE "applications/${app}")"; api_accepted "$st" || { note "DeleteApplication ${app}: HTTP ${st}"; failed=1; }; [[ "$st" =~ ^2 ]] && acted=1
    api_gone "applications/${app}" 600 || { note "application ${app} not gone"; failed=1; }
  done
  for account in "$EDGE_ACCOUNT" "$CP_ACCOUNT"; do
    st="$(api DELETE "accounts/${account}")"; api_accepted "$st" || { note "DeleteAccount ${account}: HTTP ${st}"; failed=1; }; [[ "$st" =~ ^2 ]] && acted=1
    api_gone "accounts/${account}" 600 || { note "account ${account} not gone"; failed=1; }
  done
  part_rc "$failed" "$acted"
}
# This run's tenants in the two tenant-identity deployments; nothing else there is touched.
identity_part() {
  local v id api n failed=0 acted=0
  for v in TENANT_A TENANT_B TENANT_C TENANT_U MT_TENANT; do
    id="${!v:-}"
    [[ -n "$id" ]] || continue
    api="$IDENTITY_API"
    [[ "$v" == MT_TENANT ]] && api="${MT_API:-}"
    n=0
    ti_delete "$api" "$id" || n=$?
    case "$n" in 0) acted=1 ;; 3) ;; *) failed=1 ;; esac
  done
  part_rc "$failed" "$acted"
}
control_plane_part() {
  local p1="" p2="" cp=0 ca=0 failed=0 acted=0
  cp_stack_state "$S_CP" || cp=$?
  stack_state "$S_CELL_ACCOUNT" || ca=$?
  if (( cp == 0 )); then
    if [[ -n "$VENDOR_ISSUER" && -n "$VENDOR_OPERATOR_CLIENT" ]]; then
      timed destroy control-plane cp_cdk destroy-control-plane "$CP_ACCOUNT" destroy "$S_CP" --force \
        --context "stackName=$S_CP" --context "fleetName=$FLEET" \
        --context "vendorIdpIssuerUrl=$VENDOR_ISSUER" --context "vendorIdpAudience=$VENDOR_OPERATOR_CLIENT" &
      p1=$!
      acted=1
    else
      note "the control plane's destroy cannot be synthesised: the vendor IdP's outputs in ${S_SUPPORT} cannot be read"
      failed=1
    fi
  elif (( cp != 1 )); then
    failed=1
  fi
  if (( ca == 0 )); then
    timed destroy cell-account cp_cdk destroy-cell-account "$EDGE_ACCOUNT" destroy "$S_CELL_ACCOUNT" --force \
      --context "fleetName=$FLEET" --context "cellAccount=$(jq -nc --arg cp "$CP_ACCOUNT" '{controlPlaneAccountId: $cp}')" &
    p2=$!
    acted=1
  elif (( ca != 1 )); then
    failed=1
  fi
  [[ -z "$p1" ]] || wait "$p1" || { tail -20 "$RUN_DIR/logs/destroy-control-plane.log"; failed=1; }
  [[ -z "$p2" ]] || wait "$p2" || { tail -20 "$RUN_DIR/logs/destroy-cell-account.log"; failed=1; }
  part_rc "$failed" "$acted"
}
# The setup stacks go last, and only when every part in or for the control
# plane's account succeeded: the setup stack holds the driver's access role
# (its only view of that account) and the support stack the vendor IdP the
# control plane's app needs to synthesise its destroy.
setup_part() {
  if (( CP_PART_FAILS > 0 )); then
    note "kept ${S_CP_SETUP} and ${S_SUPPORT}: ${CP_PART_FAILS} part(s) in or for the control plane's account failed,"
    note "and a rerun needs the access role and the vendor IdP they hold; finish with: scripts/integ.sh teardown ${RUN_ID} ${MODE}"
    return 1
  fi
  local n=0 failed=0 acted=0
  cp_stack_state "$S_CP_SETUP" || n=$?
  case "$n" in
    0)
      if destroy_one "$S_CP_SETUP" cp-setup; then state_set CP_SETUP_REMOVED yes; acted=1; else failed=1; fi ;;
    1)
      [[ "$CP_REACH" == yes ]] && state_set CP_SETUP_REMOVED yes ;;
    *)
      if [[ "$CP_REACH" == no ]] && (( ${DEPLOY_PHASE:-9} < 2 )); then
        note "${S_CP_SETUP}: destroyed through the CDK's own roles, since the access role it would hold cannot be assumed"
        if destroy_one "$S_CP_SETUP" cp-setup; then state_set CP_SETUP_REMOVED yes; acted=1; else failed=1; fi
      else
        failed=1
      fi ;;
  esac
  n=0
  destroy_if "$S_SUPPORT" support "$S_SUPPORT" "" edge || n=$?
  case "$n" in 0) acted=1 ;; 3) ;; *) failed=1 ;; esac
  part_rc "$failed" "$acted"
}

teardown() {
  section "24. remove the fixture, then the ordered teardown (spec §6.2)"
  IN_TEARDOWN=1
  teardown_credentials || return 1
  teardown_read
  try_cp "hook parameter restored" restore_parameter_part
  try_cp "probe hook" probe_hook_part
  try "step 14 TXT records" txt_part
  try "step 2 fixture key" fixture_part
  try_cp "(1) deployments and cells through the control plane" records_part
  try_cp "(2) register-hooks.sh --delete" hooks_part
  try_cp "(3) RouteHookAccess policy out of the control plane" control_plane_policy_part
  try_cp "(4) RouteHookAccess stack" route_hook_access_part
  try_cp "(5) hook parameter" hook_parameter_part
  try_cp "(6) front door, cells, test role, agent ingress" edge_stacks_part
  try_cp "control plane records" cp_records_part
  try "tenant-identity tenants" identity_part
  try_cp "control plane and the edge account's role pair" control_plane_part
  try_cp "leftovers in the control plane's account" leftovers_cp
  try "control plane setup and support stacks" setup_part
  try "leftovers in the edge account" leftovers_edge
  try "leftovers in the tenant-identity pools" leftovers_identity
  check "teardown parts" 0 "$TEARDOWN_FAILS"
  (( TEARDOWN_FAILS == 0 ))
}

# -- Leftover check ----------------------------------------------------------------------
# A thing found is a LEFTOVER; a read that fails with anything but "not
# found" is NOT READ. Either fails the check: a check that cannot read
# cannot say the account is clean.
LEFT=0
UNREAD=0
left() { LEFT=$((LEFT + 1)); note "LEFTOVER $*"; }
unread() { UNREAD=$((UNREAD + 1)); note "NOT READ $*"; }
# absent DESC NOT_FOUND CMD...: LEFTOVER when CMD finds it, nothing when it
# fails with an error matching NOT_FOUND, NOT READ on any other error.
absent() {
  local desc="$1" gone="$2" err
  shift 2
  if err="$("$@" 2>&1 >/dev/null)"; then left "$desc"; return 0; fi
  [[ "$err" =~ $gone ]] || unread "${desc}: $(clip <<<"$err")"
  return 0
}
# read_into VAR DESC CMD...: VAR holds CMD's output; NOT READ (VAR empty, status 1) when CMD fails.
read_into() {
  local __var="$1" __desc="$2" __out
  shift 2
  if __out="$("$@" 2>"$TMP/read.err")"; then printf -v "$__var" '%s' "$__out"; return 0; fi
  printf -v "$__var" '%s' ''
  unread "${__desc}: $(clip <"$TMP/read.err")"
  return 1
}
# none_under DESC CMD...: CMD counts parameters; LEFTOVER when it counts any.
none_under() {
  local desc="$1" n
  shift
  read_into n "$desc" "$@" || return 0
  [[ "$n" == 0 ]] || left "$desc"
  return 0
}
leftovers_cp() {
  local rc=0
  cp_access || rc=$?
  case "$rc" in
    3) note "the control plane's account: nothing to check (${CP_ACCESS_WHY})"; return 3 ;;
    0) ;;
    *) unread "the control plane's account (${CP_ACCESS_WHY}); check it by hand (integration-test.md, After an interruption)"
       return 1 ;;
  esac
  local before=$LEFT ubefore=$UNREAD s n name id count
  for s in "$S_CP" "$S_RHA" "$S_CELL_A"; do
    n=0
    stack_state "$s" "$REGION" cp || n=$?
    case "$n" in 0) left "stack $s (control plane's account)" ;; 1) ;; *) unread "stack $s (control plane's account)" ;; esac
  done
  absent "hook parameter $HOOK_PARAMETER" ParameterNotFound in_cp aws ssm get-parameter --region "$REGION" --name "$HOOK_PARAMETER"
  absent "policy tenant-front-door-route-hook-${APP}" NoSuchEntity \
    in_cp aws iam get-policy --policy-arn "arn:aws:iam::${CP_ACCOUNT}:policy/tenant-front-door-route-hook-${APP}"
  for name in api cell-build tenant-build global-hook app-hook cell-provisioning tenant-provisioning; do
    absent "role ${FLEET}-${name} (control plane's account)" NoSuchEntity in_cp aws iam get-role --role-name "${FLEET}-${name}"
  done
  for id in "${TENANT_A:-}" "${TENANT_C:-}"; do
    [[ -n "$id" ]] || continue
    none_under "parameters under /application-plane/tenants/${id}/${APP} (control plane's account)" \
      in_cp aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/tenants/${id}/${APP}" --recursive \
      --query 'length(Parameters)' --output text
  done
  for id in "${CELL_A:-}" "${PLAIN_CELL:-}"; do
    [[ -n "$id" ]] || continue
    absent "parameter /application-plane/cells/${id}/registrar-probe (control plane's account)" ParameterNotFound \
      in_cp aws ssm get-parameter --region "$REGION" --name "/application-plane/cells/${id}/registrar-probe"
  done
  count="$(in_cp aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "/aws/lambda/${PREFIX}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null | wc -w)" || count="?"
  note "expected harness leftovers (default Lambda log groups): ${count} in the control plane's account"
  (( LEFT == before && UNREAD == ubefore ))
}
leftovers_edge() {
  local before=$LEFT ubefore=$UNREAD r s stacks name id arns arn n count
  for r in $(printf '%s\n' "$REGION" us-east-1 | sort -u); do
    read_into stacks "the stacks in ${r}" \
      aws cloudformation list-stacks --region "$r" --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" --output text \
      || continue
    for s in $stacks; do
      if [[ "$s" == "$PREFIX"-* || "$s" == "$FLEET"-* ]]; then left "stack $s ($r)"; fi
    done
  done
  for name in "$R_EDGE_OPERATOR" "$R_TEST" "$R_STRANGER" "${FLEET}-cell-provisioning" "${FLEET}-tenant-provisioning"; do
    absent "role $name" NoSuchEntity aws iam get-role --role-name "$name"
  done
  absent "policy ${PAIR_PROBE_POLICY}" NoSuchEntity aws iam get-policy --policy-arn "arn:aws:iam::${EDGE_ACCOUNT}:policy/${PAIR_PROBE_POLICY}"
  if [[ -n "${TENANT_B:-}" ]]; then
    none_under "parameters under /application-plane/tenants/${TENANT_B}/${APP}" \
      aws ssm get-parameters-by-path --region "$REGION" --path "/application-plane/tenants/${TENANT_B}/${APP}" --recursive \
      --query 'length(Parameters)' --output text
  fi
  if [[ -n "${CELL_B:-}" ]]; then
    absent "parameter /application-plane/cells/${CELL_B}/registrar-probe" ParameterNotFound \
      aws ssm get-parameter --region "$REGION" --name "/application-plane/cells/${CELL_B}/registrar-probe"
  fi
  absent "the edge parameter" ParameterNotFound aws ssm get-parameter --region "$REGION" --name /application-plane/shared/front-door/edge
  for name in "$DD" "probe.${DD}"; do
    read_into arns "certificates for ${name}" aws acm list-certificates --region us-east-1 \
      --includes 'keyTypes=RSA_2048,EC_prime256v1,EC_secp384r1' \
      --query "CertificateSummaryList[?DomainName=='${name}'].CertificateArn" --output text || continue
    for arn in $arns; do left "certificate for ${name}: ${arn##*/}"; done
  done
  if read_into n "TXT records at _tfd-challenge.${DD}" aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
      --start-record-name "_tfd-challenge.${DD}." --start-record-type TXT --max-items 1 \
      --query "length(ResourceRecordSets[?Name=='_tfd-challenge.${DD}.'])" --output text; then
    [[ "$n" == 0 ]] || left "TXT records at _tfd-challenge.${DD}"
  fi
  count="$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "/aws/lambda/${PREFIX}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null | wc -w)" || count="?"
  note "expected harness leftovers (default Lambda log groups): ${count} in the edge account"
  (( LEFT == before && UNREAD == ubefore ))
}
# This run's tenants in the shared tenant-identity pools, read with GetTenant only.
leftovers_identity() {
  local before=$LEFT ubefore=$UNREAD v id api st checked=0
  for v in TENANT_A TENANT_B TENANT_C TENANT_U MT_TENANT; do
    id="${!v:-}"
    [[ -n "$id" ]] || continue
    api="$IDENTITY_API"
    [[ "$v" == MT_TENANT ]] && api="${MT_API:-}"
    checked=1
    st="$(ti_status "$api" "$id")"
    case "$st" in
      gone) ;;
      error:*) unread "tenant-identity tenant ${id}: GetTenant ${st#error:}" ;;
      *) left "tenant-identity tenant ${id} (${st}) in the shared pool; a teardown rerun sends DeleteTenant again" ;;
    esac
  done
  (( checked )) || return 3
  (( LEFT == before && UNREAD == ubefore ))
}
