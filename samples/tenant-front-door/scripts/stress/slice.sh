#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The tenant-front-door slice of the platform stress test
# (docs/stress-test.spec.md §3.4, stress/README.md, README.md beside this
# file). The runner calls it with one verb at a time and the STRESS_*
# environment:
#
#   slice.sh budget                 draws on the account-wide quotas, no credentials
#   slice.sh deploy                 the smoke stacks and the front door (deploy.sh)
#   slice.sh seed                   tenants, their routes and tokens' prerequisites (test/stress/driver.ts)
#   slice.sh run <scenario>         PS-7, route-write, router-load or edge-refusals
#   slice.sh collect                the edge and cell logs and the router's metrics against the driver's counts
#   slice.sh teardown [--fixtures]  the run's tenants, then the stacks (teardown.sh)
#
# Slice mode only: the front door runs on the smoke stack (a stand-in control
# plane, one demo cell). The platform run, which composes the real control
# plane and its global hooks, is a later work item: every verb but `budget`
# refuses that mode.
#
# Needs AWS_REGION and credentials for the account (every verb but budget),
# STRESS_FD_ZONE_ID and STRESS_FD_ZONE_NAME (deploy), bash, aws, jq, node and
# the sample's npm install (run once when missing). Prints ids, counts and
# seconds only, never a token, a password or a key, and never runs `set -x`
# (scripts/CONVENTIONS.md): the runner writes this output to run.log.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${here}/../.." && pwd)"
verb="${1:-}"
[[ $# -eq 0 ]] || shift

for name in STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE; do
  if [[ -z "${!name:-}" ]]; then
    echo "slice.sh: ${name} is not set" >&2
    exit 2
  fi
done
# The prefix names stacks, the IAM role of the stand-in global hook and the
# application domain label, so it is short and lower-case safe.
if ! [[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,27}$ ]]; then
  echo "slice.sh: STRESS_PREFIX must be 1 to 28 letters and digits, starting with a letter (it names the stacks and the application domain)" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "slice.sh: jq is not installed" >&2; exit 2; }

# The packages package.json declares that node_modules lacks, one per line.
missing_packages() {
  (cd "$SAMPLE_DIR" && node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const n of Object.keys(Object.assign({}, p.dependencies, p.devDependencies))) {
      if (!fs.existsSync(`node_modules/${n}/package.json`)) console.log(n);
    }')
}

# ensure_installed [--no-install]: npm ci only when a declared package is missing. With
# --no-install (budget: no credentials, maybe no network) it fails instead.
ensure_installed() {
  local missing
  missing="$(missing_packages)" || { echo "slice.sh: cannot read ${SAMPLE_DIR}/package.json" >&2; exit 1; }
  [[ -n "$missing" ]] || return 0
  if [[ "${1:-}" == --no-install ]]; then
    echo "slice.sh: ${SAMPLE_DIR}/node_modules lacks $(wc -l <<<"$missing") declared packages (first: $(head -n 1 <<<"$missing")); run npm ci there first" >&2
    exit 1
  fi
  (cd "$SAMPLE_DIR" && npm ci --silent)
}

# The registrar's generated server code; a fresh checkout has none.
ensure_built() {
  ensure_installed
  if [[ ! -d "${SAMPLE_DIR}/src/smithy" ]]; then
    (cd "$SAMPLE_DIR" && smithy build >/dev/null)
  fi
}

driver() {
  (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts "$@")
}

need_region() {
  : "${AWS_REGION:?slice.sh: set AWS_REGION to the Region of the stress account}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

need_slice_mode() {
  if [[ "$STRESS_MODE" != slice ]]; then
    echo "slice.sh: STRESS_MODE=${STRESS_MODE}: platform mode (the real control plane, its global hooks, the cell scripts) is not implemented by this slice; it runs alone on the smoke stack" >&2
    exit 2
  fi
}

# no_args VERB ARG... -> exits 2 when the verb got an argument it does not take.
no_args() {
  local v="$1"
  shift
  if (( $# > 0 )); then
    echo "slice.sh ${v}: unexpected argument '$1' (usage: slice.sh ${v})" >&2
    exit 2
  fi
}

case "$verb" in
  budget)
    no_args budget "$@"
    ensure_installed --no-install
    driver budget
    ;;

  deploy)
    need_slice_mode
    no_args deploy "$@"
    need_region
    ensure_built
    exec "${here}/deploy.sh"
    ;;

  seed)
    need_slice_mode
    no_args seed "$@"
    need_region
    ensure_installed
    driver seed
    ;;

  run)
    need_slice_mode
    if (( $# != 1 )); then
      echo "slice.sh run: one scenario id (PS-7, route-write, router-load, edge-refusals), got $#" >&2
      exit 2
    fi
    case "$1" in
      PS-7 | route-write | router-load | edge-refusals) ;;
      *) echo "slice.sh run: unknown scenario $1 (PS-7, route-write, router-load, edge-refusals)" >&2; exit 2 ;;
    esac
    need_region
    ensure_installed
    driver run "$1"
    ;;

  collect)
    need_slice_mode
    no_args collect "$@"
    : "${STRESS_RESULTS:?slice.sh collect: STRESS_RESULTS is not set}"
    need_region
    ensure_installed
    driver collect
    ;;

  teardown)
    need_slice_mode
    need_region
    ensure_installed
    exec "${here}/teardown.sh" "$@"
    ;;

  *)
    echo "usage: slice.sh budget | deploy | seed | run <PS-7|route-write|router-load|edge-refusals> | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
