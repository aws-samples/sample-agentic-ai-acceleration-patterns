#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Control-plane mounting integration test (mounting spec §10,
# docs/sample-standard.md §5.2). The reference implementation for wiring
# control-plane to tenant-identity.
#
#   AWS_REGION=eu-central-1 scripts/integ-control-plane.sh   # or: npx projen integ:control-plane
#
# 1. Deploys test/integ.control-plane.ts (TenantIdentity-shared-pool and the
#    setup stack: throwaway vendor IdP + script bucket) at once.
# 2. Deploys control-plane through its own deploy path (`npx cdk deploy` in
#    ../control-plane) with the §3.4 context, read from the published
#    parameters and the setup stack outputs. No control-plane code is imported.
# 3. Runs the §10 scenario (test/e2e/control-plane).
# 4. Always destroys, also on failure: control-plane first, then both
#    tenant-identity stacks; then checks nothing is left.
#
# Runs in exactly one Region (AWS_REGION) in the account of the ambient
# credentials, which must be CDK-bootstrapped. Needs ../control-plane built
# (npx projen build there) so its src/smithy exists.

set -euo pipefail

if [ -z "${AWS_REGION:-}" ]; then
  echo "Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)" >&2
  exit 1
fi
export AWS_DEFAULT_REGION="$AWS_REGION"

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CP_DIR="$(cd "$SAMPLE_DIR/../control-plane" && pwd)"
cd "$SAMPLE_DIR"

OUT="cdk.integ-cp.out"
CDK=(npx cdk --app "$OUT")
CP_STACK="control-plane-dev"
SETUP_STACK="TenantIdentityCpSetup"
IDENTITY_NS="/application-plane/shared/identity"
CP_CONTEXT=()

[ -d "$CP_DIR/src/smithy" ] || { echo "Build control-plane first: (cd $CP_DIR && npx projen build)" >&2; exit 1; }

# tenant-identity ADR-0017: one owner of the shared parameters per account
# and Region. Never take them over from a running deployment.
if aws ssm get-parameter --name "$IDENTITY_NS/topology" >/dev/null 2>&1; then
  echo "$IDENTITY_NS/topology already exists in $AWS_REGION: another tenant-identity deployment owns it. Aborting." >&2
  exit 1
fi
if aws cloudformation describe-stacks --stack-name "$CP_STACK" >/dev/null 2>&1; then
  echo "Stack $CP_STACK already exists in $AWS_REGION. Aborting." >&2
  exit 1
fi

output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# The §3.4 deployment inputs for control-plane.
control_plane_context() {
  local issuer audience source policy
  issuer="$(output "$SETUP_STACK" VendorIdpIssuerUrl)" || return 1
  audience="$(output "$SETUP_STACK" VendorIdpAudience)" || return 1
  source="$(output "$SETUP_STACK" ScriptSourceLocation)" || return 1
  policy="$(aws ssm get-parameter --name "$IDENTITY_NS/platformInvokePolicyArn" --query Parameter.Value --output text)" || return 1
  CP_CONTEXT=(
    --context "vendorIdpIssuerUrl=$issuer"
    --context "vendorIdpAudience=$audience"
    --context "cellDefinition=$(jq -nc --arg loc "$source" '{
      source: {type: "S3", location: $loc},
      cellScripts: {create: "control-plane/cell/create.sh", update: "control-plane/cell/update.sh", delete: "control-plane/cell/delete.sh"},
      tenantScripts: {create: "control-plane/tenant/create.sh", update: "control-plane/tenant/update.sh", delete: "control-plane/tenant/delete.sh"},
      maxTenants: 2}')"
    --context "tenantBuildManagedPolicyArns=$(jq -nc --arg p "$policy" '[$p]')"
  )
}

# The leftover checks (scripts/integ-lib.sh) scope their tag- and name-based
# searches to the tenant-identity stacks of this run.
STACKS=(TenantIdentity-shared-pool)

# shellcheck source-path=SCRIPTDIR
# shellcheck source=integ-lib.sh
source "$SAMPLE_DIR/scripts/integ-lib.sh"

# Fills ARRAY (by name) with the physical ids of TYPE across the stacks in
# "$@", captured BEFORE the destroy. Always returns 0: it runs inside the
# EXIT trap under set -e, where a stack that is already gone must not abort
# the teardown.
capture_resources() {
  local -n out="$1"; local type="$2"; shift 2
  local stack id
  for stack in "$@"; do
    while IFS= read -r id; do
      [ -z "$id" ] || out+=("$id")
    done <<<"$(stack_resources "$stack" "$type")"
  done
  return 0
}

# Deletes the leftover log groups in "$@"; prints the ones it could not delete.
delete_log_groups() {
  local g
  for g in "$@"; do
    [ -n "$g" ] || continue
    aws logs delete-log-group --log-group-name "$g" 2>/dev/null || echo "$g"
  done
}

# Deletes the parameters in "$@" (names); prints the ones it could not delete.
delete_parameters() {
  local p
  for p in "$@"; do
    [ -n "$p" ] || continue
    aws ssm delete-parameter --name "$p" 2>/dev/null || echo "$p"
  done
}

# Runs from the EXIT trap, so every AWS call in here is guarded: a throttle
# or a denied call records status=1 and the remaining checks still run.
destroy() {
  local status=$?
  trap - EXIT
  # What a clean destroy must leave no trace of. Read before the stacks go.
  local identity_log_groups=() cp_log_groups=() pools=() apis=()
  capture_resources identity_log_groups AWS::Logs::LogGroup TenantIdentity-shared-pool
  capture_resources cp_log_groups AWS::Logs::LogGroup "$CP_STACK"
  capture_resources pools AWS::Cognito::UserPool "$CP_STACK" "$SETUP_STACK" TenantIdentity-shared-pool
  capture_resources apis AWS::ApiGateway::RestApi "$CP_STACK" "$SETUP_STACK" TenantIdentity-shared-pool

  echo "=== destroy ($(date -u +%H:%M:%S) UTC)"
  if aws cloudformation describe-stacks --stack-name "$CP_STACK" >/dev/null 2>&1; then
    if [ "${#CP_CONTEXT[@]}" -eq 0 ] && ! control_plane_context; then
      echo "Could not read the control-plane context; run 'cd $CP_DIR && npx cdk destroy $CP_STACK --force' with the §3.4 context by hand" >&2
      status=1
    elif ! (cd "$CP_DIR" && npx cdk destroy "$CP_STACK" --force "${CP_CONTEXT[@]}"); then
      echo "control-plane destroy failed; run 'cd $CP_DIR && npx cdk destroy $CP_STACK --force' with the same context" >&2
      status=1
    fi
  fi
  if ! "${CDK[@]}" destroy --all --force --concurrency 2; then
    echo "Destroy failed: run 'AWS_REGION=$AWS_REGION ${CDK[*]} destroy --all --force --concurrency 2' again" >&2
    status=1
  fi

  echo "=== leftovers ($(date -u +%H:%M:%S) UTC)"
  local stack left ns params leftovers failed
  for stack in "$CP_STACK" "$SETUP_STACK" TenantIdentity-shared-pool; do
    left="$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
    if [ -n "$left" ] && [ "$left" != DELETE_COMPLETE ]; then
      echo "Leftover stack $stack ($left)" >&2
      status=1
    fi
  done

  # Parameters. A leftover parked password (/application-plane/tenants/*) is
  # a SecureString holding a temporary password: delete it, but the run still
  # fails, because a clean teardown would not have left it.
  for ns in /application-plane /control-plane; do
    params="$(aws ssm get-parameters-by-path --path "$ns" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' || true)"
    if [ -n "$params" ] && [ "$params" != "None" ]; then
      echo "Leftover parameter(s) under $ns:" >&2
      echo "$params" >&2
      status=1
      # shellcheck disable=SC2046  # names carry no whitespace
      failed="$(delete_parameters $(grep '^/application-plane/tenants/' <<<"$params" || true))"
      [ -z "$failed" ] || echo "Could not delete leftover parameter(s): $failed" >&2
    fi
  done

  # Pools (ADR-0022): the tag-based search integ.sh uses, plus the ids this
  # run's stacks owned (covers the setup stack's untagged vendor IdP).
  leftovers="$(leftover_pools || true)"
  if [ -n "$leftovers" ]; then
    echo "Leftover user pool(s) tagged ${SAMPLE_TAG_KEY}=${SAMPLE_TAG_VALUE} (ADR-0022):" >&2
    echo "$leftovers" >&2
    status=1
  fi
  if [ "${#pools[@]}" -gt 0 ]; then
    leftovers="$(leftover_pool_ids "${pools[@]}" || true)"
    if [ -n "$leftovers" ]; then
      echo "Leftover user pool(s) from the integ stacks:" >&2
      echo "$leftovers" >&2
      status=1
    fi
  fi

  # REST APIs: the stack-scoped shell-API orphan integ.sh looks for, plus the
  # ids this run's stacks owned. Orphans are deleted; the run still fails.
  leftovers="$(leftover_rest_apis || true)"
  if [ "${#apis[@]}" -gt 0 ]; then
    leftovers="$(printf '%s\n%s' "$leftovers" "$(leftover_rest_api_ids "${apis[@]}" || true)" | tr '\t' ' ' | sed '/^$/d' | sort -u)"
  fi
  if [ -n "$leftovers" ]; then
    echo "Leftover REST API(s) from the integ stacks:" >&2
    echo "$leftovers" >&2
    status=1
    delete_leftover_rest_apis "$leftovers" || status=1
  fi

  # Log groups. The setup stack's functions are test scaffolding whose log
  # groups Lambda creates on first invoke, outside CloudFormation. Remove them.
  local setup_groups
  setup_groups="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${SETUP_STACK}-" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' || true)"
  if [ -n "$setup_groups" ] && [ "$setup_groups" != "None" ]; then
    # shellcheck disable=SC2086  # log group names carry no whitespace
    failed="$(delete_log_groups $setup_groups)"
    if [ -n "$failed" ]; then
      echo "Could not delete setup log group(s): $failed" >&2
      status=1
    fi
  fi
  # A tenant-identity log group that exists after its stack is gone was
  # recreated by a writer during teardown; the stack's log drain (ADR-0024)
  # exists to prevent exactly that, so it fails the run.
  if [ "${#identity_log_groups[@]}" -gt 0 ]; then
    leftovers="$(leftover_log_groups "${identity_log_groups[@]}" || true)"
    if [ -n "$leftovers" ]; then
      echo "Leftover tenant-identity log group(s) recreated during teardown (ADR-0024):" >&2
      echo "$leftovers" >&2
      status=1
    fi
  fi
  # control-plane has no log drain, so its API access log group is recreated
  # while the stack is being deleted (known control-plane issue, recorded in
  # the README). That is control-plane's bug, not this mount's: delete the
  # group(s) and warn, without failing the run.
  if [ "${#cp_log_groups[@]}" -gt 0 ]; then
    leftovers="$(leftover_log_groups "${cp_log_groups[@]}" || true)"
    if [ -n "$leftovers" ]; then
      echo "WARNING: control-plane log group(s) recreated during teardown (known control-plane issue: no log drain like tenant-identity ADR-0024); deleting:" >&2
      echo "$leftovers" >&2
      # shellcheck disable=SC2086  # log group names carry no whitespace
      failed="$(delete_log_groups $leftovers)"
      if [ -n "$failed" ]; then
        echo "Could not delete control-plane log group(s): $failed" >&2
        status=1
      fi
    fi
  fi

  [ "$status" -ne 0 ] || echo "No leftover stack, parameter, pool, REST API or log group. AdminPasswordKey stays pending deletion for 7 days (ADR-0033)."
  echo "=== done ($(date -u +%H:%M:%S) UTC), exit $status"
  exit "$status"
}

echo "=== synth ($(date -u +%H:%M:%S) UTC)"
rm -rf "$OUT"
npx cdk synth --quiet --output "$OUT" \
  --app "npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ.control-plane.ts"

trap destroy EXIT

echo "=== deploy tenant-identity + setup ($(date -u +%H:%M:%S) UTC)"
"${CDK[@]}" deploy --all --concurrency 2 --require-approval never --progress events

echo "=== deploy control-plane ($(date -u +%H:%M:%S) UTC)"
control_plane_context
(cd "$CP_DIR" && npx cdk deploy "$CP_STACK" --require-approval never --progress events "${CP_CONTEXT[@]}")

echo "=== scenario ($(date -u +%H:%M:%S) UTC)"
npx jest --config test/e2e/control-plane/jest.config.json
