#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 1: deploy the stress stacks (design/agentic-runtime-isolation.stress-test.md §8.3).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small|medium|large] [STRESS_PREFIX=RuntimeIsolationStress] scripts/stress/deploy.sh
#
# 1. Checks the shared tenant-identity deployment is published (shared-pool,
#    with the scope catalogue). It never deploys or destroys it.
# 2. Synthesises test/stress.runtime.ts into cdk.stress.out with
#    STRESS_AGENTS=false STRESS_DRIVER=false and deploys <prefix>-ingress.
# 3. Synthesises again with both on (the agents stacks look up the document
#    the ingress stack published) and deploys the agents stacks one at a
#    time, then <prefix>-driver.
#
# Prints one `stack=<name> deploy_seconds=<n>` line per stack and the
# ingress stack's PolicySecondsToActive* outputs. The stack outputs are
# merged into ~/.runtime-isolation-stress/<prefix>/outputs.json (keyed by
# output name) for the other scripts. Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap.
# shellcheck disable=SC2329

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region to deploy in (e.g. export AWS_REGION=eu-central-1)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SAMPLE_DIR"
SCALE="${STRESS_SCALE:-small}"
[[ "$SCALE" =~ ^(small|medium|large)$ ]] || { echo "STRESS_SCALE must be small, medium or large (got '${SCALE}')" >&2; exit 1; }
PREFIX="${STRESS_PREFIX:-RuntimeIsolationStress}"
[[ "$PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 1; }
STATE_DIR="${HOME}/.runtime-isolation-stress/${PREFIX}"
OUTPUTS="${STATE_DIR}/outputs.json"
TIMINGS="${STATE_DIR}/timings.txt"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

LIB_TMP="$(mktemp -d)"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"
cleanup() {
  local code=$?
  rm -rf "$LIB_TMP"
  (( code == 0 )) || echo "deploy.sh failed (exit ${code}); stacks already deployed stay up: run scripts/stress/teardown.sh to remove them" >&2
  exit "$code"
}
trap cleanup EXIT

OUT="cdk.stress.out"
STRESS_APP="npx ts-node -P tsconfig.json --prefer-ts-exts test/stress.runtime.ts"
CDK=(npx cdk --app "$OUT")

echo "scale=${SCALE} prefix=${PREFIX} region=${REGION} started=$(date -u +%FT%TZ)"

# -- 1. the shared identity deployment (reused, never deployed here) --------
aws ssm get-parameter --name "${IDENTITY_PREFIX}/apiUrl" --query Parameter.Name --output text >/dev/null 2>&1 \
  || fail "tenant-identity is not published (${IDENTITY_PREFIX}/apiUrl missing). Deploy TenantIdentity-shared-pool from ../tenant-identity by hand first; this script never deploys or destroys it"
identity_init
status="$(scope_catalogue_status)"
if [[ "$status" != 200 ]]; then
  stale_identity "$status" && fail "the published tenant-identity has no /platform/scopes (stale). Redeploy TenantIdentity-shared-pool in place from current main by hand; this script never replaces it"
  fail "GET /platform/scopes on the published tenant-identity: HTTP ${status}"
fi
status="$(platform GET "platform/scopes/$(jq -rn '"app/use" | @uri')")"
[[ "$status" == 200 ]] || fail "the vendor scope app/use is not registered on tenant-identity (HTTP ${status}); an integ run registers it, or PUT platform/scopes/app%2Fuse by hand"
echo "identity: shared-pool with the scope catalogue and app/use (reused)"

# -- helpers ----------------------------------------------------------------
synth() { # AGENTS DRIVER
  rm -rf "$OUT"
  STRESS_SCALE="$SCALE" STRESS_PREFIX="$PREFIX" STRESS_AGENTS="$1" STRESS_DRIVER="$2" \
    npx cdk synth -q --app "$STRESS_APP" --output "$OUT" >"${LIB_TMP}/synth.log" 2>&1 \
    || { tail -30 "${LIB_TMP}/synth.log" >&2; fail "synth (STRESS_AGENTS=$1 STRESS_DRIVER=$2)"; }
}

# merge_outputs STACK: adds the stack's outputs to outputs.json, keyed by output name.
merge_outputs() {
  local outs="${LIB_TMP}/stack-outputs.json"
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].Outputs' --output json >"$outs" \
    || fail "describe-stacks $1"
  [[ -s "$OUTPUTS" ]] || echo '{}' >"$OUTPUTS"
  jq -s '.[0] + ((.[1] // []) | map({key: .OutputKey, value: .OutputValue}) | from_entries)' "$OUTPUTS" "$outs" >"${OUTPUTS}.new"
  mv "${OUTPUTS}.new" "$OUTPUTS"
  chmod 600 "$OUTPUTS"
}

deploy_stack() { # STACK
  local start=$SECONDS secs
  echo "== deploy $1"
  "${CDK[@]}" deploy "$1" --exclusively --require-approval never >"${LIB_TMP}/deploy.log" 2>&1 \
    || { grep -E "FAILED|Error|error" "${LIB_TMP}/deploy.log" | tail -30 >&2; tail -15 "${LIB_TMP}/deploy.log" >&2; fail "deploy $1"; }
  secs=$((SECONDS - start))
  echo "stack=$1 deploy_seconds=${secs}"
  echo "$(date -u +%F) scale=${SCALE} stack=$1 deploy_seconds=${secs}" >>"$TIMINGS"
  merge_outputs "$1"
}

# -- 2. the ingress stack ---------------------------------------------------
synth false false
INGRESS_STACK="${PREFIX}-ingress"
[[ -f "${OUT}/${INGRESS_STACK}.template.json" ]] || fail "the stress app did not synthesise ${INGRESS_STACK}"
deploy_stack "$INGRESS_STACK"
echo "== policy seconds to ACTIVE (ADR-0040)"
jq -r 'to_entries[] | select(.key | startswith("PolicySecondsToActive")) | "  \(.key)=\(.value)"' "$OUTPUTS"

# -- 3. the agents stacks (one at a time), then the driver ------------------
synth true true
mapfile -t AGENT_STACKS < <(find "$OUT" -maxdepth 1 -name "${PREFIX}-agents-*.template.json" -printf '%f\n' | sed 's/\.template\.json$//' | sort -V)
for s in "${AGENT_STACKS[@]}"; do deploy_stack "$s"; done
(( ${#AGENT_STACKS[@]} > 0 )) || echo "no agents stacks at scale ${SCALE} (the ingress stack holds every agent)"
DRIVER_STACK="${PREFIX}-driver"
[[ -f "${OUT}/${DRIVER_STACK}.template.json" ]] || fail "the stress app did not synthesise ${DRIVER_STACK}"
deploy_stack "$DRIVER_STACK"

echo "deployed $(( ${#AGENT_STACKS[@]} + 2 )) stacks in ${SECONDS}s; outputs in ${OUTPUTS}"
