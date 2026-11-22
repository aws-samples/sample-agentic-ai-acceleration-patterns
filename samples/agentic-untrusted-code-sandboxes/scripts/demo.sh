#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo against a deployed demo stack (standalone entry).
#
#   AWS_REGION=eu-central-1 scripts/demo.sh
#
# Reads the published parameter, then for each deployed backend walks the
# README's step table as the vendor's own API would: two synthetic tenants
# call runCodeFunction with IAM, and offboardTenant stops their sandboxes.
# Checks each response and offboards both tenants on exit, also on failure.
# Prints step names, tenant ids and outcome codes only; never code, input or
# output (scripts/CONVENTIONS.md).

set -euo pipefail
: "${AWS_REGION:?Set AWS_REGION to the Region of the deployed stack}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

PUBLISHED="$(aws ssm get-parameter --name /application-plane/shared/code-sandbox/sandboxes --query Parameter.Value --output text)"
RUN_CODE="$(jq -r '.runCodeFunctionArn' <<<"$PUBLISHED")"
OFFBOARD="$(jq -r '.offboardFunctionArn' <<<"$PUBLISHED")"
[[ "$RUN_CODE" == arn:* ]] || { echo "The demo needs a stack deployed with --context standalone=true" >&2; exit 1; }
mapfile -t BACKENDS < <(jq -r '.backends[]' <<<"$PUBLISHED")
RUN="$(openssl rand -hex 4)"
TENANT_A="demo-a-${RUN}"
TENANT_B="demo-b-${RUN}"
MARKER="marker-${RUN}"
OUT="$(mktemp)"
FAILED=0

offboard() { # tenant -> prints the number of stopped sandboxes
  aws lambda invoke --function-name "$OFFBOARD" --cli-binary-format raw-in-base64-out --cli-read-timeout 150 \
    --payload "$(jq -nc --arg t "$1" '{tenantId:$t}')" "$OUT" >/dev/null
  jq -r '.stopped | length' "$OUT"
}

cleanup() {
  local status=$?
  for tenant in "$TENANT_A" "$TENANT_B"; do
    offboard "$tenant" >/dev/null 2>&1 || echo "cleanup: offboard of $tenant failed; repeat it" >&2
  done
  rm -f "$OUT"
  echo "cleanup: both tenants offboarded"
  if [[ "$FAILED" == 0 && "$status" == 0 ]]; then echo "demo: PASSED"; else echo "demo: FAILED" >&2; exit 1; fi
}
trap cleanup EXIT

call() { # tenant backend code [input] -> the answer in $OUT; retries sandbox_starting
  local payload attempt
  payload="$(jq -nc --arg t "$1" --arg b "$2" --arg c "$3" --arg i "${4:-}" \
    '{tenantId:$t, backend:$b, code:$c} + (if $i == "" then {} else {input:$i} end)')"
  for attempt in $(seq 1 30); do
    aws lambda invoke --function-name "$RUN_CODE" --cli-binary-format raw-in-base64-out --cli-read-timeout 150 \
      --payload "$payload" "$OUT" >/dev/null
    [[ "$(jq -r '.error // empty' "$OUT")" == sandbox_starting ]] || return 0
    sleep "$(jq -r '.retryAfterSeconds // 5' "$OUT")"
  done
}

expect() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "PASS $1 ($3)"; else echo "FAIL $1: expected $2, got $3" >&2; FAILED=1; fi
}

for backend in "${BACKENDS[@]}"; do
  echo "backend: $backend (tenants $TENANT_A, $TENANT_B)"

  call "$TENANT_A" "$backend" "print(6 * 7)"
  expect "1. $backend: A runs code in a new sandbox" "0 42 started" \
    "$(jq -r '"\(.exitCode) \(.stdout | rtrimstr("\n")) \(.sandbox)"' "$OUT")"

  call "$TENANT_A" "$backend" "open('/work/marker', 'w').write('${MARKER}'); print(open('/work/marker').read())"
  expect "2. $backend: A's next call reuses its sandbox and keeps /work" "${MARKER} reused" \
    "$(jq -r '"\(.stdout | rtrimstr("\n")) \(.sandbox)"' "$OUT")"

  call "$TENANT_B" "$backend" "import os; print(os.path.exists('/work/marker'))"
  expect "3. $backend: B gets its own sandbox and cannot see A's file" "False started" \
    "$(jq -r '"\(.stdout | rtrimstr("\n")) \(.sandbox)"' "$OUT")"

  call "$TENANT_A" "$backend" "print(1)" "../${TENANT_B}/invoice.csv"
  expect "4. $backend: a name outside A's prefix is refused" invalid_argument "$(jq -r '.error // "none"' "$OUT")"

  call "$TENANT_A" "$backend" "print(1)" "missing-${RUN}.csv"
  expect "5. $backend: a missing input is refused before any code runs" input_not_found "$(jq -r '.error // "none"' "$OUT")"

  call "$TENANT_A" "$backend" "while True: pass"
  expect "6. $backend: a runaway loop ends at runTimeout" true "$(jq -r '.timedOut' "$OUT")"
done

expect "7. offboardTenant stops A's sandboxes on every backend" "${#BACKENDS[@]}" "$(offboard "$TENANT_A")"
