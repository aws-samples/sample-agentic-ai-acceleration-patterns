#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Transaction-conflict probe (ADR-0050): many CreateDeployment calls at once onto one cell,
# counting the FIRST answer of each call. A placement transaction cancelled only by races
# applied nothing, so it must never answer 500; once its retries are spent it answers a 409
# that carries the retry hint. The probe also checks that no deployment it created is left
# CREATING with nothing to move it.
#
#   conflict-probe.sh deploy     the stacks `${PROBE_PREFIX}-cp-setup` and
#                                `${PROBE_PREFIX}-control-plane` from this checkout (the stress
#                                slice's CDK app, test/stress/stress-app.ts), with a source zip
#                                of the no-op scripts
#   conflict-probe.sh setup      the probe application (no-op scripts), the stack's own account
#                                as vendor capacity, PROBE_TENANTS tenants, and the first
#                                deployment, which builds the one cell
#   conflict-probe.sh burst      one CreateDeployment per other tenant, all at once; prints the
#                                first answers and the end state of every deployment created
#   conflict-probe.sh reset      deletes the burst's deployments, five at a time, so the next
#                                burst starts from the same cell
#   conflict-probe.sh clean      deletes every record the probe made (deployments, the cell, the
#                                tenants, the account and the application), then lists the stacks
#                                to remove by hand
#
# Environment: PROBE_PREFIX (names the stacks and the fleet), AWS_REGION, credentials for the
# account (AWS_PROFILE), PROBE_TENANTS (default 20: one warm-up tenant and 19 racers),
# PROBE_HOME (default ~/.conflict-probe), INTEG_DEPLOY_CONCURRENCY (default 2). It needs bash 4
# or newer, curl, git, jq, openssl, zip, node and the AWS CLI; before `deploy`, run `npm ci`
# and `npx projen pre-compile` (the generated Smithy code) in the sample. It prints ids,
# statuses and counts only, never a token or a password, and never runs `set -x`
# (scripts/CONVENTIONS.md).
#
# shortcut: one cell, one Region and the no-op scripts; enough to make placements meet on one
# cell item, not a load test (the platform stress slice is that).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${here}/.." && pwd)"
REPO="$(cd "${SAMPLE_DIR}/../.." && pwd)"
verb="${1:-}"
case "$verb" in
  deploy | setup | burst | reset | clean) ;;
  *)
    echo "usage: conflict-probe.sh deploy | setup | burst | reset | clean" >&2
    exit 2
    ;;
esac

: "${PROBE_PREFIX:?conflict-probe.sh: set PROBE_PREFIX (names the stacks and the fleet)}"
: "${AWS_REGION:?conflict-probe.sh: set AWS_REGION}"
if ! [[ "$PROBE_PREFIX" =~ ^[A-Za-z][A-Za-z0-9-]{2,31}$ ]]; then
  echo "conflict-probe.sh: PROBE_PREFIX must match ^[A-Za-z][A-Za-z0-9-]{2,31}\$" >&2
  exit 2
fi
export AWS_DEFAULT_REGION="$AWS_REGION"
TENANTS="${PROBE_TENANTS:-20}"
if ! [[ "$TENANTS" =~ ^[0-9]+$ ]] || [ "$TENANTS" -lt 2 ] || [ "$TENANTS" -gt 40 ]; then
  echo "conflict-probe.sh: PROBE_TENANTS must be 2 to 40" >&2
  exit 2
fi
APP_ID=probe
SETUP_STACK="${PROBE_PREFIX}-cp-setup"
CP_STACK="${PROBE_PREFIX}-control-plane"
HOME_DIR="${PROBE_HOME:-${HOME}/.conflict-probe}/${PROBE_PREFIX}"
mkdir -p -m 700 "$HOME_DIR"
TENANTS_FILE="${HOME_DIR}/tenants"
if { [ "$verb" = burst ] || [ "$verb" = reset ]; } && [ "$(wc -l 2> /dev/null < "$TENANTS_FILE" || echo 0)" -lt 2 ]; then
  echo "conflict-probe.sh ${verb}: no tenants to race with; run setup first" >&2
  exit 2
fi

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}

# An operator ID token from the setup stack's vendor IdP. The password goes to the CLI, and the
# token to curl, in files readable by this user alone (never on a command line), removed on exit.
AUTH_HEADER=""
INPUT=""
cleanup() { rm -f ${AUTH_HEADER:+"$AUTH_HEADER"} ${INPUT:+"$INPUT"}; }
trap cleanup EXIT
sign_in() {
  local pool client secret token
  pool="$(output "$SETUP_STACK" UserPoolId)"
  client="$(output "$SETUP_STACK" OperatorClientId)"
  aws cognito-idp admin-create-user --user-pool-id "$pool" --username probe-operator \
    --message-action SUPPRESS > /dev/null 2>&1 || true
  secret="Aa1!$(openssl rand -hex 12)"
  INPUT="$(mktemp)"
  chmod 600 "$INPUT"
  # The password reaches jq through its environment, never its argv.
  PROBE_SECRET="$secret" jq -n --arg p "$pool" --arg u probe-operator \
    '{UserPoolId: $p, Username: $u, Password: $ENV.PROBE_SECRET, Permanent: true}' > "$INPUT"
  # A failed call removes the file itself: in a wait_for subshell the EXIT trap does not run.
  aws cognito-idp admin-set-user-password --cli-input-json "file://${INPUT}" > /dev/null || {
    rm -f "$INPUT"
    return 1
  }
  PROBE_SECRET="$secret" jq -n --arg p "$pool" --arg c "$client" --arg u probe-operator \
    '{UserPoolId: $p, ClientId: $c, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: {USERNAME: $u, PASSWORD: $ENV.PROBE_SECRET}}' > "$INPUT"
  token="$(aws cognito-idp admin-initiate-auth --cli-input-json "file://${INPUT}" \
    --query AuthenticationResult.IdToken --output text)" || {
    rm -f "$INPUT"
    return 1
  }
  rm -f "$INPUT"
  INPUT=""
  [ -n "$AUTH_HEADER" ] || AUTH_HEADER="$(mktemp)"
  chmod 600 "$AUTH_HEADER"
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$token" > "$AUTH_HEADER"
  API_URL="$(output "$CP_STACK" ApiUrl)"
  API_URL="${API_URL%/}"
}

# call METHOD PATH [BODY]: sets STATUS and BODY; a transport failure is status 000.
STATUS=""
BODY=""
call() {
  local out
  local data=()
  [ "$#" -lt 3 ] || data=(--data "$3")
  out="$(mktemp)"
  BODY=""
  STATUS="$(curl -s -o "$out" -w '%{http_code}' -X "$1" "${API_URL}$2" \
    -H "@${AUTH_HEADER}" ${data[@]+"${data[@]}"})" || STATUS=000
  BODY="$(cat "$out")"
  rm -f "$out"
}

# The CreateDeployment body: the no-op scripts send no mail, so the address is the SES
# mailbox simulator's.
deployment_body() {
  jq -cn --arg a "$APP_ID" '{applicationId: $a, adminEmail: "success@simulator.amazonses.com"}'
}

# wait_for PATH FIELD PATTERN SECONDS: polls GET PATH until .FIELD.status matches PATTERN (an
# alternation such as `ACTIVE|[A-Z]+_FAILED`); a 404 ends the wait as `gone` when PATTERN
# includes `gone`. Prints the last status; fails on timeout.
wait_for() {
  local path="$1" field="$2" want="$3" until=$((SECONDS + $4)) status refreshed=0
  while [ "$SECONDS" -lt "$until" ]; do
    call GET "$path"
    if [ "$STATUS" = 401 ] && [ "$refreshed" -eq 0 ]; then
      # The ID token outlived its hour: sign in again, once per wait, and poll on.
      sign_in
      refreshed=1
      continue
    fi
    if [ "$STATUS" = 404 ] && [[ gone =~ ^(${want})$ ]]; then
      echo gone
      return 0
    elif [ "$STATUS" = 200 ]; then
      status="$(jq -r ".${field}.status" <<< "$BODY")"
      if [[ "$status" =~ ^(${want})$ ]]; then
        echo "$status"
        return 0
      fi
    fi
    sleep 10
  done
  echo "timeout"
  return 1
}

# delete_deployments TENANT...: deletes each tenant's probe deployment, five at a time, and
# deletes again (at most three times) one that ends DELETE_FAILED: concurrent deletes on one
# cell can meet in the workflow's terminal write (README, Known limitations). Fails when any
# is left.
delete_deployments() {
  local tenants=("$@") wave t s attempt left=0 i
  for ((i = 0; i < ${#tenants[@]}; i += 5)); do
    wave=("${tenants[@]:i:5}")
    for t in "${wave[@]}"; do
      call DELETE "/tenants/${t}/deployments/${APP_ID}"
      [ "$STATUS" = 202 ] || [ "$STATUS" = 404 ] || log "DeleteDeployment ${t}: ${STATUS}"
    done
    for t in "${wave[@]}"; do
      for attempt in 1 2 3 4; do
        s="$(wait_for "/tenants/${t}/deployments/${APP_ID}" deployment 'gone|DELETE_FAILED' 900 || true)"
        [ "$s" != gone ] || break
        [ "$attempt" -lt 4 ] || break
        log "deployment of ${t}: ${s}, deleting again (${attempt})"
        call DELETE "/tenants/${t}/deployments/${APP_ID}"
      done
    done
  done
  for t in "${tenants[@]}"; do
    call GET "/tenants/${t}/deployments/${APP_ID}"
    [ "$STATUS" = 404 ] || left=$((left + 1))
  done
  log "deployments left: ${left}"
  [ "$left" -eq 0 ]
}

case "$verb" in
  deploy)
    commit="$(git -C "$REPO" rev-parse HEAD)"
    zip="${HOME_DIR}/source-${commit}.zip"
    if [ ! -s "$zip" ]; then
      tree="$(mktemp -d "${HOME_DIR}/source.XXXXXX")"
      git -C "$REPO" archive --format=tar "$commit" samples/control-plane/scripts/sample-noop | tar -x -C "$tree"
      (cd "$tree" && zip -q -r -X "$zip" samples)
      find "$tree" -mindepth 1 -delete
      rmdir "$tree"
    fi
    log "deploy: ${SETUP_STACK} and ${CP_STACK} from ${commit} in ${AWS_REGION}"
    account="$(aws sts get-caller-identity --query Account --output text)"
    started=$SECONDS
    (cd "$SAMPLE_DIR" && STRESS_PREFIX="$PROBE_PREFIX" STRESS_BUILD_LIMIT=50 STRESS_SOURCE_ZIP="$zip" \
      CDK_DEFAULT_ACCOUNT="$account" CDK_DEFAULT_REGION="$AWS_REGION" \
      node_modules/.bin/cdk --app "node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/stress-app.ts" \
      --output "${HOME_DIR}/cdk.out" deploy "$SETUP_STACK" "$CP_STACK" --require-approval never \
      --concurrency "${INTEG_DEPLOY_CONCURRENCY:-2}" --progress events > "${HOME_DIR}/deploy.log" 2>&1) || {
      log "deploy failed; see ${HOME_DIR}/deploy.log"
      exit 1
    }
    log "deploy: done in $((SECONDS - started)) s"
    ;;

  setup)
    sign_in
    account="$(aws sts get-caller-identity --query Account --output text)"
    location="$(output "$SETUP_STACK" SourceLocation)"
    noop() { printf '{"create":"samples/control-plane/scripts/sample-noop/create.sh","update":"samples/control-plane/scripts/sample-noop/update.sh","delete":"samples/control-plane/scripts/sample-noop/delete.sh"}'; }
    definition="$(jq -n --arg l "$location" --argjson s "$(noop)" --argjson m "$((TENANTS + 5))" \
      '{source: {type: "S3", location: $l}, cellScripts: $s, tenantScripts: $s, maxTenants: $m, placementStrategy: "FILL", hooks: []}')"
    call PUT "/applications/${APP_ID}" "$definition"
    log "PutApplication: ${STATUS}"
    s="$(wait_for "/applications/${APP_ID}" application 'ACTIVE|[A-Z]+_FAILED' 300 || true)"
    log "application: ${s}"
    [ "$s" = ACTIVE ] || exit 1
    call PUT "/accounts/${account}" "$(jq -n --arg a "$APP_ID" '{owner: "VENDOR", maxCells: 2, applicationIds: [$a]}')"
    log "PutAccount: ${STATUS}"
    s="$(wait_for "/accounts/${account}" account 'ACTIVE|[A-Z]+_FAILED' 300 || true)"
    log "account: ${s}"
    [ "$s" = ACTIVE ] || exit 1
    # A rerun keeps the tenants an earlier setup made.
    touch "$TENANTS_FILE"
    for i in $(seq "$(($(wc -l < "$TENANTS_FILE") + 1))" "$TENANTS"); do
      call POST /tenants "$(jq -n --arg n "probe-${i}" '{name: $n}')"
      [ "$STATUS" = 202 ] || { log "CreateTenant ${i}: ${STATUS} $(jq -r .message <<< "$BODY")"; exit 1; }
      jq -r .tenant.tenantId <<< "$BODY" >> "$TENANTS_FILE"
    done
    while read -r t; do
      s="$(wait_for "/tenants/${t}" tenant 'ACTIVE|[A-Z]+_FAILED' 300 || true)"
      [ "$s" = ACTIVE ] || { log "tenant ${t}: ${s}"; exit 1; }
    done < "$TENANTS_FILE"
    log "tenants: ${TENANTS} ACTIVE"
    first="$(head -n 1 "$TENANTS_FILE")"
    call POST "/tenants/${first}/deployments" "$(deployment_body)"
    log "first CreateDeployment: ${STATUS}"
    [ "$STATUS" = 202 ] || [ "$STATUS" = 409 ] || { log "$(jq -r .message <<< "$BODY")"; exit 1; }
    log "first deployment: $(wait_for "/tenants/${first}/deployments/${APP_ID}" deployment 'ACTIVE|[A-Z]+_FAILED' 1200)"
    ;;

  burst)
    sign_in
    run="${HOME_DIR}/burst-$(date -u +%Y%m%dT%H%M%S)"
    mkdir -p "$run"
    body="$(deployment_body)"
    racers="$(tail -n +2 "$TENANTS_FILE")"
    log "burst: $(wc -l <<< "$racers") CreateDeployment calls at once onto one cell"
    while read -r t; do
      curl -s -o "${run}/${t}.body" -D "${run}/${t}.headers" -w '%{http_code}' -X POST \
        "${API_URL}/tenants/${t}/deployments" -H "@${AUTH_HEADER}" --data "$body" \
        > "${run}/${t}.code" 2> /dev/null &
    done <<< "$racers"
    wait
    echo "first answers (status error-type count):"
    while read -r t; do
      code="$(cat "${run}/${t}.code")"
      type="$(grep -i '^x-amzn-errortype:' "${run}/${t}.headers" | head -n 1 | cut -d' ' -f2 | cut -d: -f1 | tr -d '\r' || true)"
      printf '%s %s\n' "$code" "${type:--}"
    done <<< "$racers" | sort | uniq -c | sed 's/^/  /'
    hint=0
    other=0
    while read -r t; do
      if [ "$(cat "${run}/${t}.code")" = 409 ]; then
        if jq -e '.message | test("retry the request"; "i")' "${run}/${t}.body" > /dev/null 2>&1; then
          hint=$((hint + 1))
        else
          other=$((other + 1))
        fi
      fi
    done <<< "$racers"
    echo "409s with the retry hint: ${hint}; 409s without: ${other}"
    while read -r t; do
      if [ "$(cat "${run}/${t}.code")" = 500 ]; then
        printf '  500 %s: %s\n' "$t" "$(jq -r '.message' "${run}/${t}.body" 2> /dev/null | cut -c1-160 || true)"
      fi
    done <<< "$racers"
    log "burst: waiting for every created deployment to leave CREATING"
    : > "${run}/end"
    while read -r t; do
      if [ "$(cat "${run}/${t}.code")" = 202 ]; then
        printf '%s\n' "$(wait_for "/tenants/${t}/deployments/${APP_ID}" deployment 'ACTIVE|[A-Z]+_FAILED' 1200 || true)" >> "${run}/end"
      fi
    done <<< "$racers"
    echo "end states of the accepted deployments:"
    sort "${run}/end" | uniq -c | sed 's/^/  /'
    # A deployment record without a 202 must not exist: a refused call wrote nothing.
    stray=0
    while read -r t; do
      if [ "$(cat "${run}/${t}.code")" != 202 ]; then
        call GET "/tenants/${t}/deployments/${APP_ID}"
        [ "$STATUS" = 404 ] || { stray=$((stray + 1)); log "refused tenant ${t} has a deployment (${STATUS})"; }
      fi
    done <<< "$racers"
    echo "refused calls that left a deployment: ${stray}"
    echo "results: ${run}"
    failed_500="$(grep -lx 500 "${run}"/*.code 2> /dev/null | wc -l || true)"
    # Any first answer but 202, 409 and 500 (a transport failure, a 4xx, a 502 or 504).
    other_codes="$(grep -Lx -e 202 -e 409 -e 500 "${run}"/*.code 2> /dev/null | wc -l || true)"
    # CREATE_FAILED is settled: the workflow's terminal write is outside ADR-0050.
    left_creating="$(grep -cvx -e ACTIVE -e CREATE_FAILED "${run}/end" || true)"
    if [ "$failed_500" -ne 0 ] || [ "$other_codes" -ne 0 ] || [ "$other" -ne 0 ] || [ "$stray" -ne 0 ] || [ "$left_creating" -ne 0 ]; then
      log "burst: FAILED (${failed_500} answered 500, ${other_codes} other answers, ${other} 409s without the hint, ${stray} strays, ${left_creating} not settled)"
      exit 1
    fi
    log "burst: passed"
    ;;

  reset)
    sign_in
    mapfile -t racers < <(tail -n +2 "$TENANTS_FILE")
    delete_deployments "${racers[@]}"
    ;;

  clean)
    sign_in
    account="$(aws sts get-caller-identity --query Account --output text)"
    status=0
    if [ -s "$TENANTS_FILE" ]; then
      mapfile -t all < "$TENANTS_FILE"
      delete_deployments "${all[@]}" || status=1
    fi
    call GET "/cells?applicationId=${APP_ID}"
    for c in $(jq -r '.cells[]?.cellId' <<< "$BODY"); do
      call DELETE "/cells/${c}"
      [ "$(wait_for "/cells/${c}" cell 'gone|DELETE_FAILED' 1200 || true)" = gone ] || { log "cell ${c} is still there"; status=1; }
    done
    if [ -s "$TENANTS_FILE" ]; then
      while read -r t; do call DELETE "/tenants/${t}"; done < "$TENANTS_FILE"
      while read -r t; do
        [ "$(wait_for "/tenants/${t}" tenant 'gone|DELETE_FAILED' 300 || true)" = gone ] || { log "tenant ${t} is still there"; status=1; }
      done < "$TENANTS_FILE"
    fi
    call DELETE "/accounts/${account}"
    [ "$(wait_for "/accounts/${account}" account 'gone|DELETE_FAILED' 300 || true)" = gone ] || { log "the account is still registered"; status=1; }
    call DELETE "/applications/${APP_ID}"
    [ "$(wait_for "/applications/${APP_ID}" application 'gone|DELETE_FAILED' 300 || true)" = gone ] || { log "the application is still registered"; status=1; }
    [ "$status" -ne 0 ] || : > "$TENANTS_FILE"
    log "clean: records $([ "$status" -eq 0 ] && echo removed || echo LEFT)"
    echo "Remove the stacks by hand, control plane first: ${CP_STACK}, then ${SETUP_STACK}."
    exit "$status"
    ;;
esac
