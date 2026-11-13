#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 6 (the next day): the real cost of a run day from Cost
# Explorer (design/agentic-runtime-isolation.stress-test.md §10.1, §11).
#
#   scripts/stress/cost.sh <run-date YYYY-MM-DD> [--baseline YYYY-MM-DD] [--scale small|medium|large]
#
# Cost Explorer settles a day's usage up to 24 hours later, so run this the
# day after the scenarios. It reads the account's unblended cost by service
# for the run day and for a quiet baseline day (default: the day before the
# run; pass a day with no other work in the account), and writes one
# "Cost (Cost Explorer)" section to design/stress-results/<run-date>-<scale>.md,
# replacing an earlier one. The account is shared, so the delta against the
# baseline is the run's cost, not the run-day total. Cost Explorer returns no
# account id, tenant or token; the redaction check of collect.sh runs anyway.
# Cost allocation tags are not an option: a member account of an organization
# cannot activate them. Conventions: scripts/CONVENTIONS.md.

# The backticks in printf formats are literal Markdown.
# shellcheck disable=SC2016

set -euo pipefail

RUN_DATE="${1:-}"
[[ "$RUN_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "usage: $0 <run-date YYYY-MM-DD> [--baseline YYYY-MM-DD] [--scale small|medium|large]" >&2; exit 2; }
shift
BASELINE=""
SCALE="${STRESS_SCALE:-small}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline) BASELINE="${2:-}"; shift 2 ;;
    --scale) SCALE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$BASELINE" ]] && BASELINE="$(date -u -d "${RUN_DATE} -1 day" +%F)"
[[ "$BASELINE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "--baseline must be YYYY-MM-DD" >&2; exit 2; }
[[ "$SCALE" =~ ^(small|medium|large)$ ]] || { echo "--scale must be small, medium or large" >&2; exit 2; }

for tool in aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RESULTS="${SAMPLE_DIR}/design/stress-results/${RUN_DATE}-${SCALE}.md"
[[ -f "$RESULTS" ]] || { echo "No results file at ${RESULTS#"${SAMPLE_DIR}/"}; run collect.sh first" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One day of unblended cost by service. Cost Explorer is a global API served from us-east-1.
day_costs() {
  local day="$1" next
  next="$(date -u -d "${day} +1 day" +%F)"
  aws ce get-cost-and-usage --region us-east-1 \
    --time-period "Start=${day},End=${next}" --granularity DAILY \
    --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json \
    | jq -r '.ResultsByTime[0].Groups[] | [.Keys[0], (.Metrics.UnblendedCost.Amount | tonumber)] | @tsv'
}

day_costs "$RUN_DATE" >"${TMP}/run.tsv"
day_costs "$BASELINE" >"${TMP}/base.tsv"

# Join on service; keep rows where either day is at least one cent; sort by delta.
jq -Rn --arg run "$RUN_DATE" --arg base "$BASELINE" '
  [inputs] as $lines
  | def load(f): [$lines[] | select(startswith(f)) | ltrimstr(f) | split("\t") | {(.[0]): (.[1] | tonumber)}] | add // {};
  (load("R\t")) as $r | (load("B\t")) as $b
  | ([$r, $b | keys[]] | unique) as $services
  | [ $services[] | {service: ., run: ($r[.] // 0), base: ($b[.] // 0)} | .delta = .run - .base
      | select(.run >= 0.01 or .base >= 0.01) ]
  | sort_by(-.delta)
  | {rows: ., total: {run: (map(.run) | add // 0), base: (map(.base) | add // 0)}}
  | .total.delta = .total.run - .total.base
' <(sed 's/^/R\t/' "${TMP}/run.tsv"; sed 's/^/B\t/' "${TMP}/base.tsv") >"${TMP}/cost.json"

SECTION="${TMP}/section.md"
{
  printf '\n## Cost (Cost Explorer), %s\n\n' "$RUN_DATE"
  printf -- '- Baseline day: %s (a day with no stress run; the delta is the cost of the run day)\n' "$BASELINE"
  printf -- '- Read on: %s, unblended cost, whole account (shared), USD\n\n' "$(date -u +%F)"
  printf '| Service | Run day | Baseline | Delta |\n|---|---|---|---|\n'
  jq -r '.rows[] | "| \(.service) | \(.run * 100 | round / 100) | \(.base * 100 | round / 100) | \(.delta * 100 | round / 100) |"' "${TMP}/cost.json"
  jq -r '.total | "| **Total** | **\(.run * 100 | round / 100)** | **\(.base * 100 | round / 100)** | **\(.delta * 100 | round / 100)** |"' "${TMP}/cost.json"
} >"$SECTION"

# Redaction check (§11), the same shapes collect.sh refuses.
LEAK=""
grep -Eq '(^|[^0-9.])[0-9]{12}($|[^0-9])' "$SECTION" && LEAK="${LEAK} a-12-digit-number"
grep -q 'eyJ' "$SECTION" && LEAK="${LEAK} a-token-prefix"
grep -q 'https://' "$SECTION" && LEAK="${LEAK} a-url"
[[ -n "$LEAK" ]] && { echo "Refusing to write the cost section: it holds${LEAK}" >&2; exit 1; }

# Replace an earlier cost section (from "## Cost (Cost Explorer)" to the next "## " or the end), else append.
if grep -q '^## Cost (Cost Explorer)' "$RESULTS"; then
  awk -v section="$SECTION" '
    /^## Cost \(Cost Explorer\)/ { skipping = 1; while ((getline line < section) > 0) print line; next }
    skipping && /^## / { skipping = 0 }
    !skipping { print }
  ' "$RESULTS" >"${TMP}/results.md"
  mv "${TMP}/results.md" "$RESULTS"
else
  cat "$SECTION" >>"$RESULTS"
fi

echo "Wrote the cost section to ${RESULTS#"${SAMPLE_DIR}/"}"
cat "$SECTION"
