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
  issuer="$(output "$SETUP_STACK" VendorIdpIssuerUrl)"
  audience="$(output "$SETUP_STACK" VendorIdpAudience)"
  source="$(output "$SETUP_STACK" ScriptSourceLocation)"
  policy="$(aws ssm get-parameter --name "$IDENTITY_NS/platformInvokePolicyArn" --query Parameter.Value --output text)"
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

# Log group names a stack owns right now, captured BEFORE the destroy.
stack_log_groups() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' || true
}

destroy() {
  local status=$?
  trap - EXIT
  local log_groups=() stack
  for stack in "$CP_STACK" TenantIdentity-shared-pool; do
    while IFS= read -r line; do [ -n "$line" ] && log_groups+=("$line"); done <<<"$(stack_log_groups "$stack")"
  done
  echo "=== destroy ($(date -u +%H:%M:%S) UTC)"
  if aws cloudformation describe-stacks --stack-name "$CP_STACK" >/dev/null 2>&1; then
    [ "${#CP_CONTEXT[@]}" -gt 0 ] || control_plane_context
    if ! (cd "$CP_DIR" && npx cdk destroy "$CP_STACK" --force "${CP_CONTEXT[@]}"); then
      echo "control-plane destroy failed; run 'cd $CP_DIR && npx cdk destroy $CP_STACK --force' with the same context" >&2
      status=1
    fi
  fi
  if ! "${CDK[@]}" destroy --all --force --concurrency 2; then
    echo "Destroy failed: run 'AWS_REGION=$AWS_REGION ${CDK[*]} destroy --all --force --concurrency 2' again" >&2
    status=1
  fi

  echo "=== leftovers ($(date -u +%H:%M:%S) UTC)"
  local stack left params
  for stack in "$CP_STACK" "$SETUP_STACK" TenantIdentity-shared-pool; do
    left="$(aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
    if [ -n "$left" ] && [ "$left" != DELETE_COMPLETE ]; then
      echo "Leftover stack $stack ($left)" >&2
      status=1
    fi
  done
  for ns in /application-plane /control-plane; do
    params="$(aws ssm get-parameters-by-path --path "$ns" --recursive --query 'Parameters[].Name' --output text)"
    if [ -n "$params" ]; then
      echo "Leftover parameter(s) under $ns: $params" >&2
      status=1
    fi
  done
  # The setup stack's functions are test scaffolding whose log groups Lambda
  # creates on first invoke, outside CloudFormation. Remove them.
  local g
  for g in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${SETUP_STACK}-" \
      --query 'logGroups[].logGroupName' --output text); do
    aws logs delete-log-group --log-group-name "$g"
  done
  # A stack-owned log group that exists after its stack is gone was recreated
  # by a writer during teardown (tenant-identity ADR-0024). That fails the run.
  for g in "${log_groups[@]}"; do
    if [ -n "$(aws logs describe-log-groups --log-group-name-prefix "$g" \
        --query "logGroups[?logGroupName=='${g}'].logGroupName" --output text)" ]; then
      echo "Leftover log group $g (recreated during teardown)" >&2
      status=1
    fi
  done
  [ "$status" -ne 0 ] || echo "No leftover stack, parameter or log group. AdminPasswordKey stays pending deletion for 7 days (ADR-0033)."
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
