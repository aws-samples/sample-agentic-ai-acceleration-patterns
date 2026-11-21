#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The tenant front door's integration test (spec §10, ADR-0028): deploys
# the front door with its own control plane across two accounts, runs the
# steps of §10 and tears everything down in the §6.2 order. It is the
# reference for how the front door, the control plane, its hooks and
# tenant-identity fit together (integration-test.md).
#
#   scripts/integ.sh single              # a run in single mode (test/integ.single.ts)
#   scripts/integ.sh host                # a run in host mode (test/integ.host.ts)
#   scripts/integ.sh plan [single|host]  # the run's names and orders; makes no AWS call
#   scripts/integ.sh teardown <run id> single|host   # the ordered teardown of a run that stopped
#   scripts/integ.sh leftovers <run id> single|host  # the leftover check alone
#
# Inputs (environment), none of them committed:
#   AWS_REGION              the control plane's Region; the edge stacks go to us-east-1
#   TFD_INTEG_ACCOUNT_B     the control plane's account, CDK-bootstrapped to trust this one
#   TFD_APP_DOMAIN          the appDomain, a name below the hosted zone's apex
#   TFD_HOSTED_ZONE_ID      the public hosted zone, in the account the credentials point at
#   TFD_DEDICATED_DOMAIN    step 14's name: in the zone, outside TFD_APP_DOMAIN
#   TFD_INTEG_RUN_ID        optional, [a-z0-9]{1,10} without aws, amazon or cognito; default a new one per run
#   TFD_IDENTITY_REGION     optional, the tenant-identity shared pool's Region; default AWS_REGION
#   TFD_ISSUER_DOMAIN       optional, a Cognito domain for the front door's issuer input
#   TFD_INTEG_KEEP=1        optional, skip the teardown (debugging; run `teardown` after)
#
# Both accounts use CDK's default bootstrap qualifier: the test apps use the
# default synthesizer and the preflight reads through the default lookup role.
# Everything the run makes carries its run id. Tokens, passwords and keys
# stay in shell variables and 0600 files (scripts/CONVENTIONS.md).

set -euo pipefail
cd "$(dirname "$0")/.."
SAMPLE_DIR="$PWD"
CONTROL_PLANE_DIR="$(cd ../control-plane && pwd)"

usage() { sed -n '11,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
COMMAND="${1:-}"
case "$COMMAND" in
  single | host) MODE="$COMMAND" ;;
  plan) MODE="${2:-single}" ;;
  teardown | leftovers) [[ $# == 3 ]] || usage; TFD_INTEG_RUN_ID="$2"; MODE="$3" ;;
  *) usage ;;
esac
[[ "$MODE" =~ ^(single|host)$ ]] || usage

source scripts/integ/lib.sh

# -- Names: the same as test/integ/inputs.ts integNames ----------------------------------
if [[ "$COMMAND" == plan ]]; then RUN_ID="${TFD_INTEG_RUN_ID:-plan0}"; else
  RUN_ID="${TFD_INTEG_RUN_ID:-$(date -u +%m%d%H%M)$(rand_chars 'a-z0-9' 2)}"; fi
[[ "$RUN_ID" =~ ^[a-z0-9]{1,10}$ && ! "$RUN_ID" =~ aws|amazon|cognito ]] || { echo "integ: TFD_INTEG_RUN_ID must match [a-z0-9]{1,10} without aws, amazon or cognito" >&2; exit 2; }
PREFIX="TfdInteg-${RUN_ID}"
FLEET="tfdi-${RUN_ID}"
APP="tfd-${RUN_ID}"
PLAIN_APP="plain-${RUN_ID}"
S_SUPPORT="${PREFIX}-support"; S_CP_SETUP="${PREFIX}-cp-setup"; S_CP="${PREFIX}-control-plane"; S_CELL_ACCOUNT="${FLEET}-cell-account"
S_INGRESS="${PREFIX}-agent-ingress"; S_EDGE="${PREFIX}-edge"; S_MAIN="${PREFIX}-main"; S_EDGE_LOGGING="${PREFIX}-edge-logging"
S_RHA="${PREFIX}-route-hook-access"; S_CELL_A="${PREFIX}-cell-a"; S_CELL_B="${PREFIX}-cell-b"; S_TEST_ROLE="${PREFIX}-test-role"
R_EDGE_OPERATOR="${PREFIX}-edge-operator"; R_TEST="${PREFIX}-test"; R_STRANGER="${PREFIX}-stranger"; R_CP_ACCESS="${PREFIX}-cp-access"
PAIR_PROBE_POLICY="${PREFIX}-pair-registrar-probe"

source scripts/integ/deploy.sh
source scripts/integ/steps.sh
source scripts/integ/teardown.sh

plan() {
  echo "run ${RUN_ID} mode ${MODE}"
  echo "stack support ${S_SUPPORT} edge"
  echo "stack controlPlaneSetup ${S_CP_SETUP} control-plane"
  echo "stack agentIngress ${S_INGRESS} edge"
  echo "stack controlPlane ${S_CP} control-plane"
  echo "stack cellAccount ${S_CELL_ACCOUNT} edge"
  echo "stack edge ${S_EDGE} edge"
  echo "stack main ${S_MAIN} edge"
  echo "stack edgeLogging ${S_EDGE_LOGGING} edge"
  echo "stack routeHookAccess ${S_RHA} control-plane"
  echo "stack cellA ${S_CELL_A} control-plane"
  echo "stack cellB ${S_CELL_B} edge"
  echo "stack testRole ${S_TEST_ROLE} edge"
  echo "role edgeOperator ${R_EDGE_OPERATOR}"
  echo "role test ${R_TEST}"
  echo "role stranger ${R_STRANGER}"
  echo "role controlPlaneAccess ${R_CP_ACCESS}"
  echo "policy pairProbe ${PAIR_PROBE_POLICY}"
  echo "fleet ${FLEET}"
  echo "application ${APP} ${PLAIN_APP}"
  echo "deploy support,controlPlaneSetup,agentIngress controlPlane,cellAccount edge main edgeLogging routeHookAccess,cellA,cellB testRole controlPlane"
  local steps=("${STEPS_SINGLE[@]}")
  [[ "$MODE" == host ]] && steps=("${STEPS_HOST[@]}")
  echo "steps ${steps[*]} 24"
  echo "teardown fixture deployments-and-cells register-hooks-delete control-plane-policy routeHookAccess hook-parameter testRole,cellA,cellB,edgeLogging,main,edge,agentIngress records identity controlPlane,cellAccount controlPlaneSetup,support"
}
if [[ "$COMMAND" == plan ]]; then plan; exit 0; fi

# -- Inputs and preflight ---------------------------------------------------------------
: "${AWS_REGION:?set AWS_REGION to the control plane Region (spec §10)}"
: "${TFD_INTEG_ACCOUNT_B:?set TFD_INTEG_ACCOUNT_B to the control plane account}"
: "${TFD_APP_DOMAIN:?set TFD_APP_DOMAIN}" "${TFD_HOSTED_ZONE_ID:?set TFD_HOSTED_ZONE_ID}" "${TFD_DEDICATED_DOMAIN:?set TFD_DEDICATED_DOMAIN}"
REGION="$AWS_REGION"
CP_ACCOUNT="$TFD_INTEG_ACCOUNT_B"
APP_DOMAIN="${TFD_APP_DOMAIN,,}"
DD="${TFD_DEDICATED_DOMAIN,,}"
ZONE_ID="$TFD_HOSTED_ZONE_ID"
IDENTITY_REGION="${TFD_IDENTITY_REGION:-$REGION}"
RUN_DIR="$SAMPLE_DIR/.integ/$RUN_ID"
mkdir -p "$RUN_DIR/logs"
chmod 700 "$RUN_DIR"
TMP="$(mktemp -d)"
# Removes TMP on an exit before the teardown trap (on_exit, below) replaces it.
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT
BODY="$TMP/body"; HEAD="$TMP/head"; REQ="$TMP/req"
: >"$BODY"; : >"$HEAD"; : >"$REQ"; chmod 600 "$BODY" "$HEAD" "$REQ"
[[ "$CP_ACCOUNT" =~ ^[0-9]{12}$ ]] || die "TFD_INTEG_ACCOUNT_B must be a 12-digit account id"

# resume_hint: how to finish a run that already made something.
resume_hint() { [[ "$COMMAND" == teardown || "$COMMAND" == leftovers ]] && echo "; refresh them, then resume with: scripts/integ.sh ${COMMAND} ${RUN_ID} ${MODE}"; return 0; }
EDGE_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "no working AWS credentials (sts get-caller-identity failed)$(resume_hint)"
[[ "$EDGE_ACCOUNT" != "$CP_ACCOUNT" ]] || die "TFD_INTEG_ACCOUNT_B must be another account than the one the credentials point at"
CP_ACCESS_ROLE="arn:aws:iam::${CP_ACCOUNT}:role/${R_CP_ACCESS}"
# read_shared NAME: a published parameter of tenant-identity's shared pool; empty when it cannot be read.
read_shared() { aws ssm get-parameter --region "$IDENTITY_REGION" --name "$1" --query Parameter.Value --output text 2>/dev/null || true; }
IDENTITY_API="$(read_shared /application-plane/shared/identity/apiUrl)"
[[ -z "$IDENTITY_API" || "$IDENTITY_API" == */ ]] || IDENTITY_API="$IDENTITY_API/"
if [[ "$COMMAND" == single || "$COMMAND" == host ]]; then
  [[ -n "$IDENTITY_API" ]] || die "no tenant-identity shared pool in ${IDENTITY_REGION} (/application-plane/shared/identity/apiUrl)"
  caller="$(aws sts get-caller-identity --query Arn --output text)"
  if [[ "$caller" =~ ^arn:aws:sts::[0-9]{12}:assumed-role/([^/]+)/ ]]; then
    DRIVER_PRINCIPAL="$(aws iam get-role --role-name "${BASH_REMATCH[1]}" --query Role.Arn --output text)" || die "cannot read the driver's role"
  else
    DRIVER_PRINCIPAL="$caller"
  fi
  ZONE_NAME="$(aws route53 get-hosted-zone --id "$ZONE_ID" --query HostedZone.Name --output text)" || die "cannot read the hosted zone ${ZONE_ID}"
  ZONE_NAME="${ZONE_NAME%.}"
  IDENTITY_POOL="$(read_shared /application-plane/shared/identity/userPoolId)"
  IDENTITY_CLIENT="$(read_shared /application-plane/shared/identity/appClientId)"
  [[ -n "$IDENTITY_POOL" && -n "$IDENTITY_CLIENT" ]] || die "the tenant-identity shared pool's userPoolId or appClientId parameter cannot be read"
fi
# host mode lowers the per-host rate so step 17 reaches it in seconds; the per-IP rate stays below it until then.
# single mode sets neither: ipRequestsPer5Min is a host-mode input, and the cells keep the default origin rate.
TENANT_RATE=2000; IP_RATE=500
[[ "$MODE" == host ]] && { TENANT_RATE=100; IP_RATE=50; }

preflight() {
  section "preflight: run ${RUN_ID}, ${MODE} mode, ${REGION}, edge account ${EDGE_ACCOUNT}, control plane's account ${CP_ACCOUNT}"
  [[ "$APP_DOMAIN" == *".${ZONE_NAME}" ]] || die "TFD_APP_DOMAIN is not below the zone's apex"
  if aws ssm get-parameter --region "$REGION" --name /application-plane/shared/front-door/edge >/dev/null 2>&1; then
    die "another front door holds /application-plane/shared/front-door/edge in this account and ${REGION}: one front door per account and Region (spec §6.4); remove it or pick another Region"
  fi
  local apigw_role
  apigw_role="$(aws apigateway get-account --region "$REGION" --query cloudwatchRoleArn --output text)"
  [[ "$apigw_role" == arn:* ]] || die "API Gateway has no CloudWatch Logs role in ${REGION} (the front door's prerequisite)"
  # A setting that names a deleted role delivers no access log, silently.
  aws iam get-role --role-name "${apigw_role##*/}" >/dev/null 2>&1 \
    || die "API Gateway's CloudWatch Logs role in ${REGION} no longer exists; set one (test/integ/api-gateway-account.app.ts)"
  if [[ "$MODE" == single ]]; then
    aws cloudformation describe-stacks --region "$IDENTITY_REGION" --stack-name TenantIdentity-shared-pool-multi-tenant >/dev/null \
      || die "step 5 needs tenant-identity's TenantIdentity-shared-pool-multi-tenant deployment (never destroyed by this test)"
  fi
  local s r stacks err lookup
  for r in $(printf '%s\n' "$REGION" us-east-1 | sort -u); do
    stacks="$(aws cloudformation list-stacks --region "$r" --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" --output text)" \
      || die "cannot list the edge account's stacks in ${r}"
    for s in $stacks; do
      [[ "$s" == "$PREFIX"-* || "$s" == "$FLEET"-* ]] && die "stack $s of run ${RUN_ID} exists in the edge account (${r}): tear that run down first, or pick another TFD_INTEG_RUN_ID"
    done
  done
  # The control plane's account, read only, through its CDK bootstrap lookup role (it trusts the edge account): no
  # control plane may be there (its parameter name is fixed), and no stack of this run id.
  lookup="arn:aws:iam::${CP_ACCOUNT}:role/cdk-hnb659fds-lookup-role-${CP_ACCOUNT}-${REGION}"
  if err="$(as_role "$lookup" aws ssm get-parameter --region "$REGION" --name /control-plane/tenant-api-url 2>&1 >/dev/null)"; then
    die "the control plane's account already holds a control plane in ${REGION} (/control-plane/tenant-api-url): the test deploys its own (spec §10); remove it or pick another Region"
  fi
  [[ "$err" == *ParameterNotFound* ]] \
    || die "cannot read the control plane's account through its CDK lookup role ${lookup##*/} (the default bootstrap qualifier): $(clip <<<"$err")"
  stacks="$(as_role "$lookup" aws cloudformation list-stacks --region "$REGION" --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" --output text)" \
    || die "cannot list the control plane's account's stacks through ${lookup##*/}"
  for s in $stacks; do
    [[ "$s" == "$PREFIX"-* || "$s" == "$FLEET"-* ]] && die "stack $s of run ${RUN_ID} exists in the control plane's account: tear that run down first, or pick another TFD_INTEG_RUN_ID"
  done
  [[ -f build/spa/index.html ]] || npx projen spa:build >"$RUN_DIR/logs/spa-build.log" 2>&1 || die "the SPA build failed"
  [[ -d "$CONTROL_PLANE_DIR/src/smithy" ]] || ( cd "$CONTROL_PLANE_DIR" && smithy build ) >"$RUN_DIR/logs/control-plane-smithy.log" 2>&1 || die "smithy build in the control plane failed"
  [[ -d "$CONTROL_PLANE_DIR/node_modules" ]] || die "run npm ci in samples/control-plane first"
  EXTERNAL_ID="tfd-integ-$(rand_chars 'a-z0-9' 24)"
  jq -n --arg run "$RUN_ID" --arg edge "$EDGE_ACCOUNT" --arg cp "$CP_ACCOUNT" --arg r "$REGION" --arg p "$DRIVER_PRINCIPAL" \
    --arg d "$APP_DOMAIN" --arg z "$ZONE_ID" --arg zn "$ZONE_NAME" --arg dd "$DD" --arg pool "$IDENTITY_POOL" --arg client "$IDENTITY_CLIENT" \
    --arg ir "$IDENTITY_REGION" --arg issuer "${TFD_ISSUER_DOMAIN:-}" --arg mode "$MODE" --argjson tr "$TENANT_RATE" --argjson ir2 "$IP_RATE" '{
      runId: $run, edgeAccount: $edge, controlPlaneAccount: $cp, region: $r, driverPrincipalArn: $p,
      appDomain: $d, hostedZoneId: $z, zoneName: $zn, dedicatedDomain: $dd,
      identity: {userPoolId: $pool, appClientId: $client, region: $ir}}
      + (if $issuer == "" then {} else {issuerDomain: $issuer} end)
      + (if $mode == "host" then {tenantRequestsPer5Min: $tr, ipRequestsPer5Min: $ir2} else {} end)' >"$RUN_DIR/context.json"
  # A reused run id keeps the earlier state beside the new one: a teardown that ended with a part failed (and no stack left)
  # still has its ids there for a manual clean-up.
  [[ ! -s "$RUN_DIR/state.env" ]] || mv "$RUN_DIR/state.env" "$RUN_DIR/state.env.$(date +%s).old"
  : >"$RUN_DIR/state.env"
  printf 'kind\tname\tseconds\tresult\n' >"$RUN_DIR/times.tsv"
}

report() {
  section "times (deploy and destroy per stack, s)"
  column -t -s $'\t' "$RUN_DIR/times.tsv" 2>/dev/null | sed 's/^/  /' || true
  local deploy destroy
  deploy="$(awk -F'\t' '$1 == "deploy" { s += $3 } END { print s + 0 }' "$RUN_DIR/times.tsv")"
  destroy="$(awk -F'\t' '$1 == "destroy" { s += $3 } END { print s + 0 }' "$RUN_DIR/times.tsv")"
  note "stack deploys ${deploy} s in all (parallel ones overlap), stack destroys ${destroy} s, run $(elapsed "$RUN_T0") s"
  note "registrar 503 retries (control plane unreadable after the registrar's own retry, spec §3.4 step 2): $(registrar_retries)"
  echo "result: ${PASS} passed, ${FAILS} failed, ${SKIPS} skipped (run ${RUN_ID}, ${MODE}; logs in .integ/${RUN_ID})"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [[ "${TFD_INTEG_KEEP:-}" == 1 ]]; then
    note "TFD_INTEG_KEEP=1: the stacks stay up; remove them with: scripts/integ.sh teardown ${RUN_ID} ${MODE}"
  else
    teardown || true
  fi
  report
  rm -f "$TMP"/*; rmdir "$TMP"
  (( rc == 0 && FAILS == 0 )) || exit 1
}

RUN_T0=$(date +%s)
RUN_T0_MS="$(now_ms)"
case "$COMMAND" in
  teardown | leftovers)
    state_load
    [[ -s "$RUN_DIR/times.tsv" ]] || printf 'kind\tname\tseconds\tresult\n' >"$RUN_DIR/times.tsv"
    if [[ "$COMMAND" == teardown ]]; then
      teardown || true
    else
      IN_TEARDOWN=1
      teardown_credentials || { report; exit 1; }
      teardown_read
      leftovers_cp || true; leftovers_edge || true; leftovers_identity || true
      note "leftovers: ${LEFT} found, ${UNREAD} reads failed"
    fi
    report
    # 2: a read failed, so the check cannot say the accounts are clean; 1: a part failed or something is left.
    (( UNREAD == 0 )) || exit 2
    (( FAILS == 0 && LEFT == 0 )) || exit 1
    exit 0
    ;;
esac

preflight
# Armed before the first stack: every exit from here runs the teardown.
trap on_exit EXIT
steps=("${STEPS_SINGLE[@]}")
[[ "$MODE" == host ]] && steps=("${STEPS_HOST[@]}")
# Each step's start and end (ms), for checks that look back at one step's log lines (step 15).
declare -A STEP_START_MS=() STEP_END_MS=()
for n in "${steps[@]}"; do
  t=$(date +%s)
  STEP_START_MS[$n]="$(now_ms)"
  "step_${n}"
  STEP_END_MS[$n]="$(now_ms)"
  printf 'step\t%s\t%s\t-\n' "$n" "$(elapsed "$t")" >>"$RUN_DIR/times.tsv"
done
