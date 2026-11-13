#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 3: count scale at the tier's size
# (design/agentic-runtime-isolation.stress-test.md §5 Phase 1, steps 1.4 to 1.7).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small] [STRESS_PREFIX=RuntimeIsolationStress] scripts/stress/count.sh
#
#   1.4 one `report` probe per active tenant (a new conversation each) at 20 a
#       second, after one IssueToken per tenant at 8 a second; p90 TTFB of
#       all of them against the first 100; every report names its own tenant.
#   1.5 one tenant with every tool: the `report` probe's scope size, then the
#       agent's `tools` probe (tools/list on every gateway, all pages).
#   1.6 large only: a subscription naming every tool by name; 200 or 502
#       grant_too_large, never a 500. Skipped at small and medium.
#   1.7 new ingress and authoriser instances (an environment marker), then
#       one probe per agent at once; `registry_unavailable` in the ingress
#       log group is counted (documented behaviour, ADR-0040 registry cache).
#
# Needs deploy.sh and seed.sh first. Tokens live in shell variables and, for
# the 1.4 batch, in mode-0600 files inside the run's temp directory, removed
# on exit; nothing prints them. Prints the step table (integ.sh style).
# Conventions: scripts/CONVENTIONS.md.

# Token variables are passed to the helpers by NAME and read there as ${!name}.
# shellcheck disable=SC2034

# Functions run from the trap, launch and check; T_ACCESS is set by issue_token through printf -v.
# shellcheck disable=SC2329,SC2153

set -euo pipefail

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

LIB_TMP="$(mktemp -d)"
MAIN_TMP="$LIB_TMP"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"
SUB_RESTORE=""
MARKER_RESTORE=()
cleanup() {
  local code=$?
  set +e
  jobs -rp | xargs -r kill 2>/dev/null
  wait 2>/dev/null
  for r in "${MARKER_RESTORE[@]:-}"; do
    [[ -n "$r" ]] || continue
    aws lambda update-function-configuration --function-name "${r%%|*}" --environment "${r#*|}" >/dev/null 2>&1 \
      && aws lambda wait function-updated --function-name "${r%%|*}" 2>/dev/null \
      || echo "cleanup: restore the environment of ${r%%|*} failed; redeploy the stack to clear STRESS_INSTANCE_MARKER" >&2
  done
  if [[ -n "$SUB_RESTORE" ]]; then
    LIB_TMP="$MAIN_TMP"; BODY="${MAIN_TMP}/body"; REQ="${MAIN_TMP}/request"
    st="$(vendor PUT "tenants/${SUB_RESTORE}" "$SUBSCRIPTION")"
    [[ "$st" =~ ^20[04]$ ]] || echo "cleanup: restore the subscription of ${SUB_RESTORE}: HTTP ${st}" >&2
  fi
  rm -rf "$MAIN_TMP"
  exit "$code"
}
trap cleanup EXIT

[[ -s "$OUTPUTS" ]] || fail "no ${OUTPUTS}; run scripts/stress/deploy.sh first"
[[ -s "$MANIFEST" ]] || fail "no ${MANIFEST}; run scripts/stress/seed.sh first"
output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || fail "output $1 missing from ${OUTPUTS}"; printf '%s' "$v"; }
ENDPOINT="$(need EndpointUrl)"
ENT_API="$(need EntitlementsApiUrl)"
LOG_GROUP="$(need IngressLogGroupName)"
AUTHORIZER_FN="$(need AuthorizerFunctionName)"
INGRESS_FN="$(need IngressFunctionName)"

TIER="$(STRESS_SCALE="$SCALE" npx ts-node -P tsconfig.json --prefer-ts-exts \
  -e "console.log(JSON.stringify(require('./test/stress/tiers').tierOf(process.env.STRESS_SCALE)))" 2>"${LIB_TMP}/tier.err" | tail -1)" || true
jq -e 'type == "object" and has("tenantsActive")' <<<"$TIER" >/dev/null 2>&1 \
  || { tail -5 "${LIB_TMP}/tier.err" >&2; fail "could not read the ${SCALE} tier from test/stress/tiers.ts (tierOf)"; }
AGENTS_JSON="$(jq -c '.agents | if type == "array" then . else ["default"] + [range(1; .) | "a" + ("00" + tostring)[-3:]] end' <<<"$TIER")"
TARGETS_JSON="$(jq -c '.toolTargets | if type == "array" then map(if type == "object" then .name else . end) else [range(1; . + 1) | "t" + ("0" + tostring)[-2:]] end' <<<"$TIER")"
TOOLS_PER="$(jq -r .toolsPerTarget <<<"$TIER")"
SUBSCRIPTION="$(jq -nc --argjson a "$AGENTS_JSON" --argjson t "$TARGETS_JSON" '{agents: $a, tools: ($t | map(. + "/*"))}')"
TOOLS_TOTAL=$(( $(jq length <<<"$TARGETS_JSON") * TOOLS_PER ))

identity_init
RUN="$(date +%s)"
echo "scale=${SCALE} prefix=${PREFIX} started=$(date -u +%FT%TZ) (endpoint resolved; not printed)"

# -- the step table (as integ.sh) --------------------------------------------
TABLE="${LIB_TMP}/steps"
: >"$TABLE"
CUR=""; CUR_FAIL=""; CUR_EVIDENCE=""; FAILED=0
begin() { CUR="$1"; CUR_FAIL=""; CUR_EVIDENCE=""; echo "== step $1: $2"; }
check() {
  local msg="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then CUR_FAIL="${CUR_FAIL:+${CUR_FAIL}; }${msg}"; echo "  FAIL: ${msg}" >&2; fi
}
note() { CUR_EVIDENCE="${CUR_EVIDENCE:+${CUR_EVIDENCE}; }$*"; echo "  $*"; }
end_step() {
  local result=PASS
  if [[ -n "$CUR_FAIL" ]]; then result=FAIL; FAILED=1; fi
  printf '%s|%s|%s\n' "$CUR" "$result" "${CUR_FAIL:-$CUR_EVIDENCE}" >>"$TABLE"
}
skip_step() { printf '%s|SKIP|%s\n' "$1" "$2" >>"$TABLE"; echo "== step $1: SKIP ($2)"; }
eq() { [[ "$1" == "$2" ]]; }
le() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'; }
print_table() {
  echo "== results"
  awk -F'|' 'BEGIN { printf "%-6s | %-4s | %s\n", "step", "", "evidence"; print "-------|------|---------" }
    { printf "%-6s | %-4s | %s\n", $1, $2, $3 }' "$TABLE"
}

# -- pacing and per-job lib state --------------------------------------------
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
MAX_JOBS=40
launch() { # INTERVAL_MS FN ARGS...
  local interval="$1"
  shift
  (( interval > 0 )) && pace "$interval"
  while (( $(jobs -rp | wc -l) >= MAX_JOBS )); do wait -n 2>/dev/null || true; done
  "$@" &
}
# job_init: lib.sh's BODY, REQ and timing file are shared; a parallel job gets its own (as perf.sh does).
job_init() {
  LIB_TMP="$(mktemp -d -p "$MAIN_TMP")"
  BODY="${LIB_TMP}/body"; REQ="${LIB_TMP}/request"
  : >"$BODY"; : >"$REQ"; : >"${LIB_TMP}/timing"; chmod 600 "$BODY" "$REQ"
}
body() { jq -nc --arg c "$1" --arg p "$2" '{conversationId: $c, prompt: $p}'; }

# new_instances FUNCTION: an environment marker change retires every warm instance (§13 question 2).
new_instances() {
  local env="${LIB_TMP}/env.json" before
  : >"$env"; chmod 600 "$env"
  before="$(aws lambda get-function-configuration --function-name "$1" --query 'Environment.Variables' --output json)"
  # The environment as deployed, put back from the trap (as scripts/integ.sh
  # does): the marker is for this run only, and a stack left with it drifts
  # from its template until the next deploy.
  MARKER_RESTORE+=("$1|$(jq -c '{Variables: (. // {})}' <<<"$before")")
  jq -c --arg m "$RUN" '{Variables: ((. // {}) + {STRESS_INSTANCE_MARKER: $m})}' <<<"$before" >"$env"
  aws lambda update-function-configuration --function-name "$1" --environment "file://${env}" >/dev/null \
    || fail "update-function-configuration $1"
  : >"$env"
  aws lambda wait function-updated --function-name "$1" || fail "wait function-updated $1"
}

mapfile -t ACTIVE_ROWS < <(jq -r '.tenants[] | select(.active) | [.tenantId, .admin] | @tsv' "$MANIFEST")
N_ACTIVE="${#ACTIVE_ROWS[@]}"
(( N_ACTIVE > 0 )) || fail "the manifest has no active tenant; run scripts/stress/seed.sh"
IFS=$'\t' read -r T0 T0_USER <<<"${ACTIVE_ROWS[0]}"

# --------------------------------------------------------------------------
begin 1.4 "${N_ACTIVE} report probes, one per active tenant, at 20/s"
TOK_DIR="${MAIN_TMP}/tokens"; RES_DIR="${MAIN_TMP}/probes"
mkdir -m 700 "$TOK_DIR" "$RES_DIR"
job_token() { # INDEX TENANT USER
  job_init
  ( umask 077; issue_token "$2" "$3" J && printf '%s' "$J_ACCESS" >"${TOK_DIR}/$1" ) || true
  rm -rf "$LIB_TMP"
}
job_probe() { # INDEX TENANT
  local status tenant=""
  job_init
  [[ -s "${TOK_DIR}/$1" ]] || { echo "notoken 0 -" >"${RES_DIR}/$1"; return 0; }
  J_ACCESS="$(<"${TOK_DIR}/$1")"
  status="$(invoke "$(backend_url "$ENDPOINT" default)" J_ACCESS "$(body "stresscount${RUN}x$1" report)")" || status=000
  timing
  [[ "$status" == 200 ]] && tenant="$(report_field '.tokenTenant // empty' 2>/dev/null || true)"
  if [[ "$status" == 200 && "$tenant" != "$2" ]]; then status=mismatch; fi
  echo "${status} ${LAST_TTFB:-0}" >"${RES_DIR}/$1"
  J_ACCESS=""
  rm -rf "$LIB_TMP"
}
START=$SECONDS
for i in "${!ACTIVE_ROWS[@]}"; do
  IFS=$'\t' read -r tid user <<<"${ACTIVE_ROWS[$i]}"
  launch 125 job_token "$i" "$tid" "$user"
done
wait
LIB_TMP="$MAIN_TMP"; BODY="${MAIN_TMP}/body"; REQ="${MAIN_TMP}/request"
TOKENS="$(find "$TOK_DIR" -type f -size +0 | wc -l)"
note "${TOKENS} of ${N_ACTIVE} tokens issued in $((SECONDS - START))s"
START=$SECONDS
for i in "${!ACTIVE_ROWS[@]}"; do
  IFS=$'\t' read -r tid _ <<<"${ACTIVE_ROWS[$i]}"
  launch 50 job_probe "$i" "$tid"
done
wait
LIB_TMP="$MAIN_TMP"; BODY="${MAIN_TMP}/body"; REQ="${MAIN_TMP}/request"
rm -rf "$TOK_DIR"
ALL="${MAIN_TMP}/ttfb.all"; FIRST="${MAIN_TMP}/ttfb.first"
: >"$ALL"; : >"$FIRST"
for ((i = 0; i < N_ACTIVE; i++)); do
  read -r st t <"${RES_DIR}/${i}" || continue
  [[ "$st" == 200 ]] || continue
  echo "$t" >>"$ALL"
  (( i < 100 )) && echo "$t" >>"$FIRST"
done
HIST="$(cat "${RES_DIR}"/* | awk '{print $1}' | sort | uniq -c | awk '{printf "%s:%s ", $2, $1}')"
MISMATCH="$(cat "${RES_DIR}"/* | awk '$1 == "mismatch"' | wc -l)"
OK="$(wc -l <"$ALL")"
check "${MISMATCH} reports named another tenant" eq "$MISMATCH" 0
check "$((N_ACTIVE - OK)) probes were not 200 (${HIST})" eq "$OK" "$N_ACTIVE"
if (( OK > 0 )); then
  P90_ALL="$(percentile 90 "$ALL")"; P90_FIRST="$(percentile 90 "$FIRST")"
  check "p90 TTFB ${P90_ALL}s is over 1.2x the first-100 p90 ${P90_FIRST}s" le "$P90_ALL" "$(awk -v f="$P90_FIRST" 'BEGIN { print f * 1.2 }')"
  note "status ${HIST}; p90 TTFB all ${P90_ALL}s, first $(wc -l <"$FIRST") ${P90_FIRST}s; probes in $((SECONDS - START))s"
fi
note "grant time from the authoriser log not read here (collect.sh reads request served)"
end_step

# --------------------------------------------------------------------------
begin 1.5 "one tenant with all ${TOOLS_TOTAL} tools: scope size, then tools/list on every gateway"
# The gateways take the transaction token the ingress mints, not an identity
# token, so tools/list runs through the agent's `tools` probe (lib.sh
# probe_tools), which pages through every gateway the token names.
issue_token "$T0" "$T0_USER" T
status="$(invoke "$(backend_url "$ENDPOINT" default)" T_ACCESS "$(body "stresscount${RUN}tools" report)")"
if [[ "$status" == 200 ]]; then
  SCOPE_BYTES="$(report_json | jq -r '(.tokenScope // "") | utf8bytelength')"
  check "scope ${SCOPE_BYTES} bytes is not under 6144" le "$SCOPE_BYTES" 6143
  note "report 200; scope ${SCOPE_BYTES} bytes; encoded token bytes not exposed by the report"
  status="$(invoke "$(backend_url "$ENDPOINT" default)" T_ACCESS "$(body "stresscount${RUN}tools" tools)")"
  check "tools probe: HTTP ${status}" eq "$status" 200
  PER_GW="$(report_json | jq -r '.result | to_entries | map("\(.key)=\(if .value.tools then (.value.tools | length | tostring) else ("error:" + (.value.error // "?")) end)") | join(" ")' 2>/dev/null || true)"
  SEEN="$(report_json | jq -r '[.result[]?.tools[]?] | length' 2>/dev/null || echo 0)"
  GW_ERRORS="$(report_json | jq -r '[.result[]? | select(.error)] | length' 2>/dev/null || echo 0)"
  check "${GW_ERRORS} gateways answered an error (${PER_GW})" eq "$GW_ERRORS" 0
  check "tools/list returned ${SEEN} tools, the tier has ${TOOLS_TOTAL}" eq "$SEEN" "$TOOLS_TOTAL"
  note "tools per gateway: ${PER_GW:-none}"
elif [[ "$status" == 502 ]] && grep -q grant_too_large "$BODY"; then
  note "502 grant_too_large (documented refusal)"
else
  check "report for the all-tools tenant: HTTP ${status}" eq "$status" 200
fi
end_step

# --------------------------------------------------------------------------
if [[ "$SCALE" != large ]]; then
  skip_step 1.6 "large only: the grant cannot tip at ${TOOLS_TOTAL} tools; includeUserIdTag needs a redeploy in any case"
else
  begin 1.6 "a subscription naming all ${TOOLS_TOTAL} tools: 200 or 502 grant_too_large, never 500"
  NAMED="$(jq -nc --argjson a "$AGENTS_JSON" --argjson t "$TARGETS_JSON" --argjson n "$TOOLS_PER" \
    '{agents: $a, tools: [$t[] as $g | range(1; $n + 1) | "\($g)/tool_\(("00" + tostring)[-3:])"]}')"
  SUB_RESTORE="$T0"
  st="$(vendor PUT "tenants/${T0}" "$NAMED")"
  check "PutTenantSubscription with ${TOOLS_TOTAL} named tools: HTTP ${st}" eq "$([[ "$st" =~ ^20[04]$ ]] && echo ok)" ok
  issue_token "$T0" "$T0_USER" T   # a new token misses the authoriser cache
  status="$(invoke "$(backend_url "$ENDPOINT" default)" T_ACCESS "$(body "stresscount${RUN}named" report)")"
  verdict=bad
  [[ "$status" == 200 ]] && verdict=ok
  [[ "$status" == 502 ]] && grep -q grant_too_large "$BODY" && verdict=ok
  check "named-tools report: HTTP ${status}, expected 200 or 502 grant_too_large" eq "$verdict" ok
  st="$(vendor PUT "tenants/${T0}" "$SUBSCRIPTION")"
  [[ "$st" =~ ^20[04]$ ]] && SUB_RESTORE=""
  note "HTTP ${status}; tvm.includeUserIdTag not applied (a redeploy, out of this script)"
  end_step
fi

# --------------------------------------------------------------------------
N_AGENTS="$(jq length <<<"$AGENTS_JSON")"
begin 1.7 "new instances, then ${N_AGENTS} probes at once, one per agent; registry_unavailable counted"
new_instances "$AUTHORIZER_FN"
new_instances "$INGRESS_FN"
issue_token "$T0" "$T0_USER" T
T_FILE="${MAIN_TMP}/t17"
( umask 077; printf '%s' "$T_ACCESS" >"$T_FILE" )
job_agent() { # INDEX AGENT
  local status
  job_init
  J_ACCESS="$(<"$T_FILE")"
  status="$(invoke "$(backend_url "$ENDPOINT" "$2")" J_ACCESS "$(body "stresscount${RUN}r$1" report)")" || status=000
  grep -q registry_unavailable "$BODY" && status="${status}-registry_unavailable"
  echo "$status" >"${RES_DIR}/agent-$1"
  J_ACCESS=""
  rm -rf "$LIB_TMP"
}
SINCE_MS="$(date +%s%3N)"
i=0
while read -r agent; do launch 0 job_agent "$i" "$agent"; i=$((i + 1)); done < <(jq -r '.[]' <<<"$AGENTS_JSON")
wait
LIB_TMP="$MAIN_TMP"; BODY="${MAIN_TMP}/body"; REQ="${MAIN_TMP}/request"
rm -f "$T_FILE"
HIST="$(cat "${RES_DIR}"/agent-* | sort | uniq -c | awk '{printf "%s:%s ", $2, $1}')"
log_count() { # FILTER_PATTERN -> lines in the ingress log group since SINCE_MS
  # One number: a paginated answer prints one count per page, so sum them;
  # a failed call counts as 0.
  aws logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$SINCE_MS" --filter-pattern "$1" \
    --query 'length(events)' --output text 2>/dev/null | awk '{ s += $1 } END { print s + 0 }'
}
seen=0
for _ in 1 2 3 4 5 6; do   # log delivery lags a few seconds; 15 s between reads, 90 s at most
  seen="$(log_count '"request"')"
  (( seen >= N_AGENTS )) && break
  sleep 15
done
UNAVAILABLE="$(log_count '"registry_unavailable"')"
note "status ${HIST}; ${UNAVAILABLE} registry_unavailable lines in the ingress log group (${seen} request lines read); documented: a throttled read is cached as registry_unavailable for one registryTtl on that instance"
end_step

print_table
echo "finished=$(date -u +%FT%TZ) wall_seconds=${SECONDS}"
exit "$FAILED"
