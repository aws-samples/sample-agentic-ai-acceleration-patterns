#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 5: collect one run (design/agentic-runtime-isolation.stress-test.md §4, §7, §7.1, §11).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small] [STRESS_PREFIX=RuntimeIsolationStress] \
#     [STRESS_BASELINE_TTFB_P90_MS=<perf.sh p90 TTFB of the day, ms>] scripts/stress/collect.sh <run-id>
#
# For the run window run.sh recorded (runs/<run-id>/window.json):
#   - Logs Insights on the ingress log group: `request served` count and
#     p50/p90/max of totalMs and ttfbMs, the mint hit ratio; `request refused`
#     429 by tenantId and minute (joined against served per tenant-minute);
#     5xx refusals; `sdk retried` sum(attempts - 1) by service (§7.1);
#   - CloudWatch: API Gateway Count/4XXError/5XXError/Latency, Lambda
#     Throttles/ConcurrentExecutions for the authoriser and the ingress
#     function, DynamoDB ThrottledRequests on the entitlement store;
#   - the k6 summary.
# Writes everything to runs/<run-id>/collect.json (outside the repo) and
# appends a section to design/stress-results/<YYYY-MM-DD>-<scale>.md after a
# redaction check: it refuses to write anything that holds a 12-digit number,
# a tenant id, tenant name or user name from the manifest, `eyJ` or
# `https://`. Prints the pass table. Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap and through pf; the backticks in printf formats are literal Markdown.
# shellcheck disable=SC2329,SC2016

set -euo pipefail

RUN_ID="${1:-}"
[[ "$RUN_ID" =~ ^s[1-7]-[a-z]+-[0-9]{8}T[0-9]{6}Z$ ]] || { echo "usage: $0 <run-id> (as printed by run.sh, e.g. s1-small-20261109T101500Z)" >&2; exit 2; }

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region the stress stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws jq git awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SAMPLE_DIR"
PREFIX="${STRESS_PREFIX:-RuntimeIsolationStress}"
[[ "$PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 1; }
STATE_DIR="${HOME}/.runtime-isolation-stress/${PREFIX}"
OUTPUTS="${STATE_DIR}/outputs.json"
MANIFEST="${STATE_DIR}/manifest.json"
TIMINGS="${STATE_DIR}/timings.txt"
RUN_DIR="${STATE_DIR}/runs/${RUN_ID}"
WINDOW="${RUN_DIR}/window.json"

LIB_TMP="$(mktemp -d)"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"
trap 'rm -rf "$LIB_TMP"' EXIT

[[ -s "$WINDOW" ]] || fail "no ${WINDOW}; run scripts/stress/run.sh first"
[[ -s "$OUTPUTS" ]] || fail "no ${OUTPUTS}"
[[ -s "$MANIFEST" ]] || fail "no ${MANIFEST}"
output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || fail "output $1 missing from ${OUTPUTS}"; printf '%s' "$v"; }
LOG_GROUP="$(need IngressLogGroupName)"
AUTHORIZER_FN="$(need AuthorizerFunctionName)"
INGRESS_FN="$(need IngressFunctionName)"
ENT_TABLE="$(need EntitlementsTableName)"
REST_API_ID="$(need RestApiId)"
STAGE="$(need StageName)"
SCENARIO="$(jq -r .scenario "$WINDOW")"
SCALE="$(jq -r .scale "$WINDOW")"
START="$(jq -r .start "$WINDOW")"
END="$(jq -r .end "$WINDOW")"
# Log delivery and Logs Insights indexing lag the request by up to about two
# minutes; a query run right after the run undercounts (seen 2026-11-09: 117
# of 474 refusals). Wait until the window is 150 s old.
settle=$(( END + 150 - $(date +%s) ))
if (( settle > 0 )); then
  echo "waiting ${settle}s for the log group to settle"
  sleep "$settle"
fi
# Log delivery lags; read a minute past the end.
END_LOGS=$((END + 60))
iso() { date -u -d "@$1" +%FT%TZ; }
echo "run_id=${RUN_ID} scenario=${SCENARIO} scale=${SCALE} window $(iso "$START") .. $(iso "$END")"

# -- Logs Insights -----------------------------------------------------------
# insights NAME QUERY -> runs/<run-id>/insights-NAME.json, rows as objects.
insights() {
  local name="$1" query="$2" qid status raw="${LIB_TMP}/q.json" waited=0
  qid="$(aws logs start-query --log-group-name "$LOG_GROUP" --start-time "$START" --end-time "$END_LOGS" \
    --query-string "$query" --query queryId --output text)" || fail "start-query ${name}"
  while :; do
    aws logs get-query-results --query-id "$qid" --output json >"$raw" || fail "get-query-results ${name}"
    status="$(jq -r .status "$raw")"
    [[ "$status" =~ ^(Scheduled|Running)$ ]] || break
    (( waited < 600 )) || fail "Logs Insights query ${name} still ${status} after 600 s"
    sleep 5; waited=$((waited + 5))
  done
  [[ "$status" == Complete ]] || fail "Logs Insights query ${name}: ${status}"
  jq '[.results[] | map({(.field): .value}) | add]' "$raw" >"${RUN_DIR}/insights-${name}.json"
  echo "  insights ${name}: $(jq length "${RUN_DIR}/insights-${name}.json") rows"
}
echo "== Logs Insights on the ingress log group"
insights served 'filter message = "request served"
| stats count(*) as served, pct(totalMs, 50) as totalP50, pct(totalMs, 90) as totalP90, max(totalMs) as totalMax,
  pct(ttfbMs, 50) as ttfbP50, pct(ttfbMs, 90) as ttfbP90, max(ttfbMs) as ttfbMax'
insights mint 'filter message = "request served" | stats count(*) as n by mint'
insights served_by_minute 'filter message = "request served" | stats count(*) as n by tenantId, bin(1m) as minute | limit 10000'
insights refused_429 'filter message = "request refused" and status = 429 | stats count(*) as n by tenantId, bin(1m) as minute | limit 10000'
insights refused_5xx 'filter message = "request refused" and status >= 500 | fields ispresent(tenantId) as withTenant | stats count(*) as n by status, reason, withTenant'
insights retried 'filter message = "sdk retried" | fields attempts - 1 as extra, ispresent(error) as failedAll | stats sum(extra) as retries, count(*) as lines, sum(failedAll) as exhausted by service'

# -- CloudWatch metrics ------------------------------------------------------
# metric NAMESPACE NAME STAT DIMENSIONS... -> the sum (Sum) or the max (Maximum, Average) over the window.
metric() {
  local ns="$1" name="$2" stat="$3" agg
  shift 3
  [[ "$stat" == Sum ]] && agg='add // 0' || agg='max // 0'
  aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$name" --statistics "$stat" --period 60 \
    --start-time "$(iso "$START")" --end-time "$(iso "$END_LOGS")" --dimensions "$@" --output json \
    | jq "[.Datapoints[].${stat}] | ${agg}"
}
echo "== CloudWatch metrics"
API_NAME="$(aws apigateway get-rest-api --rest-api-id "$REST_API_ID" --query name --output text)"
# shellcheck disable=SC2054  # CLI shorthand: Name=...,Value=... is one element
APIGW=(Name=ApiName,Value="$API_NAME" Name=Stage,Value="$STAGE")
DDB_THROTTLED="$(aws cloudwatch get-metric-data --start-time "$(iso "$START")" --end-time "$(iso "$END_LOGS")" --output json \
  --metric-data-queries "$(jq -nc --arg t "$ENT_TABLE" '[{Id: "t", ReturnData: true,
    Expression: ("SUM(SEARCH(\u0027{AWS/DynamoDB,TableName,Operation} MetricName=\"ThrottledRequests\" TableName=\"" + $t + "\"\u0027, \u0027Sum\u0027, 60))")}]')" \
  | jq '[.MetricDataResults[].Values[]] | add // 0')"
jq -n \
  --argjson count "$(metric AWS/ApiGateway Count Sum "${APIGW[@]}")" \
  --argjson e4 "$(metric AWS/ApiGateway 4XXError Sum "${APIGW[@]}")" \
  --argjson e5 "$(metric AWS/ApiGateway 5XXError Sum "${APIGW[@]}")" \
  --argjson lat "$(metric AWS/ApiGateway Latency Maximum "${APIGW[@]}")" \
  --argjson lat_avg "$(metric AWS/ApiGateway Latency Average "${APIGW[@]}")" \
  --argjson authThr "$(metric AWS/Lambda Throttles Sum Name=FunctionName,Value="$AUTHORIZER_FN")" \
  --argjson ingThr "$(metric AWS/Lambda Throttles Sum Name=FunctionName,Value="$INGRESS_FN")" \
  --argjson authConc "$(metric AWS/Lambda ConcurrentExecutions Maximum Name=FunctionName,Value="$AUTHORIZER_FN")" \
  --argjson ingConc "$(metric AWS/Lambda ConcurrentExecutions Maximum Name=FunctionName,Value="$INGRESS_FN")" \
  --argjson ddb "$DDB_THROTTLED" \
  '{apiGateway: {count: $count, "4xx": $e4, "5xx": $e5, latencyMaxMs: $lat, latencyAvgMaxMs: $lat_avg},
    lambda: {authorizerThrottles: $authThr, ingressThrottles: $ingThr, authorizerConcurrencyMax: $authConc, ingressConcurrencyMax: $ingConc},
    dynamodb: {entitlementsThrottledRequests: $ddb}}' >"${RUN_DIR}/metrics.json"
echo "  $(jq -c . "${RUN_DIR}/metrics.json")"

# -- k6 summary --------------------------------------------------------------
SUMMARY="${RUN_DIR}/summary.json"
[[ -s "$SUMMARY" ]] || echo '{"metrics": {}}' >"${LIB_TMP}/empty.json"
[[ -s "$SUMMARY" ]] || SUMMARY="${LIB_TMP}/empty.json"
k6m() { # METRIC FIELD -> value or null (summary-export and handleSummary layouts)
  jq -c --arg k "$1" --arg f "$2" '(.metrics[$k].values // .metrics[$k]) as $v | if $v == null then null else $v[$f] end' "$SUMMARY"
}
K6="$(jq -n \
  --argjson reqs "$(k6m http_reqs count)" \
  --argjson p90 "$(k6m http_req_duration 'p(90)')" \
  --argjson wait90 "$(k6m http_req_waiting 'p(90)')" \
  --argjson failed "$(k6m http_req_failed value)" \
  --argjson failedRate "$(k6m http_req_failed rate)" \
  --argjson mismatch "$(k6m isolation_mismatch count)" \
  --argjson pcf "$(k6m positive_control_fail count)" \
  --argjson s429 "$(k6m status_429 count)" \
  '{requests: $reqs, durationP90Ms: $p90, ttfbP90Ms: $wait90, failedRate: ($failed // $failedRate),
    isolationMismatch: $mismatch, positiveControlFail: $pcf, status429: $s429}')"

# -- assemble ----------------------------------------------------------------
I="$RUN_DIR"
jq -n --argjson w "$(cat "$WINDOW")" --argjson k6 "$K6" --argjson m "$(cat "${RUN_DIR}/metrics.json")" \
  --slurpfile served "${I}/insights-served.json" --slurpfile mint "${I}/insights-mint.json" \
  --slurpfile sbm "${I}/insights-served_by_minute.json" --slurpfile r429 "${I}/insights-refused_429.json" \
  --slurpfile r5 "${I}/insights-refused_5xx.json" --slurpfile retried "${I}/insights-retried.json" '
  def num: if . == null then 0 else tonumber end;
  ($sbm[0] | map({key: "\(.tenantId)|\(.minute)", value: (.n | num)}) | from_entries) as $servedAt
  | {window: $w, k6: $k6, metrics: $m,
     served: ($served[0][0] // {} | map_values(tonumber? // .)),
     mintHitRatio: (($mint[0] | map(select(.mint == "hit") | .n | num) | add // 0) as $h
                    | ($mint[0] | map(.n | num) | add // 0) as $t | if $t == 0 then null else ($h / $t) end),
     refused429: ($r429[0] | map(.n | num) | add // 0),
     refused429Untagged: ($r429[0] | map(select((.tenantId // "") == "") | .n | num) | add // 0),
     # A 429 in a minute where the tenant had under 60 served requests. The
     # limiter bins by request start, the served line by request end, so a
     # request that crosses a minute boundary lands in the next bin: a
     # tenant-minute counts only when it is more than 5 under the limit, and
     # the first and last minutes of the window are skipped (they are partial).
     refused429UnderLimit: ($r429[0] | map(select((.tenantId // "") != ""
        and (.minute | .[0:16]) != ($w.start | todate | .[0:16] | sub("T"; " "))
        and (.minute | .[0:16]) != ($w.end | todate | .[0:16] | sub("T"; " "))
        and (($servedAt["\(.tenantId)|\(.minute)"] // 0) < 55))) | length),
     tenants429: ($r429[0] | map(.tenantId) | unique | length),
     refused5xx: ($r5[0] | map(.n | num) | add // 0),
     refused5xxWithTenant: ($r5[0] | map(select(.withTenant == "1" or .withTenant == "true") | .n | num) | add // 0),
     refused5xxReasons: ($r5[0] | map({key: "\(.status) \(.reason // "none")", value: (.n | num)}) | from_entries),
     sdkRetried: ($retried[0] | map({key: (.service // "unknown"), value: {retries: (.retries | num), lines: (.lines | num), exhausted: (.exhausted | num)}}) | from_entries)}' \
  >"${RUN_DIR}/collect.json"
C="${RUN_DIR}/collect.json"
v() { jq -r "$1" "$C"; }

# -- the pass table (§4) -----------------------------------------------------
ROWS="${LIB_TMP}/rows"
: >"$ROWS"
row() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$ROWS"; }
pf() { if "$@"; then echo PASS; else echo FAIL; fi; }
zero() { awk -v a="$1" 'BEGIN { exit !(a + 0 == 0) }'; }

MISMATCH="$(v '.k6.isolationMismatch // "n/a"')"
PCF="$(v '.k6.positiveControlFail // "n/a"')"
REQS="$(v '.k6.requests // 0')"
# read-own is 20 % of the probes (§6): the positive control passes at a 99.9 % success rate.
PCF_LIMIT="$(awk -v r="$REQS" 'BEGIN { printf "%d", r * 0.2 * 0.001 }')"
if [[ "$MISMATCH" == n/a || "$PCF" == n/a ]]; then
  row "Cross-tenant mismatch (§6)" "k6 counters missing" FAIL
else
  verdict=FAIL
  if zero "$MISMATCH" && awk -v a="$PCF" -v b="$PCF_LIMIT" 'BEGIN { exit !(a <= b) }'; then verdict=PASS; fi
  row "Cross-tenant mismatch (§6)" "mismatch ${MISMATCH}, positive-control failures ${PCF} (limit ${PCF_LIMIT})" "$verdict"
fi
E5="$(v '.metrics.apiGateway["5xx"]')"
R5T="$(v .refused5xxWithTenant)"
LT="$(v '(.metrics.lambda.authorizerThrottles // 0) + (.metrics.lambda.ingressThrottles // 0)')"
if [[ "$SCENARIO" == s6 ]]; then
  row "5xx from the ingress" "API Gateway 5xx ${E5}; refusals naming a tenant ${R5T} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" \
    "$(pf awk -v a="$E5" -v b="$R5T" 'BEGIN { exit !(a <= b) }')"
elif [[ "$SCENARIO" == s2 ]]; then
  # The herd is the one scenario that may throttle the ingress Lambda; each
  # throttle is one API Gateway 500 with no tenant (finding F-1 in the plan).
  # Every other 5xx must name a tenant and a reason.
  row "5xx from the ingress" "API Gateway 5xx ${E5}; refusals naming a tenant ${R5T}; Lambda throttles ${LT} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" \
    "$(pf awk -v a="$E5" -v b="$R5T" -v c="$LT" 'BEGIN { exit !(a <= b + c) }')"
else
  row "5xx from the ingress" "API Gateway 5xx ${E5} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" "$(pf zero "$E5")"
fi
R429="$(v .refused429)"; K429="$(v '.k6.status429 // "n/a"')"
verdict=FAIL
# The k6 count and the logged count may differ by the requests in flight at
# the window's edges (log delivery lags a few seconds): equal within 1 % or 2.
if [[ "$(v .refused429Untagged)" == 0 && "$(v .refused429UnderLimit)" == 0 ]] \
  && { [[ "$K429" == n/a ]] || awk -v k="$K429" -v r="$R429" 'BEGIN { d = k - r; if (d < 0) d = -d; t = r / 100; if (t < 2) t = 2; exit !(d <= t) }'; }; then verdict=PASS; fi
row "429 attribution" "logged 429 ${R429} over $(v .tenants429) tenants, untagged $(v .refused429Untagged), tenant-minutes under the limit $(v .refused429UnderLimit), k6 429 ${K429}" "$verdict"
STS="$(v '.sdkRetried.sts.retries // 0')"; KMS="$(v '.sdkRetried.kms.retries // 0')"
if [[ "$SCENARIO" == s2 ]]; then
  row "STS AssumeRole throttles (sdk retried)" "retries ${STS}, exhausted $(v '.sdkRetried.sts.exhausted // 0') (counted for the herd)" INFO
else
  row "STS AssumeRole throttles (sdk retried)" "retries ${STS}" "$(pf zero "$STS")"
fi
row "KMS Sign throttles (sdk retried)" "retries ${KMS}" "$(pf zero "$KMS")"
LT=$(( $(v .metrics.lambda.authorizerThrottles | cut -d. -f1) + $(v .metrics.lambda.ingressThrottles | cut -d. -f1) ))
if [[ "$SCENARIO" == s2 ]]; then
  row "Lambda Throttles" "${LT} (concurrency max authoriser $(v .metrics.lambda.authorizerConcurrencyMax), ingress $(v .metrics.lambda.ingressConcurrencyMax)); counted for the herd (F-1)" "INFO"
else
row "Lambda Throttles" "${LT} (concurrency max authoriser $(v .metrics.lambda.authorizerConcurrencyMax), ingress $(v .metrics.lambda.ingressConcurrencyMax))" "$(pf zero "$LT")"
fi
DDB="$(v .metrics.dynamodb.entitlementsThrottledRequests)"
row "DynamoDB ThrottledRequests (entitlement store)" "${DDB}" "$(pf zero "$DDB")"
TTFB90="$(v '.k6.ttfbP90Ms // "n/a"')"
if [[ -n "${STRESS_BASELINE_TTFB_P90_MS:-}" && "$TTFB90" != n/a ]]; then
  row "p90 TTFB within 1.5x of perf.sh" "${TTFB90} ms vs baseline ${STRESS_BASELINE_TTFB_P90_MS} ms" \
    "$(pf awk -v a="$TTFB90" -v b="$STRESS_BASELINE_TTFB_P90_MS" 'BEGIN { exit !(a <= 1.5 * b) }')"
else
  row "p90 TTFB within 1.5x of perf.sh" "${TTFB90} ms; no STRESS_BASELINE_TTFB_P90_MS" N/A
fi
row "p90 TTFB flat (large vs 100 tenants)" "compare this file with the medium-tier result" N/A

# -- the results file --------------------------------------------------------
DATE="$(date -u +%F)"
RESULTS_DIR="${SAMPLE_DIR}/design/stress-results"
RESULTS="${RESULTS_DIR}/${DATE}-${SCALE}.md"
SECTION="${LIB_TMP}/section.md"
{
  if [[ ! -f "$RESULTS" ]]; then
    printf '# Stress results %s, scale %s\n\nWritten by `scripts/stress/collect.sh` (design/agentic-runtime-isolation.stress-test.md §11).\n' "$DATE" "$SCALE"
  fi
  printf '\n## %s\n\n' "$RUN_ID"
  printf -- '- Commit tested: `%s`\n- Scale: %s\n- Scenario: %s\n- Run window (UTC): %s to %s (%s s)\n- k6 command: %s\n\n' \
    "$(git rev-parse --short HEAD)" "$SCALE" "$SCENARIO" "$(iso "$START")" "$(iso "$END")" "$((END - START))" "$(v .window.commandStatus)"
  printf '| Check | Measured | Result |\n|---|---|---|\n'
  awk -F'|' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }' "$ROWS"
  printf '\n| Counter | Value |\n|---|---|\n'
  jq -r '[
      ["k6 requests", .k6.requests], ["k6 http_req_duration p90 ms", .k6.durationP90Ms], ["k6 TTFB p90 ms", .k6.ttfbP90Ms],
      ["k6 http_req_failed rate", .k6.failedRate], ["request served", .served.served],
      ["totalMs p50/p90/max", "\(.served.totalP50)/\(.served.totalP90)/\(.served.totalMax)"],
      ["ttfbMs p50/p90/max", "\(.served.ttfbP50)/\(.served.ttfbP90)/\(.served.ttfbMax)"],
      ["mint hit ratio", .mintHitRatio], ["API Gateway Count", .metrics.apiGateway.count],
      ["API Gateway 4XXError", .metrics.apiGateway["4xx"]], ["API Gateway 5XXError", .metrics.apiGateway["5xx"]],
      ["API Gateway Latency max ms", .metrics.apiGateway.latencyMaxMs]
    ] + (.sdkRetried | to_entries | map(["sdk retried \(.key) (retries/lines/exhausted)", "\(.value.retries)/\(.value.lines)/\(.value.exhausted)"]))
    | .[] | "| \(.[0]) | \(.[1] // "n/a") |"' "$C"
  if [[ -s "$TIMINGS" ]]; then
    printf '\nDeploy and destroy times on record (seconds):\n\n'
    sed "s/^/- /" "$TIMINGS"
  fi
  printf '\nCost lines (§10.1): not computed by the script; price the counters above.\n'
} >"$SECTION"

# Redaction check (§11): nothing that identifies the account, a tenant, a user, a token or an endpoint.
PATTERNS="${LIB_TMP}/manifest-ids"
jq -r '.tenants[] | .tenantId, .name, .admin, (.users[]?)' "$MANIFEST" | grep -v '^$' >"$PATTERNS" || true
LEAK=""
# An account id is twelve digits on their own; the fraction of a float
# (0.193415637860) is not one.
grep -Eq '(^|[^0-9.])[0-9]{12}($|[^0-9])' "$SECTION" && LEAK="${LEAK} a-12-digit-number"
[[ -s "$PATTERNS" ]] && grep -Fq -f "$PATTERNS" "$SECTION" && LEAK="${LEAK} a-manifest-id-or-name"
grep -Fq 'eyJ' "$SECTION" && LEAK="${LEAK} eyJ"
grep -Fq 'https://' "$SECTION" && LEAK="${LEAK} https://"
if [[ -n "$LEAK" ]]; then
  fail "redaction check: the results section holds${LEAK}; nothing written (the data is in ${RUN_DIR}/collect.json)"
fi
mkdir -p "$RESULTS_DIR"
# A second collect of the same run replaces its section (the first may have
# run before the log group settled).
if [[ -s "$RESULTS" ]]; then
  awk -v id="## ${RUN_ID}" 'index($0, "## ") == 1 { skip = ($0 == id) } !skip' "$RESULTS" >"${RESULTS}.new"
  mv "${RESULTS}.new" "$RESULTS"
fi
cat "$SECTION" >>"$RESULTS"

echo "== pass table (${RUN_ID})"
awk -F'|' 'BEGIN { printf "%-44s | %-4s | %s\n", "check", "", "measured"; print "---------------------------------------------|------|---------" }
  { printf "%-44s | %-4s | %s\n", $1, $3, $2 }' "$ROWS"
echo "written: design/stress-results/${DATE}-${SCALE}.md; raw: ${C}"
grep -q '|FAIL$' "$ROWS" && exit 1
exit 0
