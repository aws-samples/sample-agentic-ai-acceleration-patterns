#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, last step: destroy the stress stacks (design/agentic-runtime-isolation.stress-test.md §8.2, §8.3).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small] [STRESS_PREFIX=RuntimeIsolationStress] scripts/stress/teardown.sh [--tenants]
#
# Destroys <prefix>-driver, then the <prefix>-agents-* stacks, then
# <prefix>-ingress, one at a time (cdk destroy --force), and prints one
# `stack=<name> destroy_seconds=<n>` line per stack. Stacks that are not
# there are skipped, so a rerun after a partial teardown finishes the job.
# After the destroy it removes the Runtime log groups a late line recreated
# outside the stacks (ADR-0047) and fails if a stack, a Runtime log group or
# a registry parameter with this prefix is still there.
#
# The seeded tenants are kept for the next run (§8.2: Cognito bills per
# monthly active user). With --tenants, they are deleted first, at 8 a second
# (DeleteTenant on tenant-identity's platform API, 204 or 404 both done), and
# each deleted one leaves the manifest; tenants that would not delete stay in
# it, the stacks are destroyed anyway, and the script fails at the end naming
# the count (rerun with --tenants to retry them). The shared identity
# deployment itself is never touched. Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap.
# shellcheck disable=SC2329

set -euo pipefail

DELETE_TENANTS=0
TENANTS_LEFT=0
case "${1:-}" in
  "") ;;
  --tenants) DELETE_TENANTS=1 ;;
  *) echo "usage: $0 [--tenants]" >&2; exit 2 ;;
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
TIMINGS="${STATE_DIR}/timings.txt"
mkdir -p "$STATE_DIR"

LIB_TMP="$(mktemp -d)"
MAIN_TMP="$LIB_TMP"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"
DELETED="${MAIN_TMP}/deleted"
: >"$DELETED"

# drop_deleted: removes the tenants deleted so far from the manifest.
drop_deleted() {
  [[ -s "$DELETED" && -s "$MANIFEST" ]] || return 0
  jq --rawfile d "$DELETED" '($d | split("\n") | map(select(length > 0))) as $gone
    | .tenants |= map(select(.tenantId as $id | $gone | index($id) | not))' "$MANIFEST" >"${MANIFEST}.new"
  mv "${MANIFEST}.new" "$MANIFEST"
  chmod 600 "$MANIFEST"
  : >"$DELETED"
}
cleanup() {
  local code=$?
  set +e
  jobs -rp | xargs -r kill 2>/dev/null
  wait 2>/dev/null
  drop_deleted
  rm -rf "$MAIN_TMP"
  exit "$code"
}
trap cleanup EXIT

echo "scale=${SCALE} prefix=${PREFIX} started=$(date -u +%FT%TZ)"

# -- 1. tenants (only with --tenants) ----------------------------------------
if [[ "$DELETE_TENANTS" == 1 ]]; then
  if [[ -s "$MANIFEST" ]]; then
    identity_init
    STATUSES="${MAIN_TMP}/statuses"
    : >"$STATUSES"
    PACE_NEXT=0
    pace() { # INTERVAL_MS
      local now
      now="$(date +%s%3N)"
      if (( now < PACE_NEXT )); then
        sleep "$(awk -v d="$((PACE_NEXT - now))" 'BEGIN { printf "%.3f", d / 1000 }')"
        now="$PACE_NEXT"
      fi
      PACE_NEXT=$((now + $1))
    }
    # job_delete TENANT_ID: the call lib.sh's delete_tenants makes, with the status kept and 429/5xx retried.
    job_delete() {
      local st attempt=1 delay=1
      LIB_TMP="$(mktemp -d -p "$MAIN_TMP")"; BODY="${LIB_TMP}/body"; REQ="${LIB_TMP}/request"
      : >"$BODY"; : >"$REQ"; chmod 600 "$BODY" "$REQ"
      while :; do
        st="$(platform DELETE "platform/tenants/$1")" || st=000
        if [[ ! "$st" =~ ^(429|5[0-9][0-9]|000)$ ]] || (( attempt >= 5 )); then break; fi
        sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
      done
      echo "DeleteTenant ${st}" >>"$STATUSES"
      [[ "$st" =~ ^(200|202|204|404)$ ]] && echo "$1" >>"$DELETED"
      rm -rf "$LIB_TMP"
    }
    START=$SECONDS
    TOTAL="$(jq '.tenants | length' "$MANIFEST")"
    while read -r id; do
      pace 125
      while (( $(jobs -rp | wc -l) >= 24 )); do wait -n 2>/dev/null || true; done
      job_delete "$id" &
    done < <(jq -r '.tenants[].tenantId' "$MANIFEST")
    wait
    GONE="$(wc -l <"$DELETED")"
    drop_deleted
    echo "tenants: ${GONE} of ${TOTAL} deleted in $((SECONDS - START))s; status $(sort "$STATUSES" | uniq -c | awk '{printf "%s:%s=%s ", $2, $3, $1}')"
    # Not a stop: the stacks are destroyed below either way, and the script
    # fails at the end so the undeleted tenants (still in the manifest) are
    # reported after the stacks are gone. A rerun with --tenants retries them.
    TENANTS_LEFT=$((TOTAL - GONE))
  else
    echo "tenants: no manifest, nothing to delete"
  fi
else
  echo "tenants: kept for the next run (pass --tenants to delete them)"
fi

# -- 2. stacks, driver -> agents -> ingress, one at a time --------------------
exists() { # STACK -> 0 when CloudFormation has it (not deleted)
  local s
  s="$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)" || return 1
  [[ -n "$s" && "$s" != DELETE_COMPLETE ]]
}
mapfile -t LIVE_AGENTS < <(aws cloudformation list-stacks --output text \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE CREATE_FAILED DELETE_FAILED UPDATE_ROLLBACK_FAILED ROLLBACK_FAILED \
  --query "StackSummaries[?starts_with(StackName, '${PREFIX}-agents-')].StackName" | tr '\t' '\n' | grep -v '^$' | sort -rV || true)
STACKS=()
exists "${PREFIX}-driver" && STACKS+=("${PREFIX}-driver")
STACKS+=("${LIVE_AGENTS[@]}")
exists "${PREFIX}-ingress" && STACKS+=("${PREFIX}-ingress")
if (( ${#STACKS[@]} == 0 )); then
  echo "stacks: none with prefix ${PREFIX}; nothing to destroy"
  (( TENANTS_LEFT == 0 )) || fail "${TENANTS_LEFT} tenants were not deleted; they stay in the manifest, rerun with --tenants"
  exit 0
fi

# cdk destroy needs the app; the agents stacks look up the ingress stack's
# published document at synth, so they are in the app only while they exist.
OUT="cdk.stress.out"
AGENTS=false
(( ${#LIVE_AGENTS[@]} > 0 )) && AGENTS=true
rm -rf "$OUT"
STRESS_SCALE="$SCALE" STRESS_PREFIX="$PREFIX" STRESS_AGENTS="$AGENTS" STRESS_DRIVER=true \
  npx cdk synth -q --app "npx ts-node -P tsconfig.json --prefer-ts-exts test/stress.runtime.ts" --output "$OUT" >"${MAIN_TMP}/synth.log" 2>&1 \
  || { tail -30 "${MAIN_TMP}/synth.log" >&2; fail "synth"; }
for s in "${STACKS[@]}"; do
  [[ -f "${OUT}/${s}.template.json" ]] || fail "${s} exists but the ${SCALE} app does not synthesise it; set STRESS_SCALE to the tier it was deployed at"
done

# What CloudFormation does not take with it, collected before the destroy
# (the ids are gone after): the Runtime ids, whose log groups under
# /aws/bedrock-agentcore/runtimes/<id>-* are owned by a custom resource that a
# line written after its Delete recreates outside the stack (ADR-0047; what
# scripts/integ.sh removes too), and the registry prefix the ingress published
# under, to check no parameter stays behind.
RUNTIME_LOG_PREFIX="/aws/bedrock-agentcore/runtimes/"
RUNTIMES="${MAIN_TMP}/runtimes"
: >"$RUNTIMES"
REGISTRY_PREFIX=""
for s in "${STACKS[@]}"; do
  aws cloudformation list-stack-resources --stack-name "$s" \
    --query "StackResourceSummaries[?ResourceType=='AWS::BedrockAgentCore::Runtime'].PhysicalResourceId" --output text 2>/dev/null \
    | tr '\t' '\n' | sed 's#.*/##' | grep -v '^$' >>"$RUNTIMES" || true
done
if exists "${PREFIX}-ingress"; then
  REGISTRY_PREFIX="$(aws cloudformation describe-stacks --stack-name "${PREFIX}-ingress" \
    --query "Stacks[0].Outputs[?OutputKey=='RegistryPrefix'].OutputValue" --output text 2>/dev/null || true)"
  [[ "$REGISTRY_PREFIX" == None ]] && REGISTRY_PREFIX=""
fi

for s in "${STACKS[@]}"; do
  echo "== destroy ${s}"
  start=$SECONDS
  npx cdk --app "$OUT" destroy "$s" --exclusively --force >"${MAIN_TMP}/destroy.log" 2>&1 \
    || { grep -E "FAILED|Error|error" "${MAIN_TMP}/destroy.log" | tail -30 >&2; fail "destroy ${s}"; }
  secs=$((SECONDS - start))
  echo "stack=${s} destroy_seconds=${secs}"
  echo "$(date -u +%F) scale=${SCALE} stack=${s} destroy_seconds=${secs}" >>"$TIMINGS"
done
if ! exists "${PREFIX}-ingress"; then rm -f "$OUTPUTS"; fi

# -- 3. what the destroy leaves: Runtime log groups removed, then a check -----
REMOVED=0
while read -r rt; do
  [[ -n "$rt" && "$rt" != None ]] || continue
  for g in $(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    [[ -n "$g" && "$g" != None ]] || continue
    aws logs delete-log-group --log-group-name "$g" >/dev/null 2>&1 && REMOVED=$((REMOVED + 1))
  done
done <"$RUNTIMES"
echo "runtime log groups: $(wc -l <"$RUNTIMES") runtimes, ${REMOVED} leftover groups removed"

LEFT=""
left_stacks="$(aws cloudformation list-stacks --output text \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE CREATE_FAILED DELETE_FAILED UPDATE_ROLLBACK_FAILED ROLLBACK_FAILED DELETE_IN_PROGRESS \
  --query "StackSummaries[?starts_with(StackName, '${PREFIX}-')].StackName" 2>/dev/null | tr '\t' ' ' || true)"
[[ -z "$left_stacks" || "$left_stacks" == None ]] || LEFT="${LEFT}; stacks ${left_stacks}"
while read -r rt; do
  [[ -n "$rt" && "$rt" != None ]] || continue
  left="$(aws logs describe-log-groups --log-group-name-prefix "${RUNTIME_LOG_PREFIX}${rt}" --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)"
  [[ -z "$left" || "$left" == None ]] || LEFT="${LEFT}; runtime log groups ${left}"
done <"$RUNTIMES"
if [[ -n "$REGISTRY_PREFIX" ]]; then
  left_params="$(aws ssm get-parameters-by-path --path "$REGISTRY_PREFIX" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' ' ' || true)"
  [[ -z "$left_params" || "$left_params" == None ]] || LEFT="${LEFT}; parameters ${left_params}"
fi
[[ -z "$LEFT" ]] || fail "leftovers after teardown${LEFT}"
echo "leftovers: none (stacks, runtime log groups, registry parameters)"
echo "destroyed ${#STACKS[@]} stacks in ${SECONDS}s"
(( TENANTS_LEFT == 0 )) || fail "${TENANTS_LEFT} tenants were not deleted; they stay in the manifest, rerun with --tenants"
