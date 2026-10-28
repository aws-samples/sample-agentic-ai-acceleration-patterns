#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Latency harness against a deployed agentic-runtime-isolation stack and a deployed
# tenant-identity shared-pool (ADR-0009, ADR-0023). It measures the five
# shapes a caller sees, client-side with curl, and prints one summary line
# per scenario (p50/p90/max of TTFB and total, in seconds):
#
#   0. the first request of the run (a cold ingress Lambda and a new microVM)
#   1. a new conversation each time: the Runtime starts a microVM (`report` probe, no model)
#   2. the same conversation: a warm microVM (`report` probe)
#   3. the same conversation with a one-word model prompt
#   4. a new conversation with a one-word model prompt
#   5. N parallel requests on N warm conversations
#
#   AWS_REGION=eu-central-1 scripts/perf.sh [N_COLD] [N_WARM] [N_MODEL] [N_PAR]
#
# Defaults 8 20 8 10. Reads the endpoint from this sample's published
# parameters; set ENDPOINT=<invocation URL> to measure a stack deployed with
# publishParameters=false (README, "Two ingresses in one account"). Set
# PERF_OUT=<directory> to keep one line per request ("status ttfb total") per
# scenario; otherwise the raw samples live in a temp directory removed on exit.
#
# Server-side figures (Lambda init, the ingress's own work, the Runtime's
# microVM boot) come from the ingress log group: the REPORT lines and the
# `request served` line's `totalMs` and `backendInvokeSeconds` (ADR-0023).
#
# Creates one tenant and deletes it on exit, also on failure. Prints statuses,
# timings and the tenant id; never a token, a credential or a header value.
# Conventions: scripts/CONVENTIONS.md.
#
# Needs: bash, aws (v2), curl, jq. The AWS credentials need execute-api:Invoke
# on tenant-identity's platform API and ssm:GetParameter.

set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
: "${REGION:?Set AWS_REGION to the Region the stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

N_COLD="${1:-8}"; N_WARM="${2:-20}"; N_MODEL="${3:-8}"; N_PAR="${4:-10}"
for n in "$N_COLD" "$N_WARM" "$N_MODEL" "$N_PAR"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "Counts must be positive integers (got '$n')" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_TMP="$(mktemp -d)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

if [[ -n "${PERF_OUT:-}" ]]; then
  mkdir -p "$PERF_OUT"; OUT="$PERF_OUT"; KEEP_OUT=1
else
  OUT="$(mktemp -d)"; KEEP_OUT=0
fi

cleanup() {
  local code=$?
  set +e
  delete_tenants
  rm -rf "$LIB_TMP"
  [[ "$KEEP_OUT" == 1 ]] || rm -rf "$OUT"
  exit "$code"
}
trap cleanup EXIT

if [[ -n "${ENDPOINT:-}" ]]; then
  INGRESS="${INGRESS:-unknown}"
else
  ENDPOINT="$(param "${PARAM_PREFIX}/endpointUrl")" || fail "parameter ${PARAM_PREFIX}/endpointUrl not found; deploy this sample first or set ENDPOINT"
  INGRESS="$(param "${PARAM_PREFIX}/ingress")"
fi
identity_init

RUN="$(date +%s)"
echo "ingress=${INGRESS} started=$(date -u +%FT%TZ) counts=${N_COLD}/${N_WARM}/${N_MODEL}/${N_PAR} (endpoint resolved; not printed)"

create_tenant "rtiso-perf-${RUN}"; TENANT="$TENANT_ID"
issue_token "$TENANT" "$ADMIN_USERNAME" T
echo "tenant=${TENANT}"

conv() { printf 'perf%s%s' "$RUN" "$(printf '%08d' "$1")"; }
body() { jq -nc --arg c "$1" --arg p "$2" '{conversationId: $c, prompt: $p}'; }

# req CONVERSATION PROMPT -> "status ttfb total" (seconds)
req() {
  local status
  status="$(invoke "$ENDPOINT" T_ACCESS "$(body "$1" "$2")")"; timing
  printf '%s %s %s\n' "$status" "$LAST_TTFB" "$LAST_TOTAL"
}

# summary NAME FILE: one line with the status histogram and the percentiles.
summary() {
  local name="$1" file="$2" statuses t50 t90 tmax s50 s90 smax
  statuses="$(awk '{print $1}' "$file" | sort | uniq -c | awk '{printf "%s:%s ", $2, $1}')"
  awk '{print $2}' "$file" >"${file}.ttfb"; awk '{print $3}' "$file" >"${file}.total"
  t50="$(percentile 50 "${file}.ttfb")"; t90="$(percentile 90 "${file}.ttfb")"; tmax="$(percentile 100 "${file}.ttfb")"
  s50="$(percentile 50 "${file}.total")"; s90="$(percentile 90 "${file}.total")"; smax="$(percentile 100 "${file}.total")"
  printf '%-14s n=%-3s status=%-10s TTFB p50/p90/max %s/%s/%s  total p50/p90/max %s/%s/%s\n' \
    "$name" "$(wc -l <"$file")" "$statuses" "$t50" "$t90" "$tmax" "$s50" "$s90" "$smax"
}

# scenario NAME PROMPT N MODE(cold|warm): cold uses a new conversation per request; warm one conversation, warmed once uncounted.
scenario() {
  local name="$1" prompt="$2" n="$3" mode="$4" i c
  : >"${OUT}/${name}.txt"
  c="$(conv 1)"
  [[ "$mode" == warm ]] && req "$c" "$prompt" >/dev/null
  for ((i = 1; i <= n; i++)); do
    [[ "$mode" == cold ]] && c="$(conv $((100 + i)))"
    req "$c" "$prompt" >>"${OUT}/${name}.txt"
  done
  summary "$name" "${OUT}/${name}.txt"
}

echo "== 0. first request of the run (cold ingress Lambda, new microVM)"
echo "first-request $(req "$(conv 0)" report)"

echo "== 1. new conversation each time, 'report' probe (microVM start, no model)"
scenario cold-report report "$N_COLD" cold

echo "== 2. same conversation, 'report' probe (warm microVM)"
scenario warm-report report "$N_WARM" warm

echo "== 3. same conversation, one-word model prompt"
scenario warm-model "Reply with the single word OK." "$N_MODEL" warm

echo "== 4. new conversation each time, one-word model prompt"
scenario cold-model "Reply with the single word OK." "$(((N_COLD + 1) / 2))" cold

echo "== 5. ${N_PAR} parallel 'report' requests on ${N_PAR} warm conversations"
# Each parallel request runs in its own subshell with its own temp files, so
# the shared BODY/REQ/timing files of lib.sh are never written concurrently.
parallel_req() {
  local c="$1" out="$2"
  LIB_TMP="$(mktemp -d)"; BODY="${LIB_TMP}/body"; REQ="${LIB_TMP}/request"
  : >"$BODY"; : >"$REQ"; chmod 600 "$BODY" "$REQ"
  req "$c" report >>"$out"
  rm -rf "$LIB_TMP"
}
for ((i = 1; i <= N_PAR; i++)); do (parallel_req "$(conv $((500 + i)))" /dev/null) & done; wait
: >"${OUT}/parallel.txt"
PAR_START="$(date +%s.%N)"
for ((i = 1; i <= N_PAR; i++)); do (parallel_req "$(conv $((500 + i)))" "${OUT}/parallel.txt") & done; wait
PAR_END="$(date +%s.%N)"
summary parallel "${OUT}/parallel.txt"
echo "parallel wall $(awk -v a="$PAR_START" -v b="$PAR_END" 'BEGIN{printf "%.3f", b-a}')s for ${N_PAR} requests"

echo "finished=$(date -u +%FT%TZ) tenant=${TENANT}"
[[ "$KEEP_OUT" == 1 ]] && echo "raw samples in ${OUT}/ (one 'status ttfb total' line per request)"
echo "Server-side breakdown: in the ingress log group, REPORT lines (init, duration) and 'request served' (totalMs, backendInvokeSeconds) from $(date -u -d "@${RUN}" +%FT%TZ 2>/dev/null || date -u -r "${RUN}" +%FT%TZ)."
