#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The slice's `collect` verb in platform mode (docs/stress-test.spec.md §3.4; stress/README.md).
# slice.sh calls it after the last scenario with the runner's environment:
#
#   STRESS_RESULTS STRESS_RUN_ID
#
# In platform mode the cells are the control plane's, in other accounts, and this slice owns
# none of their logs, so it does not read hop logs. For each record this run's `run` verb
# wrote (`agentic-runtime-isolation.PS-<n>.json`) it fills the one late field it can:
# `refusals`, from what the driver itself saw. The driver knows the tenant and the status of
# every refused request and k6 printed each one (`edge_refusal` and `body_refusal` lines in
# `<script>.k6-stdout.txt`, which stress/driver/k6.sh keeps beside the records), so every
# refusal gets a tenant and a reason (`http-<status>` or the body's own), and `unattributed`
# is what the driver counted (`refusals_seen` in k6's summary) beyond those lines. Joining the
# edge's and the cells' logs (latency per hop, the quota peaks, cost) is a platform-run step
# this slice does not take; the record's `latency` holds the client's hops only.
#
# It changes only this run's records of this slice, and exits 1 when a record has no k6
# summary to count against. Prints counts and ids only (scripts/CONVENTIONS.md).

set -euo pipefail

for name in STRESS_RESULTS STRESS_RUN_ID; do
  [[ -n "${!name:-}" ]] || { echo "collect-platform.sh: ${name} is not set (slice.sh sets it; run this through the runner)" >&2; exit 2; }
done
command -v jq >/dev/null 2>&1 || { echo "collect-platform.sh: jq is not installed" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$(dirname "${STRESS_RESULTS%/}")"
K6_DIR="${RUN_DIR}/k6"

# The k6 script a platform scenario ran, as slice.sh run names it.
k6_name() {
  case "$1" in
    PS-2) echo s1-steady ;; PS-3) echo s2-herd ;; PS-4) echo s3-noisy ;; PS-6) echo s5-streams ;; PS-8) echo s6-peak ;;
    *) return 1 ;;
  esac
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

shopt -s nullglob
records=("${STRESS_RESULTS}"/agentic-runtime-isolation.PS-*.json)
shopt -u nullglob
if (( ${#records[@]} == 0 )); then
  echo "collect: no agentic-runtime-isolation platform record in ${STRESS_RESULTS}; nothing to collect"
  exit 0
fi

status=0
for record in "${records[@]}"; do
  scenario="$(jq -er .scenario "$record" 2>/dev/null)" || { echo "collect: ${record##*/} is not a record with a scenario" >&2; status=1; continue; }
  [[ "$(jq -r .runId "$record")" == "$STRESS_RUN_ID" ]] || { echo "collect: ${record##*/} belongs to another run; left alone" >&2; continue; }
  name="$(k6_name "$scenario")" || { echo "collect: no k6 script for ${scenario}" >&2; status=1; continue; }
  summary="${K6_DIR}/${name}.summary.json"
  if [[ ! -s "$summary" ]]; then
    echo "collect: no k6 summary for ${scenario} (${summary}): the driver's refusal count is unknown, nothing attributed" >&2
    status=1
    continue
  fi
  seen="$(jq -r '(.metrics.refusals_seen.values // .metrics.refusals_seen // {}).count // 0' "$summary")"
  # k6 writes console.log to stderr as msg="<JSON, quoted>"; the JSON lines are the ones of interest.
  # shortcut: only \" is unescaped, so a tenant id or reason holding a backslash is dropped and
  # stays unattributed (ids and reasons are plain tokens); unescape \\ too if that changes.
  if [[ -s "${K6_DIR}/${name}.k6-stdout.txt" ]]; then
    sed -n 's/.*msg="\(.*\)".*/\1/p' "${K6_DIR}/${name}.k6-stdout.txt" | sed 's/\\"/"/g' \
      | jq -R 'fromjson? | select(type == "object")' | jq -s . >"${tmp}/lines.json"
  else
    echo '[]' >"${tmp}/lines.json"
  fi
  att="$(jq -n --argjson seen "$seen" --slurpfile lines "${tmp}/lines.json" -f "${SCRIPT_DIR}/attribute-edge.jq")"
  jq --argjson att "$att" '.refusals = $att' "$record" >"${record}.new"
  mv "${record}.new" "$record"
  echo "collect ${scenario}: refusals seen ${seen}, attributed $(jq '[.byTenantReason[].count] | add // 0' <<<"$att") over $(jq '[.byTenantReason[].tenant] | unique | length' <<<"$att") tenants, unattributed $(jq .unattributed <<<"$att")"
done
exit "$status"
