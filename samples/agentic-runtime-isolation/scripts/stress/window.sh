# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Window maths shared by slice.sh (when a scenario may start) and collect.sh (which CloudWatch
# minutes belong to a scenario). Sourced, not run. ADR-0052, "CloudWatch windows".
#
# get-metric-statistics and get-metric-data at a 60 s period return the one-minute buckets in
# [floor(start), floor(end)), and API Gateway stamps its datapoints about a minute after the
# request (a 429 logged at 18:05 is counted at 18:06). So a scenario's minutes run from the
# minute it starts in to one minute past the minute it ends in, and the next scenario starts
# only after that.
#
# Timestamps are parsed with jq, not GNU date, so the maths runs the same on any host.

# iso_epoch ISO -> the epoch second of a UTC ISO 8601 timestamp (`2026-11-19T18:06:42.123Z`,
# fractional seconds dropped). A value that is not one is an error with a message, never 0.
iso_epoch() {
  jq -nr --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null \
    || { echo "window.sh: not a UTC ISO 8601 timestamp: '$1'" >&2; return 1; }
}

# epoch_iso EPOCH -> YYYY-MM-DDTHH:MM:SSZ.
epoch_iso() {
  jq -nr --argjson s "$1" '$s | todate' 2>/dev/null \
    || { echo "window.sh: not an epoch second: '$1'" >&2; return 1; }
}

# metric_window START END -> "MSTART MEND", epoch seconds: the start minute, and the end of the
# minute after the end minute (exclusive).
metric_window() {
  local start="$1" end="$2"
  printf '%s %s\n' "$(( start / 60 * 60 ))" "$(( (end / 60 + 2) * 60 ))"
}

# start_at PREV_END NOW -> the epoch second the next scenario may start at: at least 3 s past
# the previous scenario's metric window (PREV_END 0 when there is none; the 3 s cover the driver
# host's clock), and at most 3 s into a minute, so it also starts on a fresh minute of the
# per-tenant limiter (ADR-0020).
start_at() {
  local prev="$1" t="$2" mend
  if (( prev > 0 )); then
    mend=$(( (prev / 60 + 2) * 60 ))
    (( t >= mend + 3 )) || t=$(( mend + 3 ))
  fi
  if (( t % 60 > 3 )); then
    t=$(( t - t % 60 + 63 ))
  fi
  printf '%s\n' "$t"
}
