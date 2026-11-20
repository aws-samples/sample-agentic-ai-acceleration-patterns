#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The integration test's deploy phases (spec §10 step 1), sourced by
# scripts/integ.sh. Each stack is deployed by its own CDK call, so its
# deploy time is recorded on its own (times.tsv). Stacks of different
# accounts deploy in parallel where nothing orders them.

# wait_all PID...: waits for every job, so none is still deploying when a
# failure starts the teardown; fails when any failed.
wait_all() {
  local rc=0 p
  for p in "$@"; do wait "$p" || rc=1; done
  return $rc
}

# Phase 1: the support, setup and stand-in stacks, which need nothing deployed.
deploy_phase_1() {
  section "deploy 1: support (edge), control plane setup (control plane's), agent ingress (edge)"
  state_set DEPLOY_PHASE 1
  deploy_one "$S_SUPPORT" support &
  local p1=$!
  deploy_one "$S_CP_SETUP" cp-setup &
  local p2=$!
  deploy_one "$S_INGRESS" agent-ingress &
  local p3=$!
  wait_all $p1 $p2 $p3 || die "a phase 1 stack failed (logs in $RUN_DIR/logs)"
  read_phase_1
  # The operator: one user of the vendor IdP, with a password that lives in this shell only.
  set_operator_password
  ctx_set vendorIdp "$(jq -nc --arg t "$VENDOR_TOKEN_URL" --arg c "$VENDOR_READER_CLIENT" --arg s "$VENDOR_READER_SECRET" '{tokenUrl: $t, clientId: $c, clientSecretArn: $s}')"
  ctx_set agentIngressUrl "\"$AGENT_INGRESS_URL\""
}

read_phase_1() {
  VENDOR_POOL="$(stack_out "$S_SUPPORT" UserPoolId)"
  VENDOR_ISSUER="$(stack_out "$S_SUPPORT" IssuerUrl)"
  VENDOR_OPERATOR_CLIENT="$(stack_out "$S_SUPPORT" OperatorClientId)"
  VENDOR_READER_CLIENT="$(stack_out "$S_SUPPORT" ReaderClientId)"
  VENDOR_READER_SECRET="$(stack_out "$S_SUPPORT" ReaderSecretArn)"
  VENDOR_TOKEN_URL="$(stack_out "$S_SUPPORT" TokenUrl)"
  EDGE_OPERATOR="$(stack_out "$S_SUPPORT" EdgeOperatorRoleArn)"
  STRANGER="$(stack_out "$S_SUPPORT" StrangerRoleArn)"
  EDGE_PROBE_POLICY="$(stack_out "$S_SUPPORT" PairProbePolicyArn)"
  AGENT_INGRESS_URL="$(stack_out "$S_INGRESS" Url)"
  INGRESS_LOG="$(stack_out "$S_INGRESS" StreamLogGroupName)"
  INGRESS_LOG_ARN="$(stack_out "$S_INGRESS" StreamLogGroupArn)"
  SOURCE_BUCKET="$(cp_stack_out "$S_CP_SETUP" SourceBucket)"
  SOURCE_KEY="$(cp_stack_out "$S_CP_SETUP" SourceKey)"
  CP_PROBE_POLICY="$(cp_stack_out "$S_CP_SETUP" PairProbePolicyArn)"
  SOURCE_VERSION="$(in_cp aws s3api list-object-versions --region "$REGION" --bucket "$SOURCE_BUCKET" --prefix "$SOURCE_KEY" \
    --query 'Versions[?IsLatest] | [0].VersionId' --output text)"
  [[ -n "$SOURCE_VERSION" && "$SOURCE_VERSION" != None ]] || { die "no version of the source zip ${SOURCE_KEY}"; return 1; }
}

# The control plane, through the control-plane sample's own app, in its account (spec §6.3).
deploy_control_plane() { # LABEL [HOOK_POLICY_ARN]
  local hooks=()
  [[ -n "${2:-}" ]] && hooks=(--context "globalHookManagedPolicyArns=[\"$2\"]")
  timed deploy "$1" cp_cdk "deploy-$1" "$CP_ACCOUNT" deploy "$S_CP" --require-approval never \
    --context "stackName=$S_CP" --context "fleetName=$FLEET" \
    --context "vendorIdpIssuerUrl=$VENDOR_ISSUER" --context "vendorIdpAudience=$VENDOR_OPERATOR_CLIENT" \
    --context "vendorIdpClientIds=[\"$VENDOR_READER_CLIENT\"]" --context "vendorIdpRequiredScope=control-plane/read" \
    --context 'readerRoles=["control-plane:reader"]' \
    --context "cellBuildManagedPolicyArns=[\"$CP_PROBE_POLICY\"]" --context "tenantBuildManagedPolicyArns=[\"$CP_PROBE_POLICY\"]" \
    "${hooks[@]}" || { tail -40 "$RUN_DIR/logs/deploy-$1.log"; return 1; }
}

# Phase 2: the control plane and the edge account's role pair (with the run's external id).
deploy_phase_2() {
  section "deploy 2: control plane (control plane's account), account role pair (edge account)"
  state_set DEPLOY_PHASE 2
  deploy_control_plane control-plane &
  local p1=$!
  timed deploy cell-account cp_cdk deploy-cell-account "$EDGE_ACCOUNT" deploy "$S_CELL_ACCOUNT" --require-approval never \
    --context "fleetName=$FLEET" \
    --context "cellAccount=$(jq -nc --arg cp "$CP_ACCOUNT" --arg x "$EXTERNAL_ID" --arg p "$EDGE_PROBE_POLICY" \
      '{controlPlaneAccountId: $cp, externalId: $x, tenantBuildManagedPolicyArns: [$p], cellBuildManagedPolicyArns: [$p]}')" &
  local p2=$!
  wait_all $p1 $p2 || die "a phase 2 stack failed (logs in $RUN_DIR/logs)"
  read_phase_2
}
read_phase_2() {
  CP_API="$(cp_stack_out "$S_CP" ApiUrl)"
  [[ "$CP_API" == https://* ]] || { CP_API=""; die "no control plane API URL"; return 1; }
  [[ "$CP_API" == */ ]] || CP_API="$CP_API/"
  ctx_set controlPlaneApiUrl "\"$CP_API\""
}

# Phase 3: the front door, in its deploy order (ADR-0010).
deploy_phase_3() {
  section "deploy 3: front door edge, main, edge logging (edge account)"
  state_set DEPLOY_PHASE 3
  deploy_one FrontDoor/Edge edge || die "the edge stack failed"
  deploy_one FrontDoor/Main main || die "the main stack failed"
  deploy_one FrontDoor/EdgeLogging edge-logging || die "the edge logging stack failed"
  read_phase_3
  ctx_set registrarUrl "\"$REGISTRAR\""
  ctx_set distributionArn "\"$DIST_ARN\""
}
read_phase_3() {
  local edge_param
  REGISTRAR=""; DIST_ARN=""; DIST_ID=""
  if edge_param="$(aws ssm get-parameter --region "$REGION" --name /application-plane/shared/front-door/edge --query Parameter.Value --output text)" \
      && [[ "$(jq -r '.registrarUrl // empty' <<<"$edge_param" 2>/dev/null)" == https://* ]]; then
    REGISTRAR="$(jq -r .registrarUrl <<<"$edge_param")"; [[ "$REGISTRAR" == */ ]] || REGISTRAR="$REGISTRAR/"
    DIST_ARN="$(jq -r '.distributionArn // empty' <<<"$edge_param")"; DIST_ID="${DIST_ARN##*/}"
  fi
  KVS="$(stack_out "$S_MAIN" IntegRouteTableArn)"
  ROUTER_ARN="$(stack_out "$S_MAIN" IntegRouterFunctionArn)"; ROUTER_NAME="${ROUTER_ARN##*/}"
  ROUTING="$(stack_out "$S_MAIN" IntegRoutingEndpoint)"
  REGISTRAR_LOG="$(stack_out "$S_MAIN" IntegRegistrarLogGroupName)"
  REGISTRAR_LOG_ARN="$(stack_out "$S_MAIN" IntegRegistrarLogGroupArn)"
  ACCESS_LOG="$(stack_out "$S_MAIN" IntegRegistrarAccessLogGroupName)"
  ACCESS_LOG_ARN="$(stack_out "$S_MAIN" IntegRegistrarAccessLogGroupArn)"
  SWEEPER="$(stack_out "$S_MAIN" IntegSweeperFunctionName)"
  SWEEPER_ARN="$(stack_out "$S_MAIN" IntegSweeperFunctionArn)"
  SWEEPER_TABLE="$(stack_out "$S_MAIN" IntegSweeperTableName)"
  SWEEPER_TABLE_ARN="$(stack_out "$S_MAIN" IntegSweeperTableArn)"
  SWEEPER_LOG="$(stack_out "$S_MAIN" IntegSweeperLogGroupName)"
  SWEEPER_LOG_ARN="$(stack_out "$S_MAIN" IntegSweeperLogGroupArn)"
  EDGE_LOG="$(stack_out "$S_EDGE_LOGGING" IntegEdgeLogGroupName us-east-1)"
  EDGE_LOG_ARN="$(stack_out "$S_EDGE_LOGGING" IntegEdgeLogGroupArn us-east-1)"
  [[ "$KVS" == arn:*:key-value-store/* ]] || { KVS=""; die "no route table ARN in the main stack's outputs"; return 1; }
  [[ -n "$REGISTRAR" ]] || { die "no registrar URL in the edge parameter"; return 1; }
}

# Phase 4: RouteHookAccess (control plane's account, ADR-0027) and the two cells, then the test role.
deploy_phase_4() {
  section "deploy 4: RouteHookAccess, cell A (control plane's account), cell B (edge account), test role"
  state_set DEPLOY_PHASE 4
  deploy_one FrontDoor/RouteHookAccess route-hook-access &
  local p1=$!
  deploy_one "$S_CELL_A" cell-a &
  local p2=$!
  deploy_one "$S_CELL_B" cell-b &
  local p3=$!
  wait_all $p1 $p2 $p3 || die "a phase 4 stack failed (logs in $RUN_DIR/logs)"
  read_phase_4
  ctx_set testRole "$(test_role_inputs)"
  deploy_one "$S_TEST_ROLE" test-role || die "the test role stack failed"
  TEST_ROLE="$(stack_out "$S_TEST_ROLE" TestRoleArn)"
}
read_phase_4() {
  HOOK_POLICY="$(cp_stack_out "$S_RHA" IntegHookPolicyArn)"
  HOOK_PARAMETER="$(cp_stack_out "$S_RHA" IntegHookParameterName)"
  CELL_A_URL="$(cp_stack_out "$S_CELL_A" FunctionUrl)"
  CELL_A_LOG="$(cp_stack_out "$S_CELL_A" LogGroupName)"
  CELL_B_URL="$(stack_out "$S_CELL_B" FunctionUrl)"
  CELL_B_LOG="$(stack_out "$S_CELL_B" LogGroupName)"
  CELL_B_LOG_ARN="$(stack_out "$S_CELL_B" LogGroupArn)"
}
test_role_inputs() {
  jq -nc --arg d "$DIST_ID" --arg kvs "$KVS" --arg r "$ROUTER_ARN" --arg rl "$REGISTRAR_LOG_ARN" --arg al "$ACCESS_LOG_ARN" \
    --arg el "$EDGE_LOG_ARN" --arg il "$INGRESS_LOG_ARN" --arg cl "$CELL_B_LOG_ARN" \
    --arg sf "$SWEEPER_ARN" --arg st "$SWEEPER_TABLE_ARN" --arg sl "$SWEEPER_LOG_ARN" '{
      distributionId: $d, routeTableArn: $kvs, routerFunctionArn: $r, registrarLogGroupArn: $rl, registrarAccessLogGroupArn: $al,
      edgeLogGroupArn: $el, agentIngressLogGroupArn: $il, cellLogGroupArn: $cl}
      + (if $sf == "None" or $sf == "" then {} else {sweeperFunctionArn: $sf, sweeperTableArn: $st, sweeperLogGroupArn: $sl} end)'
}

# Phase 5: the hook policy on the control plane, then the two global hooks (spec §6.1).
deploy_phase_5() {
  section "deploy 5: control plane update with the RouteHookAccess policy, register-hooks.sh"
  state_set DEPLOY_PHASE 5
  # Recorded before each change, so a run that stops in the middle of one still undoes it (step 24).
  state_set HOOK_POLICY_ATTACHED yes
  deploy_control_plane control-plane-hooks "$HOOK_POLICY" || die "the control plane update failed"
  api_token
  state_set HOOKS_REGISTERED yes
  CONTROL_PLANE_URL="$CP_API" CONTROL_PLANE_TOKEN="$CP_TOKEN" HOOK_SOURCE_TYPE=S3 \
    HOOK_SOURCE_LOCATION="${SOURCE_BUCKET}/${SOURCE_KEY}" HOOK_SOURCE_VERSION="$SOURCE_VERSION" \
    timed step register-hooks bash scripts/register-hooks.sh || die "register-hooks.sh failed"
}
