#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Deployment integration test (spec §10, docs/sample-standard.md §5.2).
#
#   AWS_REGION=eu-central-1 scripts/integ.sh      # or: npx projen integ
#   TEI_TENANT_KEY_PROFILE=<aws profile of a second account> ...   # optional: tenant-key in another account
#
# With TEI_TENANT_KEY_PROFILE set, that profile's account is passed as the
# tenantKeyAccount context (allowTenantKeys on), and the steps create, tag,
# disable and re-enable tenant B's key under that profile. Unset, B is a
# second vendor-key tenant and the steps say the cross-account claim is not
# exercised in this run.
#
# Flow:
#   0. Refuse an account without the tei:test-account tag (M-33).
#   1. tenant-identity (shared-pool): reuse a published deployment; deploy
#      one through its own path only when none is published. It is the
#      account's shared fixture and is never destroyed by this script.
#   2. Synthesise test/integ/app.ts into cdk.integ.out/ and deploy the
#      test-aid stack and the demo stack (the §10 test profile below,
#      TestConsumerRole as its consumer role) with the CDK CLI.
#   3. Run the spec §10 steps (test/integ.ingestion.ts); it prints a summary
#      table and exits non-zero on any failed step. Teardown (step 12) is
#      this script's.
#   4. Destroy from the EXIT trap (also on failure); list what is left: stacks
#      with the sample's prefix, and keys tagged with its stacks (only
#      PendingDeletion is acceptable, step 12).
#
# Deploys into the account of the ambient AWS credentials, which must be
# CDK-bootstrapped in AWS_REGION. Conventions: scripts/CONVENTIONS.md.

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)}"
export AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY_DIR="$(cd "${SAMPLE_DIR}/../tenant-identity" && pwd)"
cd "$SAMPLE_DIR"
LIB_TMP="$(mktemp -d)"
# shellcheck source=lib.sh
source "${SAMPLE_DIR}/scripts/lib.sh"

OUT="cdk.integ.out"
CDK=(npx cdk --app "$OUT")
STACK_PREFIX="TenantEncryptedIngestion"
TEST_AID_STACK="${STACK_PREFIX}TestAid"
DEMO_STACK="${STACK_PREFIX}Integ"
IDENTITY_STACK="TenantIdentity-shared-pool"
DEPLOYED_IDENTITY=0
DEPLOYED_SAMPLE=0
FAILED=0

step() { echo "== $1"; }

cleanup() {
  local status=$?
  set +e
  step "teardown (spec §10 step 12)"
  local stack_ids="${LIB_TMP}/stack-ids" s
  : >"$stack_ids"
  if [[ "$DEPLOYED_SAMPLE" == 1 ]]; then
    for s in "$DEMO_STACK" "$TEST_AID_STACK"; do
      aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackId' --output text >>"$stack_ids" 2>/dev/null
    done
    "${CDK[@]}" destroy --all --force --concurrency 2 >"${LIB_TMP}/destroy.log" 2>&1 \
      || { echo "destroy failed: ${STACK_PREFIX} stacks" >&2; tail -20 "${LIB_TMP}/destroy.log" >&2; FAILED=1; }
  fi
  # The tenant-identity shared pool is a long-lived fixture of the test
  # account: other samples' runs share it, so a run that had to deploy it
  # leaves it in place and says so (never destroyed by a test).
  if [[ "$DEPLOYED_IDENTITY" == 1 ]]; then
    echo "  ${IDENTITY_STACK} was deployed by this run and is left in place as the account's shared fixture"
  fi
  local left
  left="$(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}')].StackName" --output text)"
  if [[ -n "$left" && "$left" != None ]]; then echo "leftover stacks: $left" >&2; FAILED=1; fi
  # Keys the stacks created: only PendingDeletion may remain (spec §6.2).
  while read -r sid; do
    [[ -n "$sid" && "$sid" != None ]] || continue
    for key in $(aws kms list-keys --query 'Keys[].KeyArn' --output text); do
      if aws kms list-resource-tags --key-id "$key" --query "Tags[?TagKey=='tei:stack' && TagValue=='${sid}'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
        state="$(aws kms describe-key --key-id "$key" --query KeyMetadata.KeyState --output text)"
        echo "  key ${key##*/}: ${state}"
        [[ "$state" == PendingDeletion ]] || { echo "leftover key not pending deletion: ${key##*/}" >&2; FAILED=1; }
      fi
    done
  done <"$stack_ids"
  rm -rf "$LIB_TMP"
  if [[ "$status" -ne 0 ]] || [[ "$FAILED" -ne 0 ]]; then
    echo "integ: FAILED" >&2
    exit 1
  fi
  echo "integ: PASSED"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# 0. Only in an account an operator marked for this test (M-33)
# --------------------------------------------------------------------------
step "0: account guard"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
# Either the account tag (readable from the Organizations management account)
# or the SSM parameter /tenant-encrypted-ingestion/test-account = true, which
# an operator sets once in an account that is a test account (member accounts
# cannot read their own Organizations tags).
if aws organizations list-tags-for-resource --resource-id "$ACCOUNT" --query "Tags[?Key=='tei:test-account'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
  echo "  account tagged tei:test-account"
elif [[ "$(aws ssm get-parameter --name /tenant-encrypted-ingestion/test-account --query Parameter.Value --output text 2>/dev/null)" == "true" ]]; then
  echo "  account marked by /tenant-encrypted-ingestion/test-account"
else
  fail "the account carries neither the tei:test-account tag nor the SSM parameter /tenant-encrypted-ingestion/test-account=true (M-33)"
fi

# --------------------------------------------------------------------------
# 1. tenant-identity (shared-pool): reuse, or deploy through its own path
# --------------------------------------------------------------------------
step "1: tenant-identity shared-pool"
if aws ssm get-parameter --name "${IDENTITY_PREFIX}/apiUrl" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "  reusing the published tenant-identity deployment"
else
  DEPLOYED_IDENTITY=1
  echo "  deploying ${IDENTITY_STACK} through its own path"
  if [[ ! -d "${IDENTITY_DIR}/node_modules" ]]; then
    (cd "$IDENTITY_DIR" && npm ci --no-audit --no-fund >"${LIB_TMP}/identity-install.log" 2>&1) || fail "npm ci in ${IDENTITY_DIR}"
  fi
  (cd "$IDENTITY_DIR" && npx projen build >"${LIB_TMP}/identity-build.log" 2>&1) || fail "projen build in ${IDENTITY_DIR}"
  (cd "$IDENTITY_DIR" && npx cdk deploy "$IDENTITY_STACK" --context topology=shared-pool --require-approval never >"${LIB_TMP}/identity-deploy.log" 2>&1) \
    || { tail -30 "${LIB_TMP}/identity-deploy.log" >&2; fail "deploy ${IDENTITY_STACK}"; }
fi

# --------------------------------------------------------------------------
# 2. The test-aid stack and the demo stack (test/integ/app.ts)
# --------------------------------------------------------------------------
step "2: synthesise and deploy ${TEST_AID_STACK}, ${DEMO_STACK}"
# The spec §10 test profile is INTEG_PROFILE (src/demo.cdk.ts), which
# test/integ/app.ts always applies: uploadUrlTtlSeconds 120 s, so the
# presigned PUTs of the slower steps stay valid; step 7 waits TTL plus grace
# for EXPIRED. Only run-specific context goes here.
CONTEXT=()
if [[ -n "${TEI_TENANT_KEY_PROFILE:-}" ]]; then
  TENANT_KEY_ACCOUNT="$(aws sts get-caller-identity --profile "$TEI_TENANT_KEY_PROFILE" --query Account --output text)" \
    || fail "no credentials for TEI_TENANT_KEY_PROFILE"
  [[ "$TENANT_KEY_ACCOUNT" != "$ACCOUNT" ]] || fail "TEI_TENANT_KEY_PROFILE must name a second account, not the test account"
  CONTEXT+=(--context "tenantKeyAccount=${TENANT_KEY_ACCOUNT}")
  export TEI_TENANT_KEY_PROFILE
  echo "  tenant-key account: set (profile ${TEI_TENANT_KEY_PROFILE})"
else
  echo "  tenant-key account: none; the cross-account claim is not exercised in this run"
fi
npx cdk synth -q --app "npx ts-node -P tsconfig.json --prefer-ts-exts test/integ/app.ts" --output "$OUT" ${CONTEXT[@]+"${CONTEXT[@]}"} >"${LIB_TMP}/synth.log" 2>&1 \
  || { tail -30 "${LIB_TMP}/synth.log" >&2; fail "synth test/integ/app.ts"; }
DEPLOYED_SAMPLE=1
"${CDK[@]}" deploy --all --require-approval never --concurrency 2 --outputs-file "${OUT}/outputs.json" >"${LIB_TMP}/deploy.log" 2>&1 \
  || { tail -30 "${LIB_TMP}/deploy.log" >&2; fail "deploy ${STACK_PREFIX} stacks"; }
echo "  deployed"

# --------------------------------------------------------------------------
# 3. The spec §10 steps
# --------------------------------------------------------------------------
step "3: spec §10 steps (test/integ.ingestion.ts)"
INTEG_OUTPUTS="${OUT}/outputs.json" npx ts-node -P tsconfig.json --prefer-ts-exts test/integ.ingestion.ts || FAILED=1
