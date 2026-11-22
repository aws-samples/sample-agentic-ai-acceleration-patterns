#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared by deploy.sh and teardown.sh of the front-door stress slice: the
# names the stacks take from the run prefix, the paths of the slice's state,
# and the CDK invocations. Sourced, never run. Prints ids and seconds only,
# never a token, a password or a key, and never runs `set -x`
# (scripts/CONVENTIONS.md): the runner writes this output to run.log.

# shellcheck disable=SC2034 # the sourcing scripts read these

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${STRESS_PREFIX:?STRESS_PREFIX is not set}"
: "${STRESS_HOME:?STRESS_HOME is not set}"
: "${AWS_REGION:?set AWS_REGION to the Region of the stress account}"
export AWS_DEFAULT_REGION="$AWS_REGION"

PREFIX="$STRESS_PREFIX"
PREFIX_LOWER="$(printf '%s' "$PREFIX" | tr '[:upper:]' '[:lower:]')"
EDGE_REGION=us-east-1
PARAM_EDGE=/application-plane/shared/front-door/edge
IDENTITY_PREFIX=/application-plane/shared/identity
# tenant-identity may be deployed in another Region than the front door (one front door per Region and account, spec §6.4).
IDENTITY_REGION="${STRESS_FD_IDENTITY_REGION:-$AWS_REGION}"
CELL_ID=01KAF5M0000000000000000C01
APPLICATION_ID="tfd-${PREFIX_LOWER}"
FLEET="$PREFIX_LOWER"

STATE_DIR="${STRESS_HOME}/${PREFIX}/tenant-front-door"
OUTPUTS="${STATE_DIR}/outputs.json"
CONTEXT="${STATE_DIR}/context.json"
RESOURCES="${STATE_DIR}/resources.json"
TIMINGS="${STATE_DIR}/timings.txt"
CONCURRENCY="${INTEG_DEPLOY_CONCURRENCY:-2}"

STACK_SUPPORT="${PREFIX}-support"
STACK_CP="${PREFIX}-control-plane"
STACK_CELL="${PREFIX}-cell"
STACK_EDGE="${PREFIX}-edge"
STACK_MAIN="${PREFIX}-main"
STACK_LOGGING="${PREFIX}-edge-logging"
# Platform mode only: the hook parameter and policy, in the control plane's account (front-door ADR-0027).
STACK_HOOK="${PREFIX}-route-hook-access"

# The manifests of the platform run (stress/README.md), beside the slice's own state directory.
MANIFEST_DIR="${STRESS_HOME}/${PREFIX}"
FD_MANIFEST="${MANIFEST_DIR}/tenant-front-door.json"

# The CDK selects a stack by its construct path, not by its stack name (the construct id is the prefix, src/main.ts).
fd_selector() {
  case "$1" in
    "$STACK_EDGE") echo "${PREFIX}/Edge" ;;
    "$STACK_MAIN") echo "${PREFIX}/Main" ;;
    "$STACK_LOGGING") echo "${PREFIX}/EdgeLogging" ;;
    "$STACK_HOOK") echo "${PREFIX}/RouteHookAccess" ;;
    *) fail "no front door stack named $1" ;;
  esac
}

SMOKE_APP="npx ts-node -P test/tsconfig.json --prefer-ts-exts test/smoke/smoke.app.ts"

fail() { echo "slice: $*" >&2; exit 1; }

# Region of each stack: the edge stacks are in us-east-1 (ADR-0010), the rest in AWS_REGION.
stack_region() {
  case "$1" in
    "$STACK_EDGE" | "$STACK_LOGGING") echo "$EDGE_REGION" ;;
    *) echo "$AWS_REGION" ;;
  esac
}

# True unless CloudFormation says the stack does not exist: an AWS error
# (credentials, throttle, network) counts as "still there".
stack_exists() {
  local err
  if err="$(aws cloudformation describe-stacks --region "$(stack_region "$1")" --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>&1 >/dev/null)"; then
    return 0
  fi
  ! grep -q 'does not exist' <<<"$err"
}

# present NAME VALUE: the value, or a failure when AWS or jq gave none (the CLI prints `None` or `null` for a missing value).
present() {
  if [[ -z "$2" || "$2" == None || "$2" == null ]]; then
    echo "slice: ${1} is missing" >&2
    return 1
  fi
  printf '%s' "$2"
}

stack_output() { # STACK KEY
  local v
  v="$(aws cloudformation describe-stacks --region "$(stack_region "$1")" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text)" || return 1
  present "output $2 of $1" "$v"
}

param() { # NAME [REGION]
  local v
  v="$(aws ssm get-parameter --region "${2:-$AWS_REGION}" --name "$1" --query Parameter.Value --output text)" || return 1
  present "parameter $1" "$v"
}

resource() { # STACK TYPE -> physical id of the first resource of that type
  local v
  v="$(aws cloudformation describe-stack-resources --region "$(stack_region "$1")" --stack-name "$1" \
    --query "StackResources[?ResourceType=='$2'].PhysicalResourceId | [0]" --output text)" || return 1
  present "resource $2 of $1" "$v"
}

# The CDK context of the front door stacks, from context.json (written by deploy.sh).
fd_context_args() {
  FD_CONTEXT=()
  local k
  for k in appDomain hostedZone applicationId controlPlane dedicatedDomains fleet edgeOperatorRoleArn issuer stackNamePrefix; do
    FD_CONTEXT+=(--context "${k}=$(jq -r --arg k "$k" '.[$k] | if type == "string" then . else tojson end' "$CONTEXT")")
  done
  # Platform mode adds these two to context.json (slice mode never does): `registrarUrl` after phase one, `agentIngress` at phase two.
  for k in registrarUrl agentIngress; do
    if jq -e --arg k "$k" 'has($k)' "$CONTEXT" >/dev/null; then
      FD_CONTEXT+=(--context "${k}=$(jq -r --arg k "$k" '.[$k]' "$CONTEXT")")
    fi
  done
}

# The CDK context of the smoke app's stacks.
smoke_context_args() {
  SMOKE_CONTEXT=(--context "smokePrefix=${PREFIX}" --context "smokeFleet=${FLEET}")
  # The real control plane owns the global hook role of a platform run.
  if [[ "${STRESS_MODE:-slice}" == platform ]]; then
    SMOKE_CONTEXT+=(--context "smokeHookRole=false")
  fi
  if [[ -s "$CONTEXT" ]] && [[ "$(jq -r '.distributionArn // empty' "$CONTEXT")" != "" ]]; then
    SMOKE_CONTEXT+=(
      --context "distributionArn=$(jq -r .distributionArn "$CONTEXT")"
      --context "cellIssuer=$(jq -r .cellIssuer "$CONTEXT")"
      --context "cellClientId=$(jq -r .cellClientId "$CONTEXT")"
      --context "applicationId=${APPLICATION_ID}"
      --context "cellId=${CELL_ID}"
    )
  fi
}

# deploy_stack STACK APP_KIND [NOTE]: one CDK deploy of one stack, timed. APP_KIND is `smoke` (the smoke app) or `fd` (the
# front door app). NOTE, when given, ends the printed line (platform mode: `phase=two`). The caller sets LOGS to a scratch
# folder; a failed deploy prints the last lines of its log.
deploy_stack() {
  local stack="$1" kind="$2" note="${3:-}" start=$SECONDS secs
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
  echo "stack=${stack} deploy_seconds=${secs}${note:+ ${note}}"
  echo "$(date -u +%F) stack=${stack} deploy_seconds=${secs}${note:+ ${note}}" >>"$TIMINGS"
}

# json_private FILE: reads JSON on stdin and writes it to FILE with mode 0600, by way of a temporary file, so a reader never sees half a file.
json_private() {
  local file="$1"
  (umask 077; cat >"${file}.new")
  chmod 600 "${file}.new"
  mv "${file}.new" "$file"
}

# manifest_field FILE PRODUCER JQ_PATH: the string at JQ_PATH of a manifest another slice wrote, or a failure that names the file and that slice.
manifest_field() {
  local file="$1" producer="$2" path="$3" v
  [[ -s "$file" ]] || fail "${file} is missing: the ${producer} slice writes it; run that slice's set-up first"
  v="$(jq -r "${path} // empty | if type == \"string\" then . else empty end" "$file")" || fail "${file} is not JSON"
  [[ -n "$v" ]] || fail "${file}: ${path} is missing or not a string (the ${producer} slice writes it)"
  printf '%s' "$v"
}
