# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Window maths shared by slice.sh (when a scenario may start) and collect.sh (which CloudWatch
# minutes belong to a scenario). Sourced, not run. ADR-0052, "CloudWatch windows".
#
# get-metric-statistics and get-metric-data at a 60 s period return the one-minute buckets in
# [floor(start), floor(end)), and API Gateway stamps its datapoints about a minute after the
# request (the 2026-11-19 run: S3's 429s logged at 18:05 and 18:06, counted at 18:06 and 18:07).
# So a scenario's minutes run from the minute it starts in to one minute past the minute it
# ends in, and the next scenario starts only after that.

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
