#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The host relay of the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md §5).
# `stress/driver/k6.sh` starts it on the driver host before a k6 run of a platform scenario and
# stops it after, so a minute of load reaches the `StressRun` metrics while k6 is still running.
# It reads k6's output file, sums the lines of all VUs by minute and calls PutMetricData:
#
#   `minute` lines (stress/k6/lib.js)  Requests by status class, IsolationAssertions and
#                                      IsolationMismatches, RefusalsSeen, ClientLatencyMs (a histogram)
#   `edge_refusal`, `body_refusal`     RefusalsNamed, and RefusalsByReason
#
# A minute is published once every VU that has printed a line has printed one for it and a later
# minute exists, or `RELAY_GRACE_S` (90) seconds after it ended, whichever is first. On stop (the
# stop file, or SIGTERM) every pending minute goes out. A failed call is tried again at the next
# pass and, on the last pass, given up with a warning: the metrics are a view, not a gate.
#
# Environment: STRESS_RUN_ID, RECORD_SCENARIO (the platform scenario, PS-<n>), AWS_REGION and the
# host's credentials (k6.sh exports them before it starts k6). Optional: RELAY_FILE
# (/opt/stress/out/k6-stdout.txt), RELAY_STOP_FILE (/opt/stress/out/relay.stop), RELAY_SLICE
# (agentic-runtime-isolation, the slice that calls k6.sh in platform mode), RELAY_GRACE_S, RELAY_POLL_S (10),
# RELAY_REASONS (the refusal reasons that keep their own series; any other is `other`), RELAY_AWS
# (the aws command), RELAY_ONCE=1 (one final pass) or RELAY_ONCE=pass (one ordinary pass), both for
# tests. It needs bash, jq, sed and the AWS CLI.
# It prints counts only: never a tenant id, a token or a header.

set -euo pipefail

: "${STRESS_RUN_ID:?relay.sh: STRESS_RUN_ID is not set}" "${RECORD_SCENARIO:?relay.sh: RECORD_SCENARIO is not set}" "${AWS_REGION:?relay.sh: AWS_REGION is not set}"
FILE="${RELAY_FILE:-/opt/stress/out/k6-stdout.txt}"
STOP="${RELAY_STOP_FILE:-/opt/stress/out/relay.stop}"
SLICE="${RELAY_SLICE:-agentic-runtime-isolation}"
GRACE="${RELAY_GRACE_S:-90}"
POLL="${RELAY_POLL_S:-10}"
AWS="${RELAY_AWS:-aws}"
REASONS="${RELAY_REASONS:-http-401 http-403 http-429 http-500 http-502 http-503 http-504}"
[[ "$STRESS_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || { echo "relay.sh: STRESS_RUN_ID is not a run id" >&2; exit 2; }
[[ "$RECORD_SCENARIO" =~ ^[A-Za-z][A-Za-z0-9-]{0,31}$ ]] || { echo "relay.sh: RECORD_SCENARIO is not a scenario id" >&2; exit 2; }
[[ "$SLICE" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || { echo "relay.sh: RELAY_SLICE is not a slice name" >&2; exit 2; }
[[ "$GRACE" =~ ^[0-9]+$ && "$POLL" =~ ^[0-9]+$ ]] || { echo "relay.sh: RELAY_GRACE_S and RELAY_POLL_S are whole seconds" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
: > "${WORK}/published"
STOPPING=0
trap 'STOPPING=1' TERM INT

# The jq program: per ready minute, one line {minute, data: [PutMetricData entries]}.
read -r -d '' PROGRAM <<'JQ' || true
def sum(f): map(f // 0) | add // 0;
def entry($name; $unit; $dims; $value; $ts):
  {MetricName: $name, Dimensions: $dims, Timestamp: $ts, Value: $value, Unit: $unit};
. as $all
| ($all | map(select(.kind == "minute"))) as $mins
| ($mins | map(.vu) | unique | length) as $vus
| ($all | map(.epochMinute | select(type == "number")) | unique) as $minutes
| ($minutes | max // 0) as $latest
| $minutes[]
| select(. as $m | ($published | index($m)) == null)
| . as $m
| ($mins | map(select(.epochMinute == $m))) as $lines
| ($all | map(select(.epochMinute == $m and .kind != "minute"))) as $refs
| select(
    $final == 1
    or $now >= (($m + 1) * 60 + $grace)
    or ($vus > 0 and ($lines | map(.vu) | unique | length) == $vus and $latest > $m)
  )
| ($m * 60 | todate) as $ts
| [{Name: "RunId", Value: $run}, {Name: "Scenario", Value: $scenario}] as $base
| ($base + [{Name: "Slice", Value: $slice}]) as $iso
| ($refs | map(
    (if .kind == "edge_refusal" then "http-\(.status)" else (.reason // "other") end
      | ascii_downcase | gsub("[^a-z0-9_-]"; "-") | .[0:32]) as $r
    | {reason: (if ($reasons | index($r)) != null then $r else "other" end), count: (.count // 1)}
  ) | group_by(.reason) | map({reason: .[0].reason, count: sum(.count)})) as $byReason
| ([$lines[].hist // {} | to_entries[]] | group_by(.key)
    | map({v: (.[0].key | tonumber), c: sum(.value)}) | sort_by(.v)) as $hist
| {
    minute: $m,
    data: (
      [
        entry("IsolationAssertions"; "Count"; $iso; ($lines | sum(.assertions)); $ts),
        entry("IsolationMismatches"; "Count"; $iso; ($lines | sum(.mismatches)); $ts),
        entry("RefusalsSeen"; "Count"; $base; ($lines | sum(.refusals)); $ts),
        entry("RefusalsNamed"; "Count"; $base; ($refs | sum(.count // 1)); $ts)
      ]
      + [ [["2xx", "s2xx"], ["3xx", "s3xx"], ["4xx", "s4xx"], ["5xx", "s5xx"], ["none", "snone"]][]
          | . as [$label, $key]
          | ($lines | sum(.[$key])) as $n
          | select($n > 0)
          | entry("Requests"; "Count"; ($base + [{Name: "StatusClass", Value: $label}]); $n; $ts) ]
      + ($byReason | map(entry("RefusalsByReason"; "Count"; ($base + [{Name: "Reason", Value: .reason}]); .count; $ts)))
      + (if ($hist | length) == 0 then [] else
          [{
            MetricName: "ClientLatencyMs", Dimensions: $base, Timestamp: $ts, Unit: "Milliseconds",
            Values: ($hist | map(pow(1.12; .v) * 1000 | round / 1000)), Counts: ($hist | map(.c))
          }]
        end)
    )
  }
JQ

# One pass over the file: publishes every ready minute not published yet. $1 is 1 on the last pass.
pass() {
  local final="$1" now published ready line minute data
  [[ -f "$FILE" ]] || return 0
  now="$(date +%s)"
  published="$(jq -R -s -c 'split("\n") | map(select(. != "") | tonumber)' "${WORK}/published")"
  reasons="$(printf '%s\n' $REASONS | jq -R . | jq -s -c .)"
  # k6 prints a console.log as: time="..." level=info msg="<JSON, quoted>" source=console
  ready="$(sed -n -e 's/^time="[^"]*" level=[a-z]* msg="\(.*\)" source=console$/\1/p' "$FILE" \
    | sed -e 's/\\"/"/g' \
    | jq -c -R 'fromjson? | select(type == "object" and (.kind == "minute" or .kind == "edge_refusal" or .kind == "body_refusal"))' \
    | jq -s -c --argjson now "$now" --argjson grace "$GRACE" --argjson final "$final" --argjson published "$published" \
        --argjson reasons "$reasons" --arg run "$STRESS_RUN_ID" --arg scenario "$RECORD_SCENARIO" --arg slice "$SLICE" "$PROGRAM")"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    minute="$(jq -r .minute <<<"$line")"
    data="${WORK}/data.json"
    jq -c .data <<<"$line" > "$data"
    if "$AWS" cloudwatch put-metric-data --region "$AWS_REGION" --namespace StressRun --metric-data "file://${data}" > /dev/null 2> "${WORK}/err"; then
      echo "$minute" >> "${WORK}/published"
      echo "relay: published minute ${minute} of ${RECORD_SCENARIO}"
    else
      echo "relay: put-metric-data failed for minute ${minute}: $(head -n 1 "${WORK}/err")" >&2
    fi
  done <<<"$ready"
}

case "${RELAY_ONCE:-}" in
  1) pass 1; exit 0 ;;
  pass) pass 0; exit 0 ;;
esac
while :; do
  [[ ! -e "$STOP" ]] || STOPPING=1
  if (( STOPPING )); then
    pass 1
    break
  fi
  pass 0
  # sleep in a background job so a TERM ends the wait at once
  sleep "$POLL" & wait $! || true
done
