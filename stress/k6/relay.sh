#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The host relay of the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md §5).
# `stress/driver/k6.sh` starts it on the driver host before a k6 run of a platform scenario and
# stops it after, so a minute of load reaches the `StressRun` metrics while k6 is still running.
# It reads k6's output file as it grows, sums the lines of all VUs by minute and calls PutMetricData:
#
#   `minute` lines (stress/k6/minute.js)  Requests by status class, IsolationAssertions and
#                                         IsolationMismatches, RefusalsSeen, ClientLatencyMs (a histogram)
#   `edge_refusal`, `body_refusal`        RefusalsNamed, and RefusalsByReason
#
# It keeps one small state file (the sums for each minute and what of them it has published) and the
# number of lines it has read, so a pass reads only the new lines. A minute is first published once
# every VU that has printed a line has printed one for it and a later minute exists, or `RELAY_GRACE_S`
# (90) seconds after it ended, whichever is first. A line that arrives after that is published as an
# addition at the next pass: CloudWatch adds the data points of one period (and merges histograms).
# On stop (the stop file, SIGTERM, the end of `RELAY_MAX_S`, or the death of its parent) every pending
# amount goes out. A failed call is tried again at the next pass and, on the last pass, given up with
# a warning: the metrics are a view, not a gate.
#
# Environment: STRESS_RUN_ID, RECORD_SCENARIO (the platform scenario, PS-<n>), AWS_REGION and the
# host's credentials (k6.sh exports them before it starts k6). Optional: RELAY_FILE
# (/opt/stress/out/k6-stdout.txt), RELAY_STOP_FILE (/opt/stress/out/relay.stop), RELAY_SLICE
# (agentic-runtime-isolation, the slice that calls k6.sh in platform mode), RELAY_GRACE_S, RELAY_POLL_S (10),
# RELAY_MAX_S (14700: the relay ends itself after this many seconds), RELAY_REASONS (the refusal
# reasons that keep their own series; any other is `other`), RELAY_STATE_DIR (a folder that keeps the
# state between runs of the script, for tests), RELAY_AWS (the aws command), RELAY_ONCE=1 (one final
# pass) or RELAY_ONCE=pass (one ordinary pass), both for tests, and RELAY_PARENT_PID (the process whose
# death ends the relay; default its parent). It needs bash, jq, sed, timeout and the AWS CLI. One failed call
# ends an ordinary pass (the other minutes wait for the next; the last pass tries each minute until it has
# run 25 s), and a call is given 30 s.
# Limit: it reads the output file by line count (k6 only appends). A file that is replaced is not handled:
# a shorter one is read from its first line, a longer one loses its first lines.
# It prints counts only: never a tenant id, a token or a header.

set -euo pipefail

: "${STRESS_RUN_ID:?relay.sh: STRESS_RUN_ID is not set}" "${RECORD_SCENARIO:?relay.sh: RECORD_SCENARIO is not set}" "${AWS_REGION:?relay.sh: AWS_REGION is not set}"
FILE="${RELAY_FILE:-/opt/stress/out/k6-stdout.txt}"
STOP="${RELAY_STOP_FILE:-/opt/stress/out/relay.stop}"
SLICE="${RELAY_SLICE:-agentic-runtime-isolation}"
GRACE="${RELAY_GRACE_S:-90}"
POLL="${RELAY_POLL_S:-10}"
MAX="${RELAY_MAX_S:-14700}"
AWS="${RELAY_AWS:-aws}"
REASONS="${RELAY_REASONS:-http-401 http-403 http-429 http-500 http-502 http-503 http-504}"
[[ "$STRESS_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || { echo "relay.sh: STRESS_RUN_ID is not a run id" >&2; exit 2; }
[[ "$RECORD_SCENARIO" =~ ^[A-Za-z][A-Za-z0-9-]{0,31}$ ]] || { echo "relay.sh: RECORD_SCENARIO is not a scenario id" >&2; exit 2; }
[[ "$SLICE" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || { echo "relay.sh: RELAY_SLICE is not a slice name" >&2; exit 2; }
[[ "${RELAY_PARENT_PID:-1}" =~ ^[1-9][0-9]*$ ]] || { echo "relay.sh: RELAY_PARENT_PID is not a process id" >&2; exit 2; }
[[ "$GRACE" =~ ^[0-9]+$ && "$POLL" =~ ^[0-9]+$ && "$MAX" =~ ^[0-9]+$ ]] || { echo "relay.sh: RELAY_GRACE_S, RELAY_POLL_S and RELAY_MAX_S are whole seconds" >&2; exit 2; }
read -ra REASON_LIST <<<"$REASONS"
REASONS_JSON="$(jq -n -c '$ARGS.positional' --args "${REASON_LIST[@]}")"

if [[ -n "${RELAY_STATE_DIR:-}" ]]; then
  WORK="$RELAY_STATE_DIR"
  mkdir -p "$WORK"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi
[[ -f "${WORK}/state.json" ]] || echo '{"vus":[],"minutes":{}}' > "${WORK}/state.json"
[[ -f "${WORK}/lines" ]] || echo 0 > "${WORK}/lines"
STOPPING=0
trap 'STOPPING=1' TERM INT
PARENT="${RELAY_PARENT_PID:-$PPID}"
START="$SECONDS"

# The jq program. Input: the new events, slurped. It folds them into $state, then lists, for each
# minute that is ready, what is new since its last publication: {minute, key, pub, data}.
# Everything it reads is checked: a number outside its range, a key that is no bucket or a field
# of another type is ignored, so a bad line cannot stop the relay.
read -r -d '' PROGRAM <<'JQ' || true
def zero: {s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, snone: 0, assertions: 0, mismatches: 0, refusals: 0, named: 0, reasons: {}, hist: {}};
def count: if type == "number" and . >= 0 and . < 1e12 then . else 0 end;
def sum(f): map(f) | add // 0;
def entry($name; $unit; $dims; $value; $ts):
  {MetricName: $name, Dimensions: $dims, Timestamp: $ts, Value: $value, Unit: $unit};
def tokey: tostring;
["s2xx", "s3xx", "s4xx", "s5xx", "snone", "assertions", "mismatches", "refusals"] as $fields
| reduce (.[] | select((.epochMinute | type) == "number" and .epochMinute == (.epochMinute | floor) and .epochMinute > 1e6 and .epochMinute < 1e8)) as $e ($st[0];
    ($e.epochMinute | tokey) as $k
    | .minutes[$k] //= (zero + {vus: [], pub: null})
    | if $e.kind == "minute" and ($e.vu | type) == "number" then
        .vus = ((.vus + [$e.vu]) | unique)
        | .minutes[$k].vus = ((.minutes[$k].vus + [$e.vu]) | unique)
        | reduce $fields[] as $f (.; .minutes[$k][$f] += ($e[$f] | count))
        | reduce (($e.hist // {}) | to_entries[]) as $h (.;
            (try ($h.key | tonumber) catch null) as $b
            | if $b != null and $b >= 0 and $b <= 200 and ($h.value | type) == "number" and $h.value >= 0
              then .minutes[$k].hist[($b | floor | tokey)] += $h.value
              else . end)
      elif $e.kind == "edge_refusal" or $e.kind == "body_refusal" then
        (if $e.kind == "edge_refusal" then "http-\($e.status | tostring)" else ($e.reason // "other" | tostring) end
          | ascii_downcase | gsub("[^a-z0-9_-]"; "-") | .[0:32]) as $r
        | (if ($reasons | index($r)) != null then $r else "other" end) as $reason
        | (($e.count // 1) | count | if . == 0 then 1 else . end) as $c
        | .minutes[$k].named += $c
        | .minutes[$k].reasons[$reason] += $c
      else . end)
| . as $st
| ([$st.minutes | keys[] | tonumber] | max // 0) as $latest
| {
    state: $st,
    publish: [
      $st.minutes | to_entries[] | .key as $ks | .value as $mm | ($ks | tonumber) as $m
      | ($mm.pub // zero) as $p
      | select(
          $mm.pub != null
          or $final == 1
          or $now >= (($m + 1) * 60 + $grace)
          or (($st.vus | length) > 0 and ($mm.vus | length) == ($st.vus | length) and $latest > $m))
      | ($m * 60 | todate) as $ts
      | [{Name: "RunId", Value: $run}, {Name: "Scenario", Value: $scenario}] as $base
      | ($base + [{Name: "Slice", Value: $slice}]) as $iso
      | ($mm | {s2xx, s3xx, s4xx, s5xx, snone, assertions, mismatches, refusals, named, reasons, hist}) as $now_sums
      | ([$mm.reasons | to_entries[] | {reason: .key, n: (.value - ($p.reasons[.key] // 0))} | select(.n > 0)]) as $reasonDelta
      | ([$mm.hist | to_entries[] | {v: (.key | tonumber), n: (.value - ($p.hist[.key] // 0))} | select(.n > 0)] | sort_by(.v)) as $histDelta
      | (($mm.pub == null)
          or ($fields | any(. as $f | $mm[$f] != $p[$f]))
          or ($mm.named != $p.named)
          or ($reasonDelta | length) > 0
          or ($histDelta | length) > 0) as $changed
      | select($changed)
      | {
          minute: $m,
          key: $ks,
          pub: $now_sums,
          data: (
            [
              entry("IsolationAssertions"; "Count"; $iso; ($mm.assertions - $p.assertions); $ts),
              entry("IsolationMismatches"; "Count"; $iso; ($mm.mismatches - $p.mismatches); $ts),
              entry("RefusalsSeen"; "Count"; $base; ($mm.refusals - $p.refusals); $ts),
              entry("RefusalsNamed"; "Count"; $base; ($mm.named - $p.named); $ts)
            ]
            + [ [["2xx", "s2xx"], ["3xx", "s3xx"], ["4xx", "s4xx"], ["5xx", "s5xx"], ["none", "snone"]][]
                | . as [$label, $key]
                | ($mm[$key] - $p[$key]) as $n
                | select($n > 0)
                | entry("Requests"; "Count"; ($base + [{Name: "StatusClass", Value: $label}]); $n; $ts) ]
            + ($reasonDelta | map(entry("RefusalsByReason"; "Count"; ($base + [{Name: "Reason", Value: .reason}]); .n; $ts)))
            + (if ($histDelta | length) == 0 then [] else
                [{
                  MetricName: "ClientLatencyMs", Dimensions: $base, Timestamp: $ts, Unit: "Milliseconds",
                  Values: ($histDelta | map(pow(1.12; .v) * 1000 | round / 1000)), Counts: ($histDelta | map(.n))
                }]
              end)
          )
        }
    ]
  }
JQ

# One pass: reads the lines that are new, folds them into the state and publishes what is ready.
# $1 is 1 on the last pass.
pass() {
  local final="$1" now read_lines total result item key minute data began="$SECONDS"
  [[ -f "$FILE" ]] || return 0
  now="$(date +%s)"
  read_lines="$(cat "${WORK}/lines")"
  total="$(wc -l < "$FILE")"
  if (( total < read_lines )); then read_lines=0; fi
  # k6 prints a console.log as: time="..." level=info msg="<the JSON as a quoted string>" source=console.
  # The quoted string is parsed as JSON twice: once to unquote it, once to read the object.
  if ! result="$( { (( total > read_lines )) && sed -n -e "$((read_lines + 1)),${total}p" "$FILE" || true; } \
    | sed -n -e 's/^time="[^"]*" level=[a-z]* msg=\(".*"\) source=console$/\1/p' \
    | jq -c -R 'fromjson? | fromjson? | select(type == "object" and (.kind == "minute" or .kind == "edge_refusal" or .kind == "body_refusal"))' \
    | jq -s -c --slurpfile st "${WORK}/state.json" --argjson now "$now" --argjson grace "$GRACE" --argjson final "$final" \
        --argjson reasons "$REASONS_JSON" --arg run "$STRESS_RUN_ID" --arg scenario "$RECORD_SCENARIO" --arg slice "$SLICE" "$PROGRAM" )"; then
    echo "relay: could not read the output after line ${read_lines}; skipping to line ${total}" >&2
    echo "$total" > "${WORK}/lines"
    if ! jq -e . "${WORK}/state.json" > /dev/null 2>&1; then
      echo '{"vus":[],"minutes":{}}' > "${WORK}/state.json"
      echo "relay: the state file was not readable; started it again" >&2
    fi
    return 0
  fi
  echo "$total" > "${WORK}/lines"
  jq -c .state <<<"$result" > "${WORK}/state.tmp" && mv "${WORK}/state.tmp" "${WORK}/state.json"
  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    # k6.sh waits 60 s for the relay: the last pass starts no call after 25 s of its own, so it ends within 55 s
    # of its start. It starts up to one pass and one poll after the stop file.
    if (( final && SECONDS - began >= 25 )); then
      echo "relay: the last pass is out of time; the minutes not yet published are given up" >&2
      break
    fi
    key="$(jq -r .key <<<"$item")"
    minute="$(jq -r .minute <<<"$item")"
    data="${WORK}/data.json"
    jq -c .data <<<"$item" > "$data"
    if timeout 30 "$AWS" cloudwatch put-metric-data --region "$AWS_REGION" --namespace StressRun --metric-data "file://${data}" > /dev/null 2> "${WORK}/err"; then
      jq -c --arg k "$key" --argjson pub "$(jq -c .pub <<<"$item")" '.minutes[$k].pub = $pub' "${WORK}/state.json" > "${WORK}/state.tmp" \
        && mv "${WORK}/state.tmp" "${WORK}/state.json"
      echo "relay: published minute ${minute} of ${RECORD_SCENARIO}"
    else
      echo "relay: put-metric-data failed for minute ${minute}: $(head -n 1 "${WORK}/err")" >&2
      # An ordinary pass stops at the first failure (the oldest minute goes first, and one call that
      # fails will most likely fail again at once). The last pass has no next one: it tries each minute.
      (( final )) || break
    fi
  done < <(jq -c '.publish[]' <<<"$result")
}

case "${RELAY_ONCE:-}" in
  1) pass 1; exit 0 ;;
  pass) pass 0; exit 0 ;;
esac
while :; do
  [[ ! -e "$STOP" ]] || STOPPING=1
  # An orphan ends itself: its parent (the k6 script) is gone, or it has run longer than the run can.
  kill -0 "$PARENT" 2>/dev/null || STOPPING=1
  (( SECONDS - START < MAX )) || STOPPING=1
  if (( STOPPING )); then
    pass 1
    break
  fi
  pass 0
  # sleep in a background job so a TERM ends the wait at once
  sleep "$POLL" & wait $! || true
done
