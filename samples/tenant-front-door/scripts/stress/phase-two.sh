#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress slice, `step phase-two` (platform mode only; stress spec §3.5 step 6,
# stress ADR-0016). Once the control plane has built the first cell:
#
#   1. the driver (`ingress`) assumes the cell account's ingress reader role with
#      the run's own credentials, in memory only, reads the cell's published
#      ingress parameter and prints the ingress base URL (no secret)
#   2. the main stack is redeployed alone (`--exclusively`) with `agentIngress`
#      set to it and `registrarUrl` kept: a CloudFront distribution update
#   3. the driver (`await-agents`) polls the edge until `/agents/*` is routed
#      (an unsigned token for a made-up tenant gets the router's 403, not 404),
#      for up to 10 minutes
#   4. `tenant-front-door.json` is rewritten with `phase: 2` and `agentIngressUrl`
#
# Prints `phase two: <n> s` and `stack=<main> deploy_seconds=<n> phase=two`; the
# runner adds this step's time to the slice's deploy seconds. Running it again
# with the same ingress changes nothing in the stack.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: ${tool}"
done
[[ -s "$FD_MANIFEST" ]] || fail "${FD_MANIFEST} is missing: the tenant-front-door slice's deploy writes it; run that first"
[[ -s "$CONTEXT" ]] || fail "${CONTEXT} is missing: the tenant-front-door slice's deploy writes it; run that first"
jq -e '.registrarUrl // empty | length > 0' "$CONTEXT" >/dev/null || fail "${CONTEXT} has no registrarUrl: phase one did not finish"
cd "$SAMPLE_DIR"
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

driver() { (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts "$@"); }

# 1. The ingress base URL of the cell: the driver prints it alone on stdout.
INGRESS="$(driver ingress)" || fail "could not read the cell's ingress parameter (see the message above)"
[[ "$INGRESS" =~ ^https://[a-z0-9.-]+(/[A-Za-z0-9._~-]+)*$ ]] || fail "the ingress base URL the driver printed is not an https URL with a plain path"
echo "phase two: agentIngress ${INGRESS}"

# 2. The main stack alone, with agentIngress.
jq --arg i "$INGRESS" '. + {agentIngress: $i}' "$CONTEXT" | json_private "$CONTEXT"
start=$SECONDS
deploy_stack "$STACK_MAIN" fd "phase=two"
echo "phase two: $((SECONDS - start)) s"

# 3. The edge routes /agents/* once the distribution has the origin: a distribution update takes minutes.
driver await-agents

# 4. The manifest the other slices read.
jq --arg i "$INGRESS" '. + {phase: 2, agentIngressUrl: $i}' "$FD_MANIFEST" | json_private "$FD_MANIFEST"
echo "phase two: ${FD_MANIFEST} is at phase 2"
