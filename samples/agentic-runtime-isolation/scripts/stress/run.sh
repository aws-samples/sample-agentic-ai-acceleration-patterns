#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 4: run one k6 scenario on the driver host
# (design/agentic-runtime-isolation.stress-test.md §5 Phase 2, §8.3).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small] [STRESS_PREFIX=RuntimeIsolationStress] scripts/stress/run.sh s1|s2|...|s7
#
# Uploads scripts/stress/k6/ and the manifest to s3://<ResultsBucketName>/in/,
# runs k6 on <InstanceId> through `ssm send-command` (AWS-RunShellScript),
# polls until it finishes, and downloads s3://<bucket>/out/<run-id>/ to
# ~/.runtime-isolation-stress/<prefix>/runs/<run-id>/ with the run window
# (window.json, UTC epoch seconds) for collect.sh. s2 first gives the ingress
# new instances and an empty authoriser cache (§13 question 2).
#
# Prints the command's status changes, the scenario's summary line and the
# isolation counters. The tokens live in k6's memory on the host; nothing
# here handles one. Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap.
# shellcheck disable=SC2329

set -euo pipefail

SCENARIO="${1:-}"
case "$SCENARIO" in
  s1) K6_FILE=s1-steady.js ;;
  s2) K6_FILE=s2-herd.js ;;
  s3) K6_FILE=s3-noisy.js ;;
  s4) K6_FILE=s4-tools.js ;;
  s5) K6_FILE=s5-streams.js ;;
  s6) K6_FILE=s6-peak.js ;;
  s7) K6_FILE=s7-eviction.js ;;
  *) echo "usage: $0 s1|s2|s3|s4|s5|s6|s7" >&2; exit 2 ;;
esac

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region the stress stacks are deployed in}"
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
MANIFEST="${STATE_DIR}/manifest.json"
K6_DIR="${SCRIPT_DIR}/k6"

LIB_TMP="$(mktemp -d)"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"
COMMAND_ID=""
DONE=0
cleanup() {
  local code=$?
  set +e
  if [[ -n "$COMMAND_ID" && "$DONE" == 0 ]]; then
    aws ssm cancel-command --command-id "$COMMAND_ID" >/dev/null 2>&1 && echo "cancelled the k6 command on the driver host" >&2
  fi
  rm -rf "$LIB_TMP"
  exit "$code"
}
trap cleanup EXIT

[[ -s "$OUTPUTS" ]] || fail "no ${OUTPUTS}; run scripts/stress/deploy.sh first"
[[ -s "$MANIFEST" ]] || fail "no ${MANIFEST}; run scripts/stress/seed.sh first"
[[ -f "${K6_DIR}/${K6_FILE}" && -f "${K6_DIR}/lib.js" ]] || fail "scripts/stress/k6/${K6_FILE} or lib.js is missing"
output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || fail "output $1 missing from ${OUTPUTS}"; printf '%s' "$v"; }
BUCKET="$(need ResultsBucketName)"
INSTANCE="$(need InstanceId)"
ENDPOINT="$(need EndpointUrl)"
ENT_API="$(need EntitlementsApiUrl)"
ISSUER="$(need Issuer)"

TIER="$(STRESS_SCALE="$SCALE" npx ts-node -P tsconfig.json --prefer-ts-exts \
  -e "console.log(JSON.stringify(require('./test/stress/tiers').tierOf(process.env.STRESS_SCALE)))" 2>"${LIB_TMP}/tier.err" | tail -1)" || true
jq -e 'type == "object" and has("scenarioSeconds")' <<<"$TIER" >/dev/null 2>&1 \
  || { tail -5 "${LIB_TMP}/tier.err" >&2; fail "could not read the ${SCALE} tier from test/stress/tiers.ts (tierOf)"; }
identity_init   # IDENTITY_API (the platform API) and APP_CLIENT_ID for the /token refresh

RUN_ID="${SCENARIO}-${SCALE}-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${STATE_DIR}/runs/${RUN_ID}"
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"
echo "run_id=${RUN_ID} scenario=${SCENARIO} (${K6_FILE}) scale=${SCALE} prefix=${PREFIX}"

# -- s2: an instance-free ingress (§13 question 2) ---------------------------
new_instances() { # FUNCTION: an environment marker change retires every warm instance
  local env="${LIB_TMP}/env.json"
  : >"$env"; chmod 600 "$env"
  aws lambda get-function-configuration --function-name "$1" --query 'Environment.Variables' --output json \
    | jq -c --arg m "$RUN_ID" '{Variables: ((. // {}) + {STRESS_INSTANCE_MARKER: $m})}' >"$env"
  aws lambda update-function-configuration --function-name "$1" --environment "file://${env}" >/dev/null \
    || fail "update-function-configuration $1"
  : >"$env"
  aws lambda wait function-updated --function-name "$1" || fail "wait function-updated $1"
}
if [[ "$SCENARIO" == s2 ]]; then
  echo "== s2 recipe: new Lambda instances, authoriser cache flushed, 60 s idle"
  FNS=("$(need AuthorizerFunctionName)" "$(need IngressFunctionName)")
  IFS=',' read -r -a INTERCEPTORS <<<"$(output InterceptorFunctionNames)"
  for fn in "${INTERCEPTORS[@]}"; do [[ -n "$fn" ]] && FNS+=("$fn"); done
  for fn in "${FNS[@]}"; do new_instances "$fn"; done
  aws apigateway flush-stage-authorizers-cache --rest-api-id "$(need RestApiId)" --stage-name "$(need StageName)" \
    || fail "flush-stage-authorizers-cache"
  echo "  ${#FNS[@]} functions on new instances; authoriser cache flushed"
  # One fixed wait, not a poll: nothing can be polled for "no instance is
  # warm"; 60 s with no traffic lets the retired instances go and keeps
  # anything from warming a new one before the herd (§13 question 2).
  sleep 60
fi

# -- inputs to the bucket ----------------------------------------------------
aws s3 sync "${K6_DIR}/" "s3://${BUCKET}/in/k6/" --delete --only-show-errors || fail "upload k6/"
aws s3 cp "$MANIFEST" "s3://${BUCKET}/in/manifest.json" --only-show-errors || fail "upload the manifest"

# sq VALUE -> VALUE in single quotes for the host's shell (POSIX; AWS-RunShellScript runs sh).
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
REMOTE="${LIB_TMP}/remote.sh"
cat >"$REMOTE" <<REMOTE_SCRIPT
set -eu
mkdir -p /opt/stress
aws s3 sync $(sq "s3://${BUCKET}/in/") /opt/stress/ --delete --only-show-errors --region $(sq "$REGION")
export TIER=$(sq "$TIER")
export MANIFEST=/opt/stress/manifest.json
export ENDPOINT=$(sq "$ENDPOINT")
export ENTITLEMENTS_API=$(sq "$ENT_API")
export PLATFORM_API=$(sq "$IDENTITY_API")
export APP_CLIENT_ID=$(sq "$APP_CLIENT_ID")
export ISSUER=$(sq "$ISSUER")
export REGION=$(sq "$REGION")
export RUN_ID=$(sq "$RUN_ID")
export AWS_REGION=$(sq "$REGION")
# k6 signs IssueToken with SigV4 and needs the instance role credentials in its environment (never printed).
eval "\$(aws configure export-credentials --format env)"
cd /opt/stress/k6
rm -f summary.json k6-stdout.txt
rc=0
k6 run --summary-export summary.json $(sq "$K6_FILE") >k6-stdout.txt 2>&1 || rc=\$?
[ -f summary.json ] && aws s3 cp summary.json $(sq "s3://${BUCKET}/out/${RUN_ID}/summary.json") --only-show-errors --region $(sq "$REGION")
aws s3 cp k6-stdout.txt $(sq "s3://${BUCKET}/out/${RUN_ID}/k6-stdout.txt") --only-show-errors --region $(sq "$REGION")
exit \$rc
REMOTE_SCRIPT
PARAMS="${LIB_TMP}/params.json"
jq -Rs '{commands: (split("\n") | map(select(length > 0))), executionTimeout: ["14400"]}' "$REMOTE" >"$PARAMS"

# -- run and wait ------------------------------------------------------------
# The per-tenant limit is a fixed one-minute window (ADR-0020): a scenario
# that starts in the minute the previous one filled up inherits its 429s
# (seen 2026-11-09, S4 after S3). Start at least 3 s into a fresh minute.
now="$(date +%s)"
if (( now % 60 > 3 )); then
  wait_s=$(( 60 - now % 60 + 3 ))
  echo "waiting ${wait_s}s for a fresh limiter minute"
  sleep "$wait_s"
fi
START_EPOCH="$(date +%s)"
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "runtime-isolation stress ${RUN_ID}" --parameters "file://${PARAMS}" \
  --query Command.CommandId --output text)" || fail "ssm send-command"
: >"$PARAMS"
echo "k6 started on the driver host at $(date -u -d "@${START_EPOCH}" +%FT%TZ)"
last=""
status=Pending
while :; do
  status="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
    --query Status --output text 2>/dev/null || echo Pending)"
  [[ "$status" != "$last" ]] && { echo "  $(date -u +%T) ${status}"; last="$status"; }
  [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]] || break
  sleep 15
done
DONE=1
END_EPOCH="$(date +%s)"
jq -n --arg r "$RUN_ID" --arg s "$SCENARIO" --arg c "$SCALE" --arg st "$status" \
  --argjson a "$START_EPOCH" --argjson b "$END_EPOCH" \
  '{runId: $r, scenario: $s, scale: $c, start: $a, end: $b, commandStatus: $st}' >"${RUN_DIR}/window.json"

aws s3 cp "s3://${BUCKET}/out/${RUN_ID}/" "${RUN_DIR}/" --recursive --only-show-errors \
  || echo "WARN: nothing to download from out/${RUN_ID}/" >&2
SUMMARY="${RUN_DIR}/summary.json"

# m METRIC FIELD -> one value of a k6 metric (summary-export and handleSummary layouts), or n/a.
m() {
  [[ -s "$SUMMARY" ]] || { echo n/a; return 0; }
  jq -r --arg k "$1" --arg f "$2" '(.metrics[$k].values // .metrics[$k]) as $v | if $v == null then "n/a" else ($v[$f] // "n/a") end' "$SUMMARY"
}
MISMATCH="$(m isolation_mismatch count)"
echo "run_id=${RUN_ID} status=${status} seconds=$((END_EPOCH - START_EPOCH)) requests=$(m http_reqs count) p90_ms=$(m http_req_duration 'p(90)') failed_rate=$(m http_req_failed value)"
[[ "$(m http_req_failed value)" != n/a ]] || echo "  (http_req_failed rate: $(m http_req_failed rate))"
echo "isolation_mismatch=${MISMATCH} positive_control_fail=$(m positive_control_fail count)"
echo "outputs: ${RUN_DIR} (next: scripts/stress/collect.sh ${RUN_ID})"
[[ "$status" == Success ]] || fail "the k6 command ended ${status}; see ${RUN_DIR}/k6-stdout.txt"
[[ "$MISMATCH" == n/a || "$MISMATCH" == 0 ]] || fail "isolation_mismatch=${MISMATCH}: the run fails (§6)"
