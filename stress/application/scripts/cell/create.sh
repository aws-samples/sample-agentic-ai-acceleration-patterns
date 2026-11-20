#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application cell CREATE (and UPDATE) script (spec §3.3, step 2; stress ADR-0012).
#
# Runs in the control plane's cell CodeBuild project with APPLICATION_ID, CELL_ID,
# CELL_ACCOUNT_ID, OPERATION, OUTPUTS_FILE and PARAM_CELL_POLICY_SUFFIX, under the cell
# account's role pair cell role (control-plane ADR-0025). That role holds the SSM namespace
# grants and cell-build-policy, which lets it assume the deploy and publishing roles of the
# account's cell bootstrap (control-plane ADR-0047), and nothing else.
#
# It deploys one runtime-isolation cell, `StressCell-<cell id>`, from the source the control
# plane fetched (the repository at the pinned commit): installs the sample, synthesises
# stress/application/cell-app.ts (every role on /cell/ under the workload boundary, qualifier
# `cell`) and deploys it through CDKToolkit-cell. Then it publishes the cell's stack name and
# its Entitlements API URL under /application-plane/cells/<cell id>/ for the tenant scripts.
# It prints timings and the build container's peak memory (spec Q-1), never a value.
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${CELL_ACCOUNT_ID:?CELL_ACCOUNT_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"

# shellcheck source=../lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

caller="$(aws sts get-caller-identity --query Account --output text)"
if [ "$caller" != "$CELL_ACCOUNT_ID" ]; then
  echo "Running in account ${caller}, not the cell's account ${CELL_ACCOUNT_ID}: refusing"
  exit 1
fi

STACK="$(node -e 'const id = process.argv[1]; if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) process.exit(1); console.log(`StressCell-${id}`)' "$CELL_ID")"
echo "Cell ${CELL_ID} of ${APPLICATION_ID} (${OPERATION:-CREATE}): stack ${STACK} in ${CELL_ACCOUNT_ID}"
echo "memory_total_mib=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo) cpus=$(nproc)"

ensure_node
install_sample

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
CDK="${SAMPLE_DIR}/node_modules/.bin/cdk"
TS_NODE="${SAMPLE_DIR}/node_modules/.bin/ts-node"
# One copy of the CDK: everything cell-app.ts imports resolves in the sample (cell-app.ts).
export NODE_PATH="${SAMPLE_DIR}/node_modules"
export CELL_POLICY_SUFFIX="${PARAM_CELL_POLICY_SUFFIX:-}"

start=$SECONDS
(cd "$SAMPLE_DIR" && "$CDK" synth --app "${TS_NODE} -T -P ${SAMPLE_DIR}/tsconfig.json ${STRESS_APP_DIR}/cell-app.ts" \
  --output "${OUT}/cdk.out" --quiet > /dev/null)
echo "cell_synth_seconds=$((SECONDS - start)) peak_memory_mib=$(peak_memory_mib)"

start=$SECONDS
(cd "$SAMPLE_DIR" && "$CDK" deploy "$STACK" --app "${OUT}/cdk.out" --toolkit-stack-name CDKToolkit-cell \
  --require-approval never --progress events --outputs-file "${OUT}/outputs.json")
echo "cell_deploy_seconds=$((SECONDS - start)) peak_memory_mib=$(peak_memory_mib)"

entitlements="$(node -e 'const o = require(process.argv[1])[process.argv[2]] ?? {}; if (!o.EntitlementsApiUrl) process.exit(1); console.log(o.EntitlementsApiUrl)' "${OUT}/outputs.json" "$STACK")"
put_param "$(cell_param stack)" "$STACK"
put_param "$(cell_param entitlements-api-url)" "$entitlements"

# Outputs for the post hooks (control-plane R-43): the stack name only.
if [ -n "${OUTPUTS_FILE:-}" ]; then
  printf '{"stackName":"%s"}\n' "$STACK" > "$OUTPUTS_FILE"
fi
echo "Cell ${CELL_ID} ready"
