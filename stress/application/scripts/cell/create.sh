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
# `cell`) and deploys it through CDKToolkit-cell. Then it publishes, under
# /application-plane/cells/<cell id>/, the cell's stack name and its Entitlements API URL for
# the tenant scripts and, with a distribution ARN (platform mode), the cell API's host as
# `api-domain`.
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

STACK="$(node -e 'const id = process.argv[1]; if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) process.exit(1); console.log(`StressCell-${id}`)' "$CELL_ID")" || {
  echo "CELL_ID is not a ULID: refusing" >&2
  exit 1
}
echo "Cell ${CELL_ID} of ${APPLICATION_ID} (${OPERATION:-CREATE}): stack ${STACK} in ${CELL_ACCOUNT_ID}"
echo "memory_total_mib=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo) cpus=$(nproc)"

# Platform mode (spec §3.3, step 2): the cell parameter DISTRIBUTION_ARN, the tenant front
# door's edge distribution, adds the cell API origin; empty is slice mode, nothing added.
# The cell API trusts the stress identity the account base names, read here and passed to
# the app; nothing is logged but the parameter names.
DISTRIBUTION_ARN="${PARAM_DISTRIBUTION_ARN:-}"
if [ -n "$DISTRIBUTION_ARN" ]; then
  if ! [[ "$DISTRIBUTION_ARN" =~ ^arn:aws[a-z-]*:cloudfront::[0-9]{12}:distribution/[A-Z0-9]{8,32}$ ]]; then
    echo "PARAM_DISTRIBUTION_ARN is not a CloudFront distribution ARN: refusing" >&2
    exit 1
  fi
  IDENTITY_USER_POOL_ID="$(get_param /application-plane/shared/identity/userPoolId)"
  IDENTITY_APP_CLIENT_ID="$(get_param /application-plane/shared/identity/appClientId)"
  echo "Read /application-plane/shared/identity/userPoolId and appClientId; the cell gets a cell API for the distribution"
  export DISTRIBUTION_ARN IDENTITY_USER_POOL_ID IDENTITY_APP_CLIENT_ID
fi

ensure_node
install_sample
if [ -n "$DISTRIBUTION_ARN" ]; then
  link_front_door_modules
fi

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
# The deploy's own output holds the cell's stack outputs (the issuer with its user pool id,
# every URL, role ARNs): it goes to a file in the scratch folder, and the log gets the
# timing, and on a failure the failed resources by logical id and status only.
if ! (cd "$SAMPLE_DIR" && "$CDK" deploy "$STACK" --app "${OUT}/cdk.out" --toolkit-stack-name CDKToolkit-cell \
  --require-approval never --progress events --outputs-file "${OUT}/outputs.json" > "${OUT}/deploy.log" 2>&1); then
  echo "cdk deploy of ${STACK} failed after $((SECONDS - start)) s; failed resources:"
  grep -E '_FAILED' "${OUT}/deploy.log" | awk -F'|' 'NF >= 6 {print "  " $4 "|" $5 "|" $6}' | sed -E 's/ \(.*$//' | sort -u | head -20 || true
  exit 1
fi
echo "cell_deploy_seconds=$((SECONDS - start)) peak_memory_mib=$(peak_memory_mib)"

entitlements="$(node -e 'const o = require(process.argv[1])[process.argv[2]] ?? {}; if (!o.EntitlementsApiUrl) process.exit(1); console.log(o.EntitlementsApiUrl)' "${OUT}/outputs.json" "$STACK")"
put_param "$(cell_param stack)" "$STACK"
put_param "$(cell_param entitlements-api-url)" "$entitlements"

# Platform mode: the cell API's host, for the control-plane driver and the route hook (spec §5.2).
# Only a Lambda function URL host of this Region is published.
if [ -n "$DISTRIBUTION_ARN" ]; then
  api_domain="$(node -e 'const o = require(process.argv[1])[process.argv[2]] ?? {}; if (!o.FrontDoorApiDomain) process.exit(1); console.log(o.FrontDoorApiDomain)' "${OUT}/outputs.json" "$STACK")"
  if ! [[ "$api_domain" =~ ^[a-z0-9]{32}\.lambda-url\.${AWS_REGION}\.on\.aws$ ]]; then
    echo "FrontDoorApiDomain is not a Lambda function URL host in ${AWS_REGION}: refusing" >&2
    exit 1
  fi
  put_param "$(cell_param api-domain)" "$api_domain"
fi

# Outputs for the post hooks (control-plane R-43): the stack name, and in platform mode the
# cell API's host (spec §5.2). One JSON object of strings; the host passed the check above.
if [ -n "${OUTPUTS_FILE:-}" ]; then
  if [ -n "$DISTRIBUTION_ARN" ]; then
    printf '{"stackName":"%s","frontDoorApiDomain":"%s"}\n' "$STACK" "$api_domain" > "$OUTPUTS_FILE"
  else
    printf '{"stackName":"%s"}\n' "$STACK" > "$OUTPUTS_FILE"
  fi
fi
echo "Cell ${CELL_ID} ready"
