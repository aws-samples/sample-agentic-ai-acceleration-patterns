#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The slice's `collect` verb (docs/stress-test.spec.md §3.4, ADR-0052; stress-test plan §4, §7, §7.1, §11).
# slice.sh calls it after the last scenario with the runner's environment:
#
#   STRESS_RESULTS STRESS_RUN_ID STRESS_SCALE STRESS_STATE_DIR AWS_REGION  (the runner's, through slice.sh)
#   [STRESS_BASELINE_TTFB_P90_MS=<perf.sh p90 TTFB of the day, ms>]
#
# For each record this run's `run` verb wrote (`agentic-runtime-isolation.S<n>.json`),
# over the window the record names:
#   - Logs Insights on the ingress and authoriser log groups: `request refused` by
#     tenant and reason (P-7); on the ingress group `request served` count and
#     p50/p90/p95/p99/max of totalMs and ttfbMs, the mint hit ratio, 429 by tenantId and
#     minute (joined against served per tenant-minute), 5xx refusals, and
#     `sdk retried` sum(attempts - 1) by service (§7.1);
#   - CloudWatch: API Gateway Count/4XXError/5XXError/Latency, Lambda
#     Throttles/ConcurrentExecutions for the authoriser and the ingress function,
#     DynamoDB ThrottledRequests on the entitlement store;
#   - the k6 summary the run kept next to the records.
# It fills the record's late fields, only in records this run wrote and nobody else
# changed (the runner checks): `refusals` (the driver's refusals matched with the
# hops' lines, attribute.jq), `latency.ingress` and `latency.ingress-ttfb`, and the
# Lambda concurrency in `quotas`. `cost` stays absent: Cost Explorer settles a day
# later, cost.sh reads it then.
#
# It also appends one section per scenario to design/stress-results/<YYYY-MM-DD>-<scale>.md
# after a redaction check (no 12-digit number, no tenant id, tenant name or user name
# from the manifest, no `eyJ`, no `https://`), prints the pass table, and exits 1 when
# a row fails, so the run fails with it. Raw query results stay in the run folder
# (`<run folder>/agentic-runtime-isolation/<scenario>/`). Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap and through pf; the backticks in printf formats are literal Markdown.
# shellcheck disable=SC2329,SC2016

set -euo pipefail

for name in STRESS_RESULTS STRESS_RUN_ID STRESS_SCALE STRESS_STATE_DIR; do
  [[ -n "${!name:-}" ]] || { echo "collect.sh: ${name} is not set (slice.sh sets it; run this through the runner)" >&2; exit 2; }
done
REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region the stress stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws jq git awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SAMPLE_DIR"
SCALE="$STRESS_SCALE"
STATE_DIR="$STRESS_STATE_DIR"
OUTPUTS="${STATE_DIR}/outputs.json"
MANIFEST="${STATE_DIR}/manifest.json"
RUN_DIR="$(dirname "${STRESS_RESULTS%/}")"
RAW_DIR="${RUN_DIR}/agentic-runtime-isolation"
K6_DIR="${RUN_DIR}/k6"

LIB_TMP="$(mktemp -d)"
trap 'rm -rf "$LIB_TMP"' EXIT
fail() { echo "FAILED: $*" >&2; exit 1; }
[[ -s "$OUTPUTS" ]] || fail "no ${OUTPUTS}; deploy did not run"
[[ -s "$MANIFEST" ]] || fail "no ${MANIFEST}; seed did not run"
output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || fail "output $1 missing from ${OUTPUTS}"; printf '%s' "$v"; }
LOG_GROUP="$(need IngressLogGroupName)"
AUTHORIZER_FN="$(need AuthorizerFunctionName)"
AUTHORIZER_LOG_GROUP="$(output AuthorizerLogGroupName)"
[[ -n "$AUTHORIZER_LOG_GROUP" ]] || AUTHORIZER_LOG_GROUP="/aws/lambda/${AUTHORIZER_FN}"
INGRESS_FN="$(need IngressFunctionName)"
ENT_TABLE="$(need EntitlementsTableName)"
REST_API_ID="$(need RestApiId)"
STAGE="$(need StageName)"

shopt -s nullglob
RECORDS=("${STRESS_RESULTS}"/agentic-runtime-isolation.S[1-7].json)
shopt -u nullglob
if (( ${#RECORDS[@]} == 0 )); then
  echo "collect: no agentic-runtime-isolation record in ${STRESS_RESULTS}; nothing to collect"
  exit 0
fi
mkdir -p -m 700 "$RAW_DIR"

iso() { date -u -d "@$1" +%FT%TZ; }
epoch() { date -u -d "$1" +%s; }

# Log delivery and Logs Insights indexing lag the request by up to about two
# minutes; a query run right after the run undercounts (seen 2026-11-09: 117
# of 474 refusals). Wait until the last window is 150 s old.
LAST_END=0
for r in "${RECORDS[@]}"; do
  e="$(epoch "$(jq -r .window.end "$r")")"
  (( e > LAST_END )) && LAST_END=$e
done
settle=$(( LAST_END + 150 - $(date +%s) ))
if (( settle > 0 )); then
  echo "waiting ${settle}s for the log groups to settle"
  sleep "$settle"
fi

# One entry per scenario: the k6 script, as slice.sh run names it.
k6_name() {
  case "$1" in
    S1) echo s1-steady ;; S2) echo s2-herd ;; S3) echo s3-noisy ;; S4) echo s4-tools ;;
    S5) echo s5-streams ;; S6) echo s6-peak ;; S7) echo s7-eviction ;;
  esac
}

# insights NAME QUERY GROUP... -> $OUT/insights-NAME.json, rows as objects.
insights() {
  local name="$1" query="$2" qid status raw="${LIB_TMP}/q.json" waited=0
  shift 2
  qid="$(aws logs start-query --log-group-names "$@" --start-time "$QSTART" --end-time "$QEND" \
    --query-string "$query" --query queryId --output text)" || fail "start-query ${name}"
  while :; do
    aws logs get-query-results --query-id "$qid" --output json >"$raw" || fail "get-query-results ${name}"
    status="$(jq -r .status "$raw")"
    [[ "$status" =~ ^(Scheduled|Running)$ ]] || break
    (( waited < 600 )) || fail "Logs Insights query ${name} still ${status} after 600 s"
    sleep 5; waited=$((waited + 5))
  done
  [[ "$status" == Complete ]] || fail "Logs Insights query ${name}: ${status}"
  jq '[.results[] | map({(.field): .value}) | add]' "$raw" >"${OUT}/insights-${name}.json"
  echo "  insights ${name}: $(jq length "${OUT}/insights-${name}.json") rows"
}

# metric NAMESPACE NAME STAT DIMENSIONS... -> the sum (Sum) or the max (Maximum, Average) over the window.
metric() {
  local ns="$1" name="$2" stat="$3" agg
  shift 3
  [[ "$stat" == Sum ]] && agg='add // 0' || agg='max // 0'
  aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$name" --statistics "$stat" --period 60 \
    --start-time "$(iso "$QSTART")" --end-time "$(iso "$QEND")" --dimensions "$@" --output json \
    | jq "[.Datapoints[].${stat}] | ${agg}"
}

API_NAME="$(aws apigateway get-rest-api --rest-api-id "$REST_API_ID" --query name --output text)"
# shellcheck disable=SC2054  # CLI shorthand: Name=...,Value=... is one element
APIGW=(Name=ApiName,Value="$API_NAME" Name=Stage,Value="$STAGE")

DATE="$(date -u +%F)"
RESULTS_DIR="${SAMPLE_DIR}/design/stress-results"
RESULTS="${RESULTS_DIR}/${DATE}-${SCALE}.md"
PATTERNS="${LIB_TMP}/manifest-ids"
jq -r '.tenants[] | .tenantId, .name, .admin, (.users[]?)' "$MANIFEST" | grep -v '^$' >"$PATTERNS" || true
ANY_FAIL=0

# collect_one RECORD: reads the record's window, fills its late fields, writes its section.
collect_one() {
  local record="$1" SCENARIO W_START W_END QSTART QEND OUT C ROWS SUMMARY
  SCENARIO="$(jq -r .scenario "$record")"
  W_START="$(epoch "$(jq -r .window.start "$record")")"
  W_END="$(epoch "$(jq -r .window.end "$record")")"
  # A little before the start and after the end: the driver's clock and the hops' differ by
  # a second or two, and a request in flight at the end is logged after it.
  QSTART=$((W_START - 10))
  QEND=$((W_END + 20))
  OUT="${RAW_DIR}/${SCENARIO}"
  mkdir -p -m 700 "$OUT"
  echo "== ${SCENARIO}: window $(iso "$W_START") .. $(iso "$W_END")"

  echo "-- Logs Insights"
  insights served 'filter message = "request served"
| stats count(*) as served, pct(totalMs, 50) as totalP50, pct(totalMs, 90) as totalP90, pct(totalMs, 95) as totalP95, pct(totalMs, 99) as totalP99, max(totalMs) as totalMax,
  pct(ttfbMs, 50) as ttfbP50, pct(ttfbMs, 90) as ttfbP90, pct(ttfbMs, 95) as ttfbP95, pct(ttfbMs, 99) as ttfbP99, max(ttfbMs) as ttfbMax' "$LOG_GROUP"
  insights mint 'filter message = "request served" | stats count(*) as n by mint' "$LOG_GROUP"
  insights served_by_minute 'filter message = "request served" | stats count(*) as n by tenantId, bin(1m) as minute | limit 10000' "$LOG_GROUP"
  insights refused_429 'filter message = "request refused" and status = 429 | stats count(*) as n by tenantId, bin(1m) as minute | limit 10000' "$LOG_GROUP"
  insights refused_5xx 'filter message = "request refused" and status >= 500 | fields ispresent(tenantId) as withTenant | stats count(*) as n by status, reason, withTenant' "$LOG_GROUP"
  insights retried 'filter message = "sdk retried" | fields attempts - 1 as extra, ispresent(error) as failedAll | stats sum(extra) as retries, count(*) as lines, sum(failedAll) as exhausted by service' "$LOG_GROUP"
  # P-7: every refusal the driver saw is a `request refused` line with a tenant, from the
  # authoriser (entitlement, grant, limit) or the ingress (limit, backend, mint). A refusal
  # no line accounts for is unattributed (attribute.jq).
  insights refused_by_reason 'filter message = "request refused" | stats count(*) as n by tenantId, reason | limit 10000' "$LOG_GROUP" "$AUTHORIZER_LOG_GROUP"
  # Per-tenant cost attribution (P-10, plan §11.2): the figures the `request served` line
  # carries per tenant, summed, so the run's Runtime seconds can be split by tenant and the
  # sum compared with the Cost Explorer line (cost.sh).
  insights cost_by_tenant 'filter message = "request served"
| stats count(*) as requests, sum(backendInvokeSeconds) as backendSeconds, sum(usageInput) as inputTokens, sum(usageOutput) as outputTokens by tenantId
| sort backendSeconds desc | limit 10000' "$LOG_GROUP"

  echo "-- CloudWatch metrics"
  local ddb
  ddb="$(aws cloudwatch get-metric-data --start-time "$(iso "$QSTART")" --end-time "$(iso "$QEND")" --output json \
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
    --argjson ddb "$ddb" \
    '{apiGateway: {count: $count, "4xx": $e4, "5xx": $e5, latencyMaxMs: $lat, latencyAvgMaxMs: $lat_avg},
      lambda: {authorizerThrottles: $authThr, ingressThrottles: $ingThr, authorizerConcurrencyMax: $authConc, ingressConcurrencyMax: $ingConc},
      dynamodb: {entitlementsThrottledRequests: $ddb}}' >"${OUT}/metrics.json"
  echo "  $(jq -c . "${OUT}/metrics.json")"

  # The k6 summary `run` kept (SUMMARY_PATH, brought back by stress/driver/k6.sh).
  SUMMARY="${K6_DIR}/$(k6_name "$SCENARIO").summary.json"
  if [[ ! -s "$SUMMARY" ]]; then
    echo '{"metrics": {}}' >"${LIB_TMP}/empty.json"
    SUMMARY="${LIB_TMP}/empty.json"
  fi
  k6m() { # METRIC FIELD -> value or null (summary-export and handleSummary layouts)
    jq -c --arg k "$1" --arg f "$2" '(.metrics[$k].values // .metrics[$k]) as $v | if $v == null then null else $v[$f] end' "$SUMMARY"
  }
  local K6
  K6="$(jq -n \
    --argjson reqs "$(k6m http_reqs count)" \
    --argjson p90 "$(k6m http_req_duration 'p(90)')" \
    --argjson wait90 "$(k6m http_req_waiting 'p(90)')" \
    --argjson failed "$(k6m http_req_failed value)" \
    --argjson failedRate "$(k6m http_req_failed rate)" \
    --argjson mismatch "$(k6m isolation_mismatch count)" \
    --argjson pcf "$(k6m positive_control_fail count)" \
    --argjson s429 "$(k6m status_429 count)" \
    --argjson seen "$(k6m refusals_seen count)" \
    '{requests: $reqs, durationP90Ms: $p90, ttfbP90Ms: $wait90, failedRate: ($failed // $failedRate),
      isolationMismatch: $mismatch, positiveControlFail: $pcf, status429: $s429, refusalsSeen: $seen}')"

  # -- assemble -------------------------------------------------------------
  local I="$OUT"
  jq -n --argjson w "$(jq -c '.window' "$record")" --argjson k6 "$K6" --argjson m "$(cat "${OUT}/metrics.json")" \
    --slurpfile served "${I}/insights-served.json" --slurpfile mint "${I}/insights-mint.json" \
    --slurpfile sbm "${I}/insights-served_by_minute.json" --slurpfile r429 "${I}/insights-refused_429.json" --slurpfile cbt "${I}/insights-cost_by_tenant.json" \
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
          and (.minute | .[0:16]) != ($w.start | .[0:16] | sub("T"; " "))
          and (.minute | .[0:16]) != ($w.end | .[0:16] | sub("T"; " "))
          and (($servedAt["\(.tenantId)|\(.minute)"] // 0) < 55))) | length),
       tenants429: ($r429[0] | map(.tenantId) | unique | length),
       refused5xx: ($r5[0] | map(.n | num) | add // 0),
       refused5xxWithTenant: ($r5[0] | map(select(.withTenant == "1" or .withTenant == "true") | .n | num) | add // 0),
       refused5xxReasons: ($r5[0] | map({key: "\(.status) \(.reason // "none")", value: (.n | num)}) | from_entries),
       sdkRetried: ($retried[0] | map({key: (.service // "unknown"), value: {retries: (.retries | num), lines: (.lines | num), exhausted: (.exhausted | num)}}) | from_entries),
       costByTenant: (($cbt[0] | map(select((.tenantId // "") != "") | {requests: (.requests | num), backendSeconds: (.backendSeconds | num), inputTokens: (.inputTokens | num), outputTokens: (.outputTokens | num)})) as $rows
         | ($rows | length) as $tenants | ($rows | map(.backendSeconds) | add // 0) as $seconds | ($rows | map(.requests) | add // 0) as $reqs
         | {tenants: $tenants, backendSeconds: $seconds, requests: $reqs,
            secondsPerTenantAvg: (if $tenants == 0 then 0 else $seconds / $tenants end),
            secondsPerTenantMax: ($rows | map(.backendSeconds) | max // 0),
            secondsPerTenantMin: ($rows | map(.backendSeconds) | min // 0),
            secondsPerRequest: (if $reqs == 0 then 0 else $seconds / $reqs end),
            inputTokens: ($rows | map(.inputTokens) | add // 0), outputTokens: ($rows | map(.outputTokens) | add // 0),
            untagged: ($cbt[0] | map(select((.tenantId // "") == "")) | length)})}' \
    >"${OUT}/collect.json"
  C="${OUT}/collect.json"
  v() { jq -r "$1" "$C"; }

  # -- the record's late fields (P-7, §6) -----------------------------------
  # `seen` is every 4xx and 5xx the driver counted: the record's own `refusals.unattributed`
  # as k6 wrote it, before this step. A collect run twice would read the first answer, so the
  # k6 summary's own count wins when it is there.
  local SEEN ATT LAT Q
  SEEN="$(v '.k6.refusalsSeen // empty')"
  [[ -n "$SEEN" ]] || SEEN="$(jq -r '.refusals.unattributed' "$record")"
  ATT="$(jq -n --argjson seen "$SEEN" --slurpfile rows "${OUT}/insights-refused_by_reason.json" -f "${SCRIPT_DIR}/attribute.jq")"
  LAT="$(jq -c '
    def sec: ((. // "0") | tonumber) / 1000;
    def ord($a; $b; $c): {p50: ($a | sec), p95: ([($b | sec), ($a | sec)] | max)} | . + {p99: ([($c | sec), .p95] | max)};
    (.served // {}) as $s
    | if ($s.served // 0 | tonumber) == 0 then {}
      else {ingress: ord($s.totalP50; $s.totalP95; $s.totalP99), "ingress-ttfb": ord($s.ttfbP50; $s.ttfbP95; $s.ttfbP99)} end' "$C")"
  Q="$(jq -c '{"cell-account-1": {"lambda-concurrency": ((.metrics.lambda.authorizerConcurrencyMax // 0) + (.metrics.lambda.ingressConcurrencyMax // 0))}}' "$C")"
  jq --argjson att "$ATT" --argjson lat "$LAT" --argjson q "$Q" '.refusals = $att | .latency += $lat | .quotas = $q' "$record" >"${record}.new"
  mv "${record}.new" "$record"
  echo "  record: refusals seen ${SEEN}, attributed $(jq '[.byTenantReason[].count] | add // 0' <<<"$ATT"), unattributed $(jq .unattributed <<<"$ATT")"

  # -- the pass table (§4) --------------------------------------------------
  ROWS="${LIB_TMP}/rows"
  : >"$ROWS"
  row() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$ROWS"; }
  pf() { if "$@"; then echo PASS; else echo FAIL; fi; }
  zero() { awk -v a="$1" 'BEGIN { exit !(a + 0 == 0) }'; }

  local MISMATCH PCF REQS PCF_LIMIT verdict
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
  local E5 R5T LT
  E5="$(v '.metrics.apiGateway["5xx"]')"
  R5T="$(v .refused5xxWithTenant)"
  LT="$(v '(.metrics.lambda.authorizerThrottles // 0) + (.metrics.lambda.ingressThrottles // 0)')"
  if [[ "$SCENARIO" == S6 ]]; then
    row "5xx from the ingress" "API Gateway 5xx ${E5}; refusals naming a tenant ${R5T} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" \
      "$(pf awk -v a="$E5" -v b="$R5T" 'BEGIN { exit !(a <= b) }')"
  elif [[ "$SCENARIO" == S2 ]]; then
    # The herd is the one scenario that may throttle the ingress Lambda; each
    # throttle is one API Gateway 500 with no tenant (finding F-1 in the plan).
    # Every other 5xx must name a tenant and a reason.
    row "5xx from the ingress" "API Gateway 5xx ${E5}; refusals naming a tenant ${R5T}; Lambda throttles ${LT} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" \
      "$(pf awk -v a="$E5" -v b="$R5T" -v c="$LT" 'BEGIN { exit !(a <= b + c) }')"
  else
    row "5xx from the ingress" "API Gateway 5xx ${E5} ($(v '.refused5xxReasons | to_entries | map("\(.key)=\(.value)") | join(", ")'))" "$(pf zero "$E5")"
  fi
  local R429 K429
  R429="$(v .refused429)"; K429="$(v '.k6.status429 // "n/a"')"
  verdict=FAIL
  # The k6 count and the logged count may differ by the requests in flight at
  # the window's edges (log delivery lags a few seconds): equal within 1 % or 2.
  if [[ "$(v .refused429Untagged)" == 0 && "$(v .refused429UnderLimit)" == 0 ]] \
    && { [[ "$K429" == n/a ]] || awk -v k="$K429" -v r="$R429" 'BEGIN { d = k - r; if (d < 0) d = -d; t = r / 100; if (t < 2) t = 2; exit !(d <= t) }'; }; then verdict=PASS; fi
  row "429 attribution" "logged 429 ${R429} over $(v .tenants429) tenants, untagged $(v .refused429Untagged), tenant-minutes under the limit $(v .refused429UnderLimit), k6 429 ${K429}" "$verdict"
  row "Refusals attributed to a tenant (P-7)" "driver saw ${SEEN}; logged with a tenant $(jq '[.byTenantReason[].count] | add // 0' <<<"$ATT") over $(jq '[.byTenantReason[].tenant] | unique | length' <<<"$ATT") tenants; unattributed $(jq .unattributed <<<"$ATT")" \
    "$(pf zero "$(jq .unattributed <<<"$ATT")")"
  local STS KMS
  STS="$(v '.sdkRetried.sts.retries // 0')"; KMS="$(v '.sdkRetried.kms.retries // 0')"
  if [[ "$SCENARIO" == S2 ]]; then
    row "STS AssumeRole throttles (sdk retried)" "retries ${STS}, exhausted $(v '.sdkRetried.sts.exhausted // 0') (counted for the herd)" INFO
  else
    row "STS AssumeRole throttles (sdk retried)" "retries ${STS}" "$(pf zero "$STS")"
  fi
  row "KMS Sign throttles (sdk retried)" "retries ${KMS}" "$(pf zero "$KMS")"
  LT=$(( $(v .metrics.lambda.authorizerThrottles | cut -d. -f1) + $(v .metrics.lambda.ingressThrottles | cut -d. -f1) ))
  if [[ "$SCENARIO" == S2 ]]; then
    row "Lambda Throttles" "${LT} (concurrency max authoriser $(v .metrics.lambda.authorizerConcurrencyMax), ingress $(v .metrics.lambda.ingressConcurrencyMax)); counted for the herd (F-1)" "INFO"
  else
    row "Lambda Throttles" "${LT} (concurrency max authoriser $(v .metrics.lambda.authorizerConcurrencyMax), ingress $(v .metrics.lambda.ingressConcurrencyMax))" "$(pf zero "$LT")"
  fi
  local DDB TTFB90
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
  # Per-tenant cost attribution (P-10): every served request carries a tenantId
  # and its backend seconds, so the run's Runtime time splits by tenant with
  # nothing left over. The sum is what cost.sh compares with the Runtime line.
  row "Per-tenant cost attribution (P-10)" "$(v .costByTenant.tenants) tenants, $(v '.costByTenant.backendSeconds | . * 10 | round / 10') backend seconds attributed, $(v .costByTenant.untagged) served lines without a tenant; per tenant avg/min/max $(v '.costByTenant.secondsPerTenantAvg | . * 10 | round / 10')/$(v '.costByTenant.secondsPerTenantMin | . * 10 | round / 10')/$(v '.costByTenant.secondsPerTenantMax | . * 10 | round / 10') s" \
    "$(pf zero "$(v .costByTenant.untagged)")"

  # -- the section of the results file --------------------------------------
  local SECTION="${LIB_TMP}/section.md"
  {
    printf '\n## %s %s\n\n' "$STRESS_RUN_ID" "$SCENARIO"
    printf -- '- Commit tested: `%s`\n- Scale: %s\n- Scenario: %s\n- Run window (UTC): %s to %s (%s s)\n\n' \
      "$(git rev-parse --short HEAD)" "$SCALE" "$SCENARIO" "$(iso "$W_START")" "$(iso "$W_END")" "$((W_END - W_START))"
    printf '| Check | Measured | Result |\n|---|---|---|\n'
    awk -F'|' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }' "$ROWS"
    printf '\n| Counter | Value |\n|---|---|\n'
    jq -r '[
        ["k6 requests", .k6.requests], ["k6 http_req_duration p90 ms", .k6.durationP90Ms], ["k6 TTFB p90 ms", .k6.ttfbP90Ms],
        ["k6 http_req_failed rate", .k6.failedRate], ["request served", .served.served],
        ["backend seconds attributed to tenants", (.costByTenant.backendSeconds | . * 10 | round / 10)],
        ["backend seconds per request", (.costByTenant.secondsPerRequest | . * 1000 | round / 1000)],
        ["backend seconds per tenant avg / min / max", "\(.costByTenant.secondsPerTenantAvg | . * 10 | round / 10) / \(.costByTenant.secondsPerTenantMin | . * 10 | round / 10) / \(.costByTenant.secondsPerTenantMax | . * 10 | round / 10)"],
        ["model tokens in / out (none at rate by design)", "\(.costByTenant.inputTokens) / \(.costByTenant.outputTokens)"],
        ["totalMs p50/p90/max", "\(.served.totalP50)/\(.served.totalP90)/\(.served.totalMax)"],
        ["ttfbMs p50/p90/max", "\(.served.ttfbP50)/\(.served.ttfbP90)/\(.served.ttfbMax)"],
        ["mint hit ratio", .mintHitRatio], ["API Gateway Count", .metrics.apiGateway.count],
        ["API Gateway 4XXError", .metrics.apiGateway["4xx"]], ["API Gateway 5XXError", .metrics.apiGateway["5xx"]],
        ["API Gateway Latency max ms", .metrics.apiGateway.latencyMaxMs]
      ] + (.sdkRetried | to_entries | map(["sdk retried \(.key) (retries/lines/exhausted)", "\(.value.retries)/\(.value.lines)/\(.value.exhausted)"]))
      | .[] | "| \(.[0]) | \(.[1] // "n/a") |"' "$C"
  } >"$SECTION"

  # Redaction check (§11): nothing that identifies the account, a tenant, a user, a token or an endpoint.
  local LEAK=""
  # An account id is twelve digits on their own; the fraction of a float
  # (0.193415637860) is not one.
  grep -Eq '(^|[^0-9.])[0-9]{12}($|[^0-9])' "$SECTION" && LEAK="${LEAK} a-12-digit-number"
  [[ -s "$PATTERNS" ]] && grep -Fq -f "$PATTERNS" "$SECTION" && LEAK="${LEAK} a-manifest-id-or-name"
  grep -Fq 'eyJ' "$SECTION" && LEAK="${LEAK} eyJ"
  grep -Fq 'https://' "$SECTION" && LEAK="${LEAK} https://"
  if [[ -n "$LEAK" ]]; then
    echo "FAILED: redaction check: the ${SCENARIO} section holds${LEAK}; nothing written (the data is in ${C})" >&2
    ANY_FAIL=1
  else
    mkdir -p "$RESULTS_DIR"
    if [[ ! -f "$RESULTS" ]]; then
      printf '# Stress results %s, scale %s\n\nWritten by `scripts/stress/collect.sh` (design/agentic-runtime-isolation.stress-test.md §11).\n' "$DATE" "$SCALE" >"$RESULTS"
    fi
    # A second collect of the same scenario replaces its section (the first may have
    # run before the log groups settled).
    awk -v id="## ${STRESS_RUN_ID} ${SCENARIO}" 'index($0, "## ") == 1 { skip = ($0 == id) } !skip' "$RESULTS" >"${RESULTS}.new"
    mv "${RESULTS}.new" "$RESULTS"
    cat "$SECTION" >>"$RESULTS"
  fi

  echo "== pass table (${SCENARIO})"
  awk -F'|' 'BEGIN { printf "%-44s | %-4s | %s\n", "check", "", "measured"; print "---------------------------------------------|------|---------" }
    { printf "%-44s | %-4s | %s\n", $1, $3, $2 }' "$ROWS"
  if grep -q '|FAIL$' "$ROWS"; then ANY_FAIL=1; fi
}

for r in "${RECORDS[@]}"; do
  collect_one "$r"
done
echo "written: design/stress-results/${DATE}-${SCALE}.md; raw: ${RAW_DIR}"
exit "$ANY_FAIL"
