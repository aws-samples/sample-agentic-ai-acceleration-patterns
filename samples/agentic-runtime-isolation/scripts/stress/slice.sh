#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The agentic-runtime-isolation slice of the platform stress test
# (docs/stress-test.spec.md §3.4, stress/README.md, ADR-0052). The runner calls
# it with one verb at a time and the STRESS_* environment:
#
#   slice.sh budget                  draws on the account-wide quotas, no credentials
#   slice.sh deploy                  <prefix>-ingress, the agents stacks, <prefix>-driver (deploy.sh)
#   slice.sh seed                    the tier's tenants, users, subscriptions and demo rows (seed.sh)
#   slice.sh run <scenario>          S1 to S7 (slice mode) or PS-2, PS-3, PS-4, PS-6, PS-8 (platform
#                                    mode): k6 on the driver host, one record per scenario
#   slice.sh collect                 the late fields of this run's records, from the hops' logs
#                                    (collect.sh; platform mode: collect-platform.sh)
#   slice.sh teardown [--fixtures]   destroys the stacks, and the tenants at small and medium or on --fixtures
#
# In slice mode the slice deploys its own cell: one ingress with the tier's agents
# and tool targets (the sample's tier table, test/stress/tiers.ts, which takes the
# shared figures from stress/src/tiers.ts). Identity is the long-lived
# `TenantIdentity-shared-pool` deployment the integration tests share: the slice
# reads its published parameters, registers the vendor scopes it needs, creates and
# deletes its own tenants, and never deploys, replaces, updates or destroys it.
#
# In platform mode (STRESS_MODE=platform, run with the slices it needs) the slice deploys
# and seeds nothing: the cells are the control plane's, the users are tenant-identity's and
# the edge is the front door's. `deploy` and `seed` check that the manifests those slices
# write to $STRESS_HOME/$STRESS_PREFIX are there (platform.sh); `run` picks the tenants the
# control plane and tenant-identity both know, and sends the S1, S2, S3, S5 and S6 load
# shapes to <edgeUrl>/agents as PS-2, PS-3, PS-4, PS-6 and PS-8 (spec §5.1); `collect` takes
# each refusal's tenant and reason from the driver's own lines (collect-platform.sh);
# `teardown` removes this slice's run files, and the k6 host only when its own `deploy` made
# it. stress/README.md has the manifest contract.
#
# State lives in $STRESS_HOME/$STRESS_PREFIX/agentic-runtime-isolation/: the stack
# outputs, the tenant manifest and the deploy and destroy times; never a token,
# a password or a key. Needs AWS_REGION and credentials for the account (every
# verb but budget), bash, aws, jq, node and the sample's npm install (run once
# when missing). Prints ids and counts only and never runs `set -x`: the runner
# writes this output to run.log (scripts/CONVENTIONS.md).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${here}/../.." && pwd)"
REPO_ROOT="$(cd "${SAMPLE_DIR}/../.." && pwd)"
SAMPLE_REL="samples/agentic-runtime-isolation"
verb="${1:-}"
[[ $# -eq 0 ]] || shift

for name in STRESS_TIER STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE STRESS_RUN_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "slice.sh: ${name} is not set" >&2
    exit 2
  fi
done
if [[ "$STRESS_MODE" != slice && "$STRESS_MODE" != platform ]]; then
  echo "slice.sh: STRESS_MODE must be slice or platform (got '${STRESS_MODE}')" >&2
  exit 2
fi
if ! [[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]]; then
  echo "slice.sh: STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter (it names the stacks)" >&2
  exit 2
fi
prefix_lower="$(printf '%s' "$STRESS_PREFIX" | tr '[:upper:]' '[:lower:]')"
if [[ "$prefix_lower" == tenantidentity* ]]; then
  echo "slice.sh: STRESS_PREFIX must not start with TenantIdentity: those stacks belong to the integration tests" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "slice.sh: jq is not installed" >&2; exit 2; }

# The sample's scripts read these (deploy.sh, seed.sh, teardown.sh, count.sh, collect.sh).
export STRESS_SCALE="$STRESS_TIER"
export STRESS_STATE_DIR="${STRESS_HOME}/${STRESS_PREFIX}/agentic-runtime-isolation"

# The packages package.json declares that node_modules lacks, one per line. Extraneous
# packages (a linked node_modules in a worktree) do not count.
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

# The CDK app imports the generated Smithy server code; a fresh checkout has none.
ensure_built() {
  ensure_installed
  if [[ ! -d "${SAMPLE_DIR}/src/smithy" ]]; then
    (cd "$SAMPLE_DIR" && smithy build >/dev/null)
  fi
}

slice_cli() {
  (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/slice-cli.ts "$@")
}

need_region() {
  : "${AWS_REGION:?slice.sh: set AWS_REGION to the Region of the stress account}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

platform_mode() { [[ "$STRESS_MODE" == platform ]]; }

# shellcheck source=platform.sh
source "${here}/platform.sh"

# no_args VERB ARG... -> exits 2 when the verb got an argument it does not take.
no_args() {
  local v="$1"
  shift
  if (( $# > 0 )); then
    echo "slice.sh ${v}: unexpected argument '$1' (usage: slice.sh ${v})" >&2
    exit 2
  fi
}

# need_var VERB NAME... -> exits 2 when a runner variable the verb reads is not set.
need_var() {
  local v="$1" n
  shift
  for n in "$@"; do
    [[ -n "${!n:-}" ]] || { echo "slice.sh ${v}: ${n} is not set" >&2; exit 2; }
  done
}

# output KEY -> a stack output the deploy recorded.
output() { jq -r --arg k "$1" '.[$k] // empty' "${STRESS_STATE_DIR}/outputs.json"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || { echo "slice.sh: output $1 missing from the deploy's outputs; run deploy first" >&2; exit 1; }; printf '%s' "$v"; }

# Platform mode: the k6 host, <prefix>-driver, is the one stack this slice may deploy (nothing
# else in the runner does). It reuses a host that is already there, and the marker file records
# that this slice deployed it, so `teardown` removes only a host it made.
DRIVER_STACK="${STRESS_PREFIX}-driver"
DRIVER_MARK="${STRESS_STATE_DIR}/platform-driver-owned"

# stack_status NAME -> prints the stack's status, or `absent` when CloudFormation says it does not
# exist; any other AWS error prints its code to stderr and fails, so an expired token is never
# taken for "there" or for "absent".
stack_status() {
  local out errfile err code
  errfile="$(mktemp)"
  if out="$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>"$errfile")"; then
    rm -f "$errfile"
    printf '%s\n' "$out"
    return 0
  fi
  err="$(cat "$errfile")"
  rm -f "$errfile"
  if grep -q 'does not exist' <<<"$err"; then
    echo absent
    return 0
  fi
  code="$(sed -n 's/.*An error occurred (\([A-Za-z0-9.]*\)).*/\1/p' <<<"$err" | head -n 1)"
  # An error with no code (no credentials, no network) shows its first line instead.
  [[ -n "$code" ]] || code="$(head -n 1 <<<"$err" | cut -c1-80)"
  echo "slice.sh: could not read the status of $1 (${code:-no reason given})" >&2
  return 1
}

# driver_script deploy|teardown -> runs the shared driver's script for this prefix and prints its `stack=` lines.
driver_script() {
  local log
  log="$(mktemp)"
  if ! STRESS_PREFIX="$STRESS_PREFIX" STRESS_TIER="$STRESS_TIER" "${REPO_ROOT}/stress/driver/${1}.sh" >"$log" 2>&1; then
    tail -30 "$log" >&2
    rm -f "$log"
    echo "slice.sh: stress/driver/${1}.sh failed for ${DRIVER_STACK}" >&2
    return 1
  fi
  grep '^stack=' "$log" || true
  rm -f "$log"
}

case "$verb" in
  budget)
    no_args budget "$@"
    ensure_installed --no-install
    slice_cli budget
    ;;

  deploy)
    no_args deploy "$@"
    if platform_mode; then
      need_platform_inputs deploy
      need_region
      mkdir -p -m 700 "$STRESS_STATE_DIR"
      host="$(stack_status "$DRIVER_STACK")" || exit 1
      case "$host" in
        absent)
          echo "deploy: platform mode: ${DRIVER_STACK}, the k6 host (stress/driver/deploy.sh); no cell stack here, the cells are the control plane's"
          # Mark first: a deploy that fails halfway still leaves a stack this slice must remove.
          : >"$DRIVER_MARK"
          if ! driver_script deploy; then
            # A deploy that failed before it made the stack leaves nothing to remove.
            [[ "$(stack_status "$DRIVER_STACK" 2>/dev/null || echo unknown)" != absent ]] || rm -f "$DRIVER_MARK"
            exit 1
          fi
          ;;
        CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE | IMPORT_COMPLETE)
          echo "deploy: platform mode: ${DRIVER_STACK} is already there and stays its owner's; no cell stack here, the cells are the control plane's"
          ;;
        *)
          echo "slice.sh deploy: ${DRIVER_STACK} is ${host}: remove or repair it before a platform run" >&2
          exit 1
          ;;
      esac
      echo "deploy: edge, identity and tenants are read from ${PLATFORM_MANIFEST_DIR}"
      exit 0
    fi
    need_region
    ensure_installed
    ensure_built
    mkdir -p -m 700 "$STRESS_STATE_DIR"
    "${here}/deploy.sh"
    ;;

  seed)
    no_args seed "$@"
    if platform_mode; then
      need_platform_inputs seed
      echo "seed: platform mode: nothing to seed; each run picks its tenants from the control-plane and tenant-identity manifests"
      exit 0
    fi
    need_region
    ensure_installed
    mkdir -p -m 700 "$STRESS_STATE_DIR"
    "${here}/seed.sh"
    ;;

  run)
    if (( $# != 1 )); then
      echo "slice.sh run: one scenario id (S1 to S7, or PS-2, PS-3, PS-4, PS-6, PS-8 in platform mode), got $#: usage slice.sh run <scenario>" >&2
      exit 2
    fi
    scenario="$1"
    # The k6 file of each scenario. A platform scenario is a slice scenario's shape sent to the
    # edge (spec §5.1): PS-2 is S1, PS-3 is S2, PS-4 is S3, PS-6 is S5 and PS-8 is S6, and the
    # record carries the PS id (RECORD_SCENARIO). PS-3 reuses the conversations PS-2 opened.
    if platform_mode; then
      case "$scenario" in
        PS-2) k6_file=s1-steady.js ;;
        PS-3) k6_file=s2-herd.js ;;
        PS-4) k6_file=s3-noisy.js ;;
        PS-6) k6_file=s5-streams.js ;;
        PS-8) k6_file=s6-peak.js ;;
        S[1-7]) echo "slice.sh run: ${scenario} runs in slice mode only; in platform mode run PS-2, PS-3, PS-4, PS-6 or PS-8" >&2; exit 2 ;;
        *) echo "slice.sh run: unknown scenario ${scenario} (PS-2, PS-3, PS-4, PS-6, PS-8)" >&2; exit 2 ;;
      esac
    else
      case "$scenario" in
        S1) k6_file=s1-steady.js ;;
        S2) k6_file=s2-herd.js ;;
        S3) k6_file=s3-noisy.js ;;
        S4) k6_file=s4-tools.js ;;
        S5) k6_file=s5-streams.js ;;
        S6) k6_file=s6-peak.js ;;
        S7) k6_file=s7-eviction.js ;;
        PS-2 | PS-3 | PS-4 | PS-6 | PS-8) echo "slice.sh run: ${scenario} runs in platform mode only: it needs the edge, so run it with every slice it needs" >&2; exit 2 ;;
        *) echo "slice.sh run: unknown scenario ${scenario} (S1 to S7)" >&2; exit 2 ;;
      esac
    fi
    first=""
    case "$scenario" in
      S2) first=S1 ;;
      PS-3) first=PS-2 ;;
    esac
    need_var run STRESS_RESULTS STRESS_COMMIT
    # S2 is a cold-ingress test on warm conversations: it reuses the ones S1 opened in this run
    # (the run id names them). Without them every tenant opens a new Runtime session at the
    # herd rate, which tests the Runtime's session-creation quota instead (plan F-2).
    if [[ -n "$first" && ! -s "${STRESS_RESULTS}/agentic-runtime-isolation.${first}.json" ]]; then
      echo "slice.sh run ${scenario}: no agentic-runtime-isolation.${first}.json in ${STRESS_RESULTS}; ${scenario} reuses the conversations ${first} opens in the same run, so run ${first} first (--scenarios ${first},${scenario})" >&2
      exit 2
    fi
    need_region
    ensure_installed
    if ! platform_mode; then
      manifest="${STRESS_STATE_DIR}/manifest.json"
      [[ -s "$manifest" ]] || { echo "slice.sh run: no ${manifest}; seed did not run" >&2; exit 1; }
    fi

    # The sample's tier (agents, tenant limit, reserved concurrency) is what the scenarios read;
    # the runner's STRESS_TIER_JSON holds only the shared figures.
    tier_json="$(slice_cli tier)"
    if platform_mode; then
      # No cell of this slice's own: the edge, the stress identity and the tenants come from
      # the other slices' manifests (platform.sh).
      need_platform_inputs run
      manifest="${STRESS_STATE_DIR}/manifest.json"
      build_platform_manifest "$tier_json" "$manifest"
      env_args=(
        "MANIFEST=/opt/stress/inputs/manifest.json"
        "ENDPOINT=${EDGE_URL}/agents"
        "AGENT_BACKEND=${EDGE_BACKEND}"
        "PLATFORM_API=${IDENTITY_API}"
        "APP_CLIENT_ID=${IDENTITY_CLIENT}"
        "RECORD_SCENARIO=${scenario}"
      )
    else
      manifest="${STRESS_STATE_DIR}/manifest.json"
      ident="/application-plane/shared/identity"
      platform_api="$(aws ssm get-parameter --name "${ident}/apiUrl" --query Parameter.Value --output text)"
      [[ "$platform_api" == */ ]] || platform_api="${platform_api}/"
      app_client_id="$(aws ssm get-parameter --name "${ident}/appClientId" --query Parameter.Value --output text)"

      env_args=(
        "MANIFEST=/opt/stress/inputs/manifest.json"
        "ENDPOINT=$(need EndpointUrl)"
        "ENTITLEMENTS_API=$(need EntitlementsApiUrl)"
        "PLATFORM_API=${platform_api}"
        "APP_CLIENT_ID=${app_client_id}"
        "ISSUER=$(need Issuer)"
        "REGION=${AWS_REGION}"
      )
    fi
    vu_per_rps="$(jq -r '.k6.vuPerRps // empty' <<<"$tier_json")"
    tokens_in="$(jq -r '.k6.tokensIn // empty' <<<"$tier_json")"
    [[ -z "$vu_per_rps" ]] || env_args+=("VU_PER_RPS=${vu_per_rps}")
    [[ -z "$tokens_in" ]] || env_args+=("TOKENS_IN=${tokens_in}")

    # S2 starts from an instance-free ingress (stress-test plan §13, question 2): a new
    # environment marker retires every warm Lambda instance, the authoriser cache is
    # flushed, and 60 s of no traffic lets the old instances go. The marker is put back
    # when the scenario ends (a stack left with it drifts from its template).
    # marker_restore holds FUNCTION|FILE, FILE the environment to put back (a mode-600 temp
    # file, passed as file:// so no value shows in the process list).
    marker_restore=()
    restore_instances() {
      local r
      for r in "${marker_restore[@]:-}"; do
        [[ -n "$r" ]] || continue
        aws lambda update-function-configuration --function-name "${r%%|*}" --environment "file://${r#*|}" >/dev/null 2>&1 \
          && aws lambda wait function-updated --function-name "${r%%|*}" 2>/dev/null \
          || echo "cleanup: restore the environment of ${r%%|*} failed; redeploy the stack to clear STRESS_INSTANCE_MARKER" >&2
        rm -f "${r#*|}"
      done
      marker_restore=()
    }
    new_instances() { # FUNCTION
      local before envfile restorefile
      envfile="$(mktemp)"
      restorefile="$(mktemp)"
      before="$(aws lambda get-function-configuration --function-name "$1" --query 'Environment.Variables' --output json)"
      jq -c '{Variables: (. // {})}' <<<"$before" >"$restorefile"
      marker_restore+=("$1|${restorefile}")
      jq -c --arg m "${STRESS_RUN_ID}-${scenario}" '{Variables: ((. // {}) + {STRESS_INSTANCE_MARKER: $m})}' <<<"$before" >"$envfile"
      aws lambda update-function-configuration --function-name "$1" --environment "file://${envfile}" >/dev/null \
        || { rm -f "$envfile"; echo "update-function-configuration $1 failed" >&2; exit 1; }
      rm -f "$envfile"
      aws lambda wait function-updated --function-name "$1" || { echo "wait function-updated $1 failed" >&2; exit 1; }
    }
    trap restore_instances EXIT
    if [[ "$scenario" == S2 ]]; then
      echo "== S2 recipe: new Lambda instances, authoriser cache flushed, 60 s idle"
      fns=("$(need AuthorizerFunctionName)" "$(need IngressFunctionName)")
      IFS=',' read -r -a interceptors <<<"$(output InterceptorFunctionNames)"
      for fn in "${interceptors[@]}"; do [[ -z "$fn" ]] || fns+=("$fn"); done
      for fn in "${fns[@]}"; do new_instances "$fn"; done
      aws apigateway flush-stage-authorizers-cache --rest-api-id "$(need RestApiId)" --stage-name "$(need StageName)" \
        || { echo "flush-stage-authorizers-cache failed" >&2; exit 1; }
      echo "  ${#fns[@]} functions on new instances; authoriser cache flushed"
      sleep 60
    elif [[ "$scenario" == PS-3 ]]; then
      # The functions are in the cell accounts, which this slice has no write access to: PS-3
      # cannot retire their instances. It waits as long as S2's idle, so a short quiet spell
      # lets the oldest go, and starts the herd from there (stress/README.md, known limitations).
      echo "== PS-3 recipe: the cells' Lambda instances are not retired in platform mode; 60 s idle"
      sleep 60
    fi

    # Two fixed-minute measures follow one scenario into the next: the per-tenant limit is a
    # one-minute window (ADR-0020), so a scenario that starts in the minute the previous one
    # filled inherits its 429s; and collect.sh reads CloudWatch by whole minutes, one past the
    # scenario's last (API Gateway stamps a minute late), so a scenario that starts inside the
    # previous one's minutes mixes their metrics. So start on a fresh minute, past the last
    # recorded scenario's metric window (window.sh, ADR-0052).
    # shellcheck source=window.sh
    source "${here}/window.sh"
    prev_end=0
    shopt -s nullglob
    for r in "${STRESS_RESULTS}"/agentic-runtime-isolation.S[1-7].json "${STRESS_RESULTS}"/agentic-runtime-isolation.PS-[2-8].json; do
      end_iso="$(jq -er '.window.end' "$r" 2>/dev/null)" \
        || { echo "slice.sh run: ${r} has no window.end; cannot space ${scenario} after it" >&2; exit 1; }
      e="$(iso_epoch "$end_iso")" || { echo "slice.sh run: ${r}: window.end is not a timestamp" >&2; exit 1; }
      if (( e > prev_end )); then prev_end=$e; fi
    done
    shopt -u nullglob
    now="$(date +%s)"
    start="$(start_at "$prev_end" "$now")"
    if (( start > now )); then
      echo "waiting $(( start - now ))s for a fresh minute past the last scenario's metric window"
      sleep "$(( start - now ))"
    fi

    # The scenario's own time, its token set-up and warm-up, and room for a slow host.
    scenario_seconds="$(jq -r .scenarioSeconds <<<"$tier_json")"
    echo "run: ${scenario} (${k6_file}) at ${STRESS_TIER}, started $(date -u +%FT%TZ)"
    code=0
    STRESS_TIER_JSON="$tier_json" K6_INPUTS="$manifest" K6_TIMEOUT="$(( 900 + 3 * scenario_seconds ))" \
      "${REPO_ROOT}/stress/driver/k6.sh" "${SAMPLE_REL}/scripts/stress/k6/${k6_file}" "${env_args[@]}" || code=$?
    record="${STRESS_RESULTS}/agentic-runtime-isolation.${scenario}.json"
    if [[ -s "$record" ]]; then
      jq -r '"record \(.scenario): \(.requests | to_entries | map("\(.key)=\(.value)") | join(" ")); isolation \(.isolation.mismatches) mismatches in \(.isolation.assertions) assertions; refusals seen \(.refusals.unattributed)"' "$record"
    fi
    exit "$code"
    ;;

  collect)
    no_args collect "$@"
    need_var collect STRESS_RESULTS STRESS_COMMIT
    if platform_mode; then
      exec "${here}/collect-platform.sh"
    fi
    need_region
    "${here}/collect.sh"
    ;;

  teardown)
    fixtures=0
    case "$#:${1:-}" in
      0:) ;;
      1:--fixtures) fixtures=1 ;;
      *) echo "slice.sh teardown: unexpected argument '$1' (usage: slice.sh teardown [--fixtures])" >&2; exit 2 ;;
    esac
    if platform_mode; then
      # The slice made no tenant and no cell. It removes its run files, and the k6 host only
      # when its own deploy made it (fixtures stay with their owners).
      rm -f "${STRESS_STATE_DIR}/manifest.json" "${STRESS_STATE_DIR}/platform-tenants.json"
      if [[ -e "$DRIVER_MARK" ]]; then
        need_region
        echo "teardown: platform mode: ${DRIVER_STACK} (stress/driver/teardown.sh)"
        driver_script teardown
        rm -f "$DRIVER_MARK"
      else
        echo "teardown: platform mode: this slice deployed and created nothing"
      fi
      exit 0
    fi
    need_region
    ensure_built
    # The run's tenants go with it when the tier onboards every run (small, medium: stress
    # ADR-0004) or on --fixtures; at `large` the seeded fleet stays, as the fixture it is.
    tenants=()
    onboarding="$(jq -er .onboarding <<<"$STRESS_TIER_JSON")"
    if [[ "$fixtures" -eq 1 || "$onboarding" == every-run ]]; then
      tenants=(--tenants)
    fi
    exec "${here}/teardown.sh" ${tenants[@]+"${tenants[@]}"}
    ;;

  *)
    echo "usage: slice.sh budget | deploy | seed | run <S1..S7 | PS-2 PS-3 PS-4 PS-6 PS-8> | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
