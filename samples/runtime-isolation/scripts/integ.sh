#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §8, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#
# SKELETON: the step bodies below are outlined and marked TODO; the first
# green run fills them in and records date, Region and coverage in
# architecture.md. Nothing here runs without AWS credentials.
#
# Flow:
#   1. tenant-identity (shared-pool): reuse an existing deployment if its
#      /application-plane/shared/identity/* parameters exist, else deploy it
#      through its own documented path (ADR-0004; tenant-identity ADR-0017:
#      one publisher per account and Region). Create tenants A and B, users
#      A1, A2, B1; issue tokens (never printed).
#   2. Synthesise test/integ.runtime.ts into its own cloud assembly and deploy
#      both ingress stacks at once (every module on).
#   3..8a. Run the spec §8 steps against each ingress.
#   4a/7/8. Re-deploy the demo app with `session=off`, then with scopes and
#      narrowing off, for the OFF-state checks.
#   9. Latency probe: 20 invocations per ingress, TTFB and total, p50/p95.
#  10. Destroy from the EXIT trap (also on failure); assert nothing is left.
#
# Runs in exactly one Region: AWS_REGION must be set. Deploys into the account
# of the ambient AWS credentials, which must be CDK-bootstrapped there.
# Conventions: scripts/CONVENTIONS.md (no set -x, no token or header value
# in output, mktemp, EXIT trap).

set -euo pipefail

if [ -z "${AWS_REGION:-}" ]; then
  echo "Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)" >&2
  exit 1
fi
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws curl jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAMPLE_DIR"

# A separate cloud assembly so the run never mixes with `cdk.out/` from a
# build, and the deploy and the destroy see exactly the same templates.
OUT="cdk.integ.out"
CDK=(npx cdk --app "$OUT")
STACK_PREFIX="RuntimeIsolationInteg"
PARAM_PREFIX="/application-plane/shared/agent-runtime"
IDENTITY_PREFIX="/application-plane/shared/identity"

WORK="$(mktemp -d)"
DEPLOYED_IDENTITY=0
DEPLOYED_SAMPLE=0
FAILED=0

cleanup() {
  local status=$?
  set +e
  echo "== teardown"
  if [ "$DEPLOYED_SAMPLE" = 1 ]; then
    "${CDK[@]}" destroy --all --force --concurrency 2 >/dev/null 2>&1 || { echo "destroy failed: $STACK_PREFIX stacks" >&2; FAILED=1; }
  fi
  if [ "$DEPLOYED_IDENTITY" = 1 ]; then
    # TODO: destroy tenant-identity through its own path (samples/tenant-identity: cdk destroy TenantIdentity-shared-pool).
    :
  fi
  # Leftover check: stacks, log groups and parameters with the sample's prefix.
  local left
  left="$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED \
    --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}')].StackName" --output text)"
  if [ -n "$left" ]; then echo "leftover stacks: $left" >&2; FAILED=1; fi
  left="$(aws ssm get-parameters-by-path --path "$PARAM_PREFIX" --query 'Parameters[].Name' --output text)"
  if [ -n "$left" ] && [ "$DEPLOYED_SAMPLE" = 1 ]; then echo "leftover parameters under $PARAM_PREFIX" >&2; FAILED=1; fi
  rm -rf "$WORK"
  if [ "$status" -ne 0 ] || [ "$FAILED" -ne 0 ]; then
    echo "integ: FAILED" >&2
    exit 1
  fi
  echo "integ: PASSED"
}
trap cleanup EXIT

step() { echo "== step $1: $2"; }

# --------------------------------------------------------------------------
# 1. tenant-identity (shared-pool), reused or deployed
# --------------------------------------------------------------------------
step 1 "tenant-identity shared-pool"
if aws ssm get-parameter --name "${IDENTITY_PREFIX}/userPoolId" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "reusing the published tenant-identity deployment"
else
  echo "deploying tenant-identity (shared-pool) through its own path"
  # TODO: (cd ../tenant-identity && npx projen build && npx cdk deploy TenantIdentity-shared-pool --context topology=shared-pool --require-approval never)
  DEPLOYED_IDENTITY=1
fi
# TODO: create tenants A and B and users A1, A2, B1 through tenant-identity's
# platform API (SigV4), set permanent passwords, and obtain access tokens into
# shell variables TOKEN_A1, TOKEN_A2, TOKEN_B1 (never echoed). Also a token
# narrowed to tenant-api/read via POST /oauth2/token (tenant-identity ADR-0009).

# --------------------------------------------------------------------------
# 2. Deploy both ingress stacks (every module on)
# --------------------------------------------------------------------------
step 2 "synth and deploy ${STACK_PREFIX}-{api-gateway,agentcore-gateway}"
rm -rf "$OUT"
npx cdk synth -q --app "npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.runtime.ts" --output "$OUT" >/dev/null
DEPLOYED_SAMPLE=1
"${CDK[@]}" deploy --all --require-approval never --concurrency 2 --outputs-file "$WORK/outputs.json" >/dev/null
# TODO: seed the demo tables: one item per tenant, PK=TENANT#tenant-a / TENANT#tenant-b.

for INGRESS in api-gateway agentcore-gateway; do
  echo "---- ingress: $INGRESS"
  ENDPOINT="$(jq -r ".\"${STACK_PREFIX}-${INGRESS}\".EndpointUrl" "$WORK/outputs.json")"
  RUNTIME_ARN="$(jq -r ".\"${STACK_PREFIX}-${INGRESS}\".RuntimeArn" "$WORK/outputs.json")"
  : "${ENDPOINT:?missing EndpointUrl output}" "${RUNTIME_ARN:?missing RuntimeArn output}"

  step 3 "direct InvokeAgentRuntime with the runner's credentials and with a non-ingress role: both denied (P-1)"
  # TODO: aws bedrock-agentcore invoke-agent-runtime ... must fail with AccessDeniedException (resource policy); read exit status only.

  step 4b "A2 and B1 send A1's conversationId (and A1's unit id in the session header): own units, never A1's (P-2)"
  # TODO: POST {conversationId: c1, prompt: "hello"} as A1, A2, B1; compare sessionPrefix and nonce from the agent report.

  step 5 "A1 resumes c1: same nonce"
  # TODO

  step 6 "no tenant_id, expired, other client: 401/403"
  # TODO

  step 7 "requiredScopes: a token narrowed to tenant-api/write only is refused (tenant-api/read required)"
  # TODO

  step 8 "forwarding on: the agent reports the forwarded token's scope"
  # TODO

  step 8a "TVM: A1 reads tenant A (ok), tenant B (AccessDeniedException); the runner cannot assume the tenant role"
  # TODO: prompt "read tenant-a" then "read tenant-b"; aws sts assume-role on TenantRoleArn with the runner's credentials must fail (exit status only).

  step 9 "latency probe: 20 invocations, TTFB and total, p50/p95"
  # TODO: curl -w '%{time_starttransfer} %{time_total}' x20; compute percentiles with sort/awk; print the table.
done

# --------------------------------------------------------------------------
# 4a / 7 / 8 OFF-state checks: separate deployments of the demo app
# --------------------------------------------------------------------------
step 4a "session off: conversationId in the body is 400; two requests land in two units"
# TODO: deploy src/main.ts with --context ingress=<x> --context session=off (a separate stack name), probe, destroy.
step 8 "requireNarrowedToken on: un-narrowed token refused, narrowed accepted"
# TODO: deploy with --context forwardUserToken=true --context requireNarrowedToken=true --context allowedScopes=tenant-api/read, probe, destroy.

echo "== steps complete"
