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
#   slice.sh run <scenario>          S1 to S7: k6 on the driver host, one record per scenario
#   slice.sh collect                 the late fields of this run's records, from the hops' logs (collect.sh)
#   slice.sh teardown [--fixtures]   destroys the stacks; tenants go with them unless the tier keeps a fleet
#
# In slice mode the slice deploys its own cell: one ingress with the tier's agents
# and tool targets (the sample's tier table, test/stress/tiers.ts, which takes the
# shared figures from stress/src/tiers.ts). Identity is the long-lived
# `TenantIdentity-shared-pool` deployment the integration tests share: the slice
# reads its published parameters, registers the vendor scopes it needs, creates and
# deletes its own tenants, and never deploys, replaces, updates or destroys it.
# The platform run (STRESS_MODE=platform) deploys cells through the control plane
# (W-5); until it does, every verb but `budget` refuses that mode.
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

for name in STRESS_TIER STRESS_TIER_JSON STRESS_PREFIX STRESS_HOME STRESS_MODE; do
  if [[ -z "${!name:-}" ]]; then
    echo "slice.sh: ${name} is not set" >&2
    exit 2
  fi
done
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

need_slice_mode() {
  if [[ "$STRESS_MODE" != slice ]]; then
    echo "slice.sh: STRESS_MODE=${STRESS_MODE}: the platform run deploys cells through the control plane (W-5); this slice runs alone until then" >&2
    exit 2
  fi
}

# output KEY -> a stack output the deploy recorded.
output() { jq -r --arg k "$1" '.[$k] // empty' "${STRESS_STATE_DIR}/outputs.json"; }
need() { local v; v="$(output "$1")"; [[ -n "$v" ]] || { echo "slice.sh: output $1 missing from the deploy's outputs; run deploy first" >&2; exit 1; }; printf '%s' "$v"; }

case "$verb" in
  budget)
    ensure_installed --no-install
    slice_cli budget
    ;;

  deploy)
    need_slice_mode
    need_region
    ensure_installed
    ensure_built
    mkdir -p -m 700 "$STRESS_STATE_DIR"
    "${here}/deploy.sh"
    ;;

  seed)
    need_slice_mode
    need_region
    ensure_installed
    mkdir -p -m 700 "$STRESS_STATE_DIR"
    "${here}/seed.sh"
    ;;

  run)
    need_slice_mode
    need_region
    ensure_installed
    scenario="${1:?slice.sh run: a scenario id (S1 to S7)}"
    case "$scenario" in
      S1) k6_file=s1-steady.js ;;
      S2) k6_file=s2-herd.js ;;
      S3) k6_file=s3-noisy.js ;;
      S4) k6_file=s4-tools.js ;;
      S5) k6_file=s5-streams.js ;;
      S6) k6_file=s6-peak.js ;;
      S7) k6_file=s7-eviction.js ;;
      *) echo "slice.sh run: unknown scenario ${scenario} (S1 to S7)" >&2; exit 2 ;;
    esac
    : "${STRESS_RESULTS:?slice.sh run: STRESS_RESULTS is not set}"
    manifest="${STRESS_STATE_DIR}/manifest.json"
    [[ -s "$manifest" ]] || { echo "slice.sh run: no ${manifest}; seed did not run" >&2; exit 1; }

    # The sample's tier (agents, tenant limit, reserved concurrency) is what the scenarios read;
    # the runner's STRESS_TIER_JSON holds only the shared figures.
    tier_json="$(slice_cli tier)"
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
    vu_per_rps="$(jq -r '.k6.vuPerRps // empty' <<<"$tier_json")"
    tokens_in="$(jq -r '.k6.tokensIn // empty' <<<"$tier_json")"
    [[ -z "$vu_per_rps" ]] || env_args+=("VU_PER_RPS=${vu_per_rps}")
    [[ -z "$tokens_in" ]] || env_args+=("TOKENS_IN=${tokens_in}")

    # S2 starts from an instance-free ingress (stress-test plan §13, question 2): a new
    # environment marker retires every warm Lambda instance, the authoriser cache is
    # flushed, and 60 s of no traffic lets the old instances go. The marker is put back
    # when the scenario ends (a stack left with it drifts from its template). S2 reuses
    # the conversations S1 opened: every scenario of a run shares the run id that names them.
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
    fi

    # The per-tenant limit is a fixed one-minute window (ADR-0020): a scenario that starts in
    # the minute the previous one filled inherits its 429s (S4 after S3, 2026-11-09). And
    # collect.sh reads CloudWatch by whole minutes, one past the scenario's last (API Gateway
    # stamps a minute late): a scenario that starts inside the previous one's minutes mixes
    # their metrics (S4 carried S3's 4XX, 2026-11-19). So start on a fresh minute, past the
    # last recorded scenario's metric window (window.sh, ADR-0052).
    # shellcheck source=window.sh
    source "${here}/window.sh"
    prev_end=0
    shopt -s nullglob
    for r in "${STRESS_RESULTS}"/agentic-runtime-isolation.S[1-7].json; do
      end_iso="$(jq -r '.window.end // empty' "$r" 2>/dev/null)" || continue
      [[ -n "$end_iso" ]] || continue
      e="$(date -u -d "$end_iso" +%s 2>/dev/null)" || continue
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
    need_slice_mode
    need_region
    "${here}/collect.sh"
    ;;

  teardown)
    need_slice_mode
    need_region
    ensure_built
    fixtures=0
    [[ "${1:-}" != "--fixtures" ]] || fixtures=1
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
    echo "usage: slice.sh budget | deploy | seed | run <S1..S7> | collect | teardown [--fixtures]" >&2
    exit 2
    ;;
esac
