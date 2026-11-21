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
#   slice.sh deploy                 slice mode: the smoke stacks and the front door (deploy.sh);
#                                   platform mode: front-door phase one against the real control plane (deploy-platform.sh)
#   slice.sh seed                   slice mode: tenants, their routes and tokens' prerequisites (test/stress/driver.ts);
#                                   platform mode: nothing to seed
#   slice.sh run <scenario>         slice mode: PS-7, route-write, router-load or edge-refusals; platform mode: PS-7
#   slice.sh step phase-two         platform mode only: the main stack with `agentIngress` set to the first cell's ingress (phase-two.sh)
#   slice.sh collect                the edge and cell logs and the router's metrics against the driver's counts
#   slice.sh teardown [--fixtures]  slice mode: the run's tenants, then the stacks; platform mode: the front door's stacks and the
#                                   hook parameter, after the control-plane step `unhook` (teardown.sh)
#
# Slice mode: the front door runs on the smoke stack (a stand-in control plane,
# one demo cell). Platform mode (STRESS_MODE=platform) composes the real control
# plane, its global hooks and the cell scripts: the runner calls `deploy`, then
# the control-plane steps `hooks`, `register` and `warm-up`, then `step
# phase-two` (stress/src/platform.ts), and the front door's tenants and routes
# are the control plane's, so `seed` has nothing to do. The two modes never
# share a run prefix.
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

for name in STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE STRESS_RUN_ID; do
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

# need_mode VERB MODE: exits 2 when the run is in the other mode.
need_mode() {
  if [[ "$STRESS_MODE" != "$2" ]]; then
    echo "slice.sh ${1}: STRESS_MODE=${STRESS_MODE}: this verb runs in ${2} mode only" >&2
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
    no_args deploy "$@"
    need_region
    ensure_built
    if [[ "$STRESS_MODE" == platform ]]; then
      exec "${here}/deploy-platform.sh"
    fi
    exec "${here}/deploy.sh"
    ;;

  seed)
    no_args seed "$@"
    if [[ "$STRESS_MODE" == platform ]]; then
      echo "seed: platform mode: the control plane's tenants and routes come from its hooks; nothing to seed"
      exit 0
    fi
    need_region
    ensure_installed
    driver seed
    ;;

  run)
    if [[ "$STRESS_MODE" == platform ]]; then
      scenarios="PS-7"
    else
      scenarios="PS-7, route-write, router-load, edge-refusals"
    fi
    if (( $# != 1 )); then
      echo "slice.sh run: one scenario id (${scenarios}), got $#" >&2
      exit 2
    fi
    case "$1" in
      PS-7) ;;
      route-write | router-load | edge-refusals)
        need_mode "run $1" slice
        ;;
      *) echo "slice.sh run: unknown scenario $1 (${scenarios})" >&2; exit 2 ;;
    esac
    need_region
    ensure_installed
    driver run "$1"
    ;;

  step)
    need_mode step platform
    if (( $# != 1 )); then
      echo "slice.sh step: one step name (phase-two), got $#" >&2
      exit 2
    fi
    case "$1" in
      phase-two)
        need_region
        ensure_built
        exec "${here}/phase-two.sh"
        ;;
      *) echo "slice.sh step: unknown step $1 (phase-two)" >&2; exit 2 ;;
    esac
    ;;

  collect)
    no_args collect "$@"
    : "${STRESS_RESULTS:?slice.sh collect: STRESS_RESULTS is not set}"
    need_region
    ensure_installed
    driver collect
    ;;

  teardown)
    need_region
    ensure_installed
    exec "${here}/teardown.sh" "$@"
    ;;

  *)
    echo "usage: slice.sh budget | deploy | seed | run <PS-7|route-write|router-load|edge-refusals> | step phase-two | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
