#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Helpers of the integration test driver (scripts/integ.sh, spec §10),
# sourced by it. Tokens, passwords and SigV4 keys stay in shell variables
# and 0600 files and reach curl on stdin (scripts/CONVENTIONS.md). Nothing
# here prints one. Every AWS call made under a test role runs in a
# subshell that holds that role's credentials, so the driver's own stay as
# they were.

# -- Output -------------------------------------------------------------------
PASS=0; FAILS=0; SKIPS=0
section() { echo; echo "== $*"; }
note() { echo "  $*"; }
check() { # NAME WANT GOT: WANT is an extended regex matched whole
  if [[ "$3" =~ ^($2)$ ]]; then PASS=$((PASS + 1)); echo "  PASS $1 ($3)"; else
    FAILS=$((FAILS + 1)); echo "  FAIL $1: want $2, got $3 (body: $(head -c 200 "$BODY" 2>/dev/null | tr -cd '[:print:]'))"; fi
}
check_eq() { # NAME WANT GOT: a literal comparison, for values holding regex characters (JSON)
  if [[ "$3" == "$2" ]]; then PASS=$((PASS + 1)); echo "  PASS $1"; else
    FAILS=$((FAILS + 1)); echo "  FAIL $1: want $2, got $3"; fi
}
skip() { SKIPS=$((SKIPS + 1)); echo "  SKIP $*"; }
yes_no() { if "$@"; then echo yes; else echo no; fi; }
elapsed() { echo $(( $(date +%s) - $1 )); }
die() { echo "integ: $*" >&2; exit 1; }
# rand_chars SET N: N random characters of SET (tr's set syntax).
rand_chars() {
  local out
  out="$(LC_ALL=C tr -dc "$1" </dev/urandom 2>/dev/null | head -c "$2")" || true
  printf '%s' "$out"
}

# timed KIND NAME CMD...: runs CMD, records "KIND<TAB>NAME<TAB>seconds<TAB>ok|failed" in times.tsv.
timed() {
  local kind="$1" name="$2" t rc=0
  shift 2
  t=$(date +%s)
  "$@" || rc=$?
  printf '%s\t%s\t%s\t%s\n' "$kind" "$name" "$(elapsed "$t")" "$([[ $rc == 0 ]] && echo ok || echo failed)" >>"$RUN_DIR/times.tsv"
  return $rc
}

# -- Run state ------------------------------------------------------------------
# state.env holds the run's ids (tenants, cells, applications), never a secret;
# teardown reads it after an interruption.
state_set() { # NAME VALUE
  [[ "$1" =~ ^[A-Z_][A-Z0-9_]*$ && "$2" =~ ^[A-Za-z0-9._:/@+=-]*$ ]] || die "state value for $1 has unexpected characters"
  printf -v "$1" '%s' "$2"
  grep -v "^$1=" "$RUN_DIR/state.env" >"$RUN_DIR/state.env.new" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >>"$RUN_DIR/state.env.new"
  mv "$RUN_DIR/state.env.new" "$RUN_DIR/state.env"
}
state_load() { [[ -f "$RUN_DIR/state.env" ]] || return 0; while IFS='=' read -r k v; do [[ -n "$k" ]] && printf -v "$k" '%s' "$v"; done <"$RUN_DIR/state.env"; }

# ctx_set KEY JSON: adds a value to the integ context the CDK app reads.
ctx_set() {
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$RUN_DIR/context.json" >"$RUN_DIR/context.json.new"
  mv "$RUN_DIR/context.json.new" "$RUN_DIR/context.json"
}

# -- CDK ------------------------------------------------------------------------
# integ_cdk LABEL CDK-ARGS...: the test app in this run's mode, its own cloud assembly per call.
integ_cdk() {
  local label="$1"
  shift
  npx cdk "$@" --app "npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ.${MODE}.ts" \
    --output "$RUN_DIR/cdk.out.${label}" --context integ="$(cat "$RUN_DIR/context.json")" \
    >"$RUN_DIR/logs/${label}.log" 2>&1
}
# deploy_one STACK-SELECTOR LABEL: one stack of the test app, timed.
deploy_one() {
  timed deploy "$2" integ_cdk "deploy-$2" deploy --exclusively "$1" --require-approval never \
    || { tail -40 "$RUN_DIR/logs/deploy-$2.log"; return 1; }
}
destroy_one() { # STACK-SELECTOR LABEL
  timed destroy "$2" integ_cdk "destroy-$2" destroy --exclusively "$1" --force \
    || { tail -20 "$RUN_DIR/logs/destroy-$2.log"; return 1; }
}

# cp_cdk LABEL ACCOUNT CDK-ARGS...: the control-plane sample's own app (its deploy path, spec §6.3).
cp_cdk() {
  local label="$1" account="$2"
  shift 2
  ( cd "$CONTROL_PLANE_DIR" && CDK_DEFAULT_ACCOUNT="$account" CDK_DEFAULT_REGION="$REGION" \
      npx cdk "$@" --output "$RUN_DIR/cdk.out.${label}" ) >"$RUN_DIR/logs/${label}.log" 2>&1
}

# stack_out STACK KEY: an output of one of this run's stacks in the edge account.
stack_out() { aws cloudformation describe-stacks --region "${3:-$REGION}" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text; }
# cp_stack_out STACK KEY: the same in the control plane's account, through the driver access role.
cp_stack_out() { in_cp aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text; }

# -- Credentials ------------------------------------------------------------------
# assume ROLE_ARN: sets AK, SK, ST (not exported) for signed calls.
assume() {
  local creds
  creds="$(aws sts assume-role --role-arn "$1" --role-session-name "tfd-integ-${RUN_ID}" --query Credentials --output json)" || return 1
  AK="$(jq -r .AccessKeyId <<<"$creds")"; SK="$(jq -r .SecretAccessKey <<<"$creds")"; ST="$(jq -r .SessionToken <<<"$creds")"
}
own_creds() {
  local creds
  creds="$(aws configure export-credentials --format process)"
  AK="$(jq -r .AccessKeyId <<<"$creds")"; SK="$(jq -r .SecretAccessKey <<<"$creds")"; ST="$(jq -r '.SessionToken // empty' <<<"$creds")"
}
# as_role ROLE_ARN CMD...: runs CMD in a subshell with the role's credentials.
as_role() {
  local role="$1"
  shift
  (
    assume "$role" || exit 1
    export AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST"
    unset AWS_PROFILE
    "$@"
  )
}
in_cp() { as_role "$CP_ACCESS_ROLE" "$@"; }
as_test() { as_role "$TEST_ROLE" "$@"; }

# -- HTTP ---------------------------------------------------------------------------
# signed METHOD URL [JSON]: SigV4 with AK/SK/ST for SIG_REGION (default REGION) -> status; body in $BODY.
signed() {
  local args=(-s -o "$BODY" -w '%{http_code}' --max-time 30 -X "$1" --aws-sigv4 "aws:amz:${SIG_REGION:-$REGION}:execute-api" --config -) config
  config="user = \"${AK}:${SK}\""
  [[ -n "$ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${ST}\""
  if [[ -n "${3:-}" ]]; then printf '%s' "$3" >"$REQ"; args+=(-H 'Content-Type: application/json' --data-binary "@$REQ"); fi
  : >"$BODY"
  curl "${args[@]}" "$2" <<<"$config" || echo 000
}
# as ROLE_ARN METHOD PATH [JSON]: one registrar call as the role.
as() { assume "$1" || { echo 000; return; }; signed "$2" "${REGISTRAR}$3" "${4:-}"; }

# edge METHOD HOST PATH [TOKEN_VAR] [curl args...] -> status; headers in $HEAD, body in $BODY.
edge() {
  local method="$1" host="$2" path="$3" tv="${4:-}" config=""
  shift 3; shift || true
  [[ -n "$tv" ]] && config="header = \"Authorization: Bearer ${!tv}\""
  : >"$BODY"; : >"$HEAD"
  curl -s -D "$HEAD" -o "$BODY" -w '%{http_code}' --max-time 30 -X "$method" "$@" --config - "https://${host}${path}" <<<"$config" || echo 000
}
header() { { grep -i "^$1:" "$HEAD" || true; } | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
has_header() { [[ -n "$(header "$1")" ]] && echo yes || echo no; }
body_tenant() { jq -r '.tenantId // empty' "$BODY" 2>/dev/null | tr '[:lower:]' '[:upper:]'; }
body_cell() { jq -r '.cellId // empty' "$BODY" 2>/dev/null; }

# §7.1 header set on the last answer.
check_headers() { # LABEL
  check "$1: Content-Security-Policy" yes "$(has_header content-security-policy)"
  check "$1: Strict-Transport-Security" yes "$(has_header strict-transport-security)"
  check "$1: X-Content-Type-Options" nosniff "$(header x-content-type-options)"
  check "$1: X-Frame-Options" DENY "$(header x-frame-options)"
  check "$1: Cross-Origin-Opener-Policy" same-origin "$(header cross-origin-opener-policy)"
  check "$1: Referrer-Policy" strict-origin-when-cross-origin "$(header referrer-policy)"
}

# wait_status NAME WANT HOST PATH TOKEN_VAR [max seconds]: polls until five answers in a row match.
wait_status() {
  local run=0 st start max="${6:-180}"
  start=$(date +%s)
  while (( $(elapsed "$start") < max )); do
    st="$(edge GET "$3" "$4" "$5")"
    if [[ "$st" =~ ^($2)$ ]]; then run=$((run + 1)); (( run >= 5 )) && break; else run=0; fi
    sleep 2
  done
  check "$1 (after $(elapsed "$start") s)" "$2" "$st"
}
propagate() { note "waiting ${1:-90} s for route propagation (§4.2)"; sleep "${1:-90}"; }

# -- Control plane API (operator token from the vendor IdP) ---------------------------
CP_TOKEN=""; CP_TOKEN_AT=0
# set_operator_password: a new random password for the vendor IdP's operator user, kept in this shell only.
set_operator_password() {
  OPERATOR_PASSWORD="Tfd-$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')-Op1!"
  aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$VENDOR_POOL" --username integ-operator \
    --message-action SUPPRESS >/dev/null 2>&1 || true
  printf '%s' "$OPERATOR_PASSWORD" | jq -Rc --arg p "$VENDOR_POOL" '{UserPoolId: $p, Username: "integ-operator", Password: ., Permanent: true}' >"$TMP/password.json"
  chmod 600 "$TMP/password.json"
  aws cognito-idp admin-set-user-password --region "$REGION" --cli-input-json "file://$TMP/password.json" >/dev/null
  : >"$TMP/password.json"
  CP_TOKEN=""; CP_TOKEN_AT=0
}
api_token() {
  (( $(date +%s) - CP_TOKEN_AT < 2400 )) && [[ -n "$CP_TOKEN" ]] && return 0
  # The password reaches the CLI in a 0600 input file, never on its command line.
  printf '%s' "$OPERATOR_PASSWORD" | jq -Rc --arg p "$VENDOR_POOL" --arg c "$VENDOR_OPERATOR_CLIENT" \
    '{UserPoolId: $p, ClientId: $c, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: {USERNAME: "integ-operator", PASSWORD: .}}' >"$TMP/auth.json"
  chmod 600 "$TMP/auth.json"
  CP_TOKEN="$(aws cognito-idp admin-initiate-auth --region "$REGION" --cli-input-json "file://$TMP/auth.json" \
    --query AuthenticationResult.IdToken --output text)" || { : >"$TMP/auth.json"; die "the operator could not sign in to the vendor IdP"; }
  : >"$TMP/auth.json"
  CP_TOKEN_AT=$(date +%s)
}
# api METHOD PATH [JSON] -> status; body in $BODY.
api() {
  api_token
  local args=(-s -o "$BODY" -w '%{http_code}' --max-time 30 -X "$1" --config -)
  if [[ -n "${3:-}" ]]; then printf '%s' "$3" >"$REQ"; args+=(-H 'Content-Type: application/json' --data-binary "@$REQ"); fi
  : >"$BODY"
  curl "${args[@]}" "${CP_API}${2#/}" <<<"header = \"Authorization: Bearer ${CP_TOKEN}\"" || echo 000
}
# api_poll PATH JQ WANT [timeout s] [interval s]: polls a Get until JQ matches WANT or a *_FAILED status; leaves the answer in $BODY.
api_poll() {
  local start got st max="${4:-1200}" every="${5:-15}"
  start=$(date +%s)
  while :; do
    st="$(api GET "$1")"
    got="$(jq -r "$2" "$BODY" 2>/dev/null || true)"
    [[ "$st" == 200 && "$got" =~ ^($3)$ ]] && { POLLED="$got"; return 0; }
    [[ "$got" == *_FAILED ]] && { POLLED="$got"; return 1; }
    (( $(elapsed "$start") > max )) && { POLLED="${st}:${got}"; return 1; }
    sleep "$every"
  done
}
# api_gone PATH [timeout s]: polls until the Get answers 404.
api_gone() {
  local start max="${2:-1500}"
  start=$(date +%s)
  while [[ "$(api GET "$1")" != 404 ]]; do
    (( $(elapsed "$start") > max )) && return 1
    sleep 20
  done
}
# deployment_path TENANT [APP], cell_path CELL
deployment_path() { echo "tenants/$1/deployments/${2:-$APP}"; }
# api_status PATH JQ: the field now.
api_status() { api GET "$1" >/dev/null; jq -r "$2" "$BODY" 2>/dev/null; }
# last_hooks PATH JQ-PREFIX: the hook ids in a record's lastGlobalHooks, comma-separated.
last_hooks() { api GET "$1" >/dev/null; jq -r "$2.lastGlobalHooks // [] | map(.hookId) | sort | join(\",\")" "$BODY" 2>/dev/null; }

# -- tenant-identity (SigV4 with the driver's credentials) ----------------------------------
# ti_tenant API TENANT_ID NAME -> sets TI_ADMIN (the admin user's name)
ti_tenant() {
  local st
  own_creds
  st="$(SIG_REGION="$IDENTITY_REGION" signed POST "${1}platform/tenants" "$(jq -nc --arg id "$2" --arg n "$3" --arg e "success+$3@simulator.amazonses.com" \
    '{tenantId: $id, name: $n, adminEmail: $e, scopes: ["app/use"]}')")"
  [[ "$st" == 201 ]] || die "tenant-identity CreateTenant $3: HTTP $st"
  TI_ADMIN="$(jq -r .admin.user.username "$BODY")"
}
# ti_token API TENANT_ID USER VAR: a fresh access token (the pool's last one hour).
ti_token() {
  local st pw
  own_creds
  pw="Tfd-Integ-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')!"
  st="$(SIG_REGION="$IDENTITY_REGION" signed POST "${1}platform/tenants/$2/users/$3/token" "$(printf '%s' "$pw" | jq -Rs '{password: .}')")"
  [[ "$st" == 200 ]] || die "tenant-identity IssueToken: HTTP $st"
  printf -v "$4" '%s' "$(jq -r .accessToken "$BODY")"; : >"$BODY"
}
ti_delete() { own_creds; SIG_REGION="$IDENTITY_REGION" signed DELETE "${1}platform/tenants/$2" >/dev/null || true; }
# token_for T VAR: a token for one of the run's tenants (a, b, c), minted again after 30 minutes.
token_for() {
  local id_var="TENANT_${1^^}" user_var="TI_USER_${1^^}" at_var="TOKEN_AT_${1^^}"
  if (( $(date +%s) - ${!at_var:-0} > 1800 )); then
    ti_token "$IDENTITY_API" "${!id_var}" "${!user_var}" "$2"
    printf -v "$at_var" '%s' "$(date +%s)"
  fi
}

# -- The router, through CloudFront's TestFunction (test role) -------------------------------
# test_fn METHOD URI HOST [QUERY_JSON] [HEADERS_FILE]: sets TF_OUT (the function's
# output object), TF_ERR and TF_COMPUTE. Headers that may hold a token come
# from a 0600 file (auth_headers), never from a command line.
test_fn() {
  local ev="$TMP/event.json" result q="${4:-}" hf="${5:-}"
  [[ -n "$q" ]] || q='{}'
  if [[ -z "$hf" ]]; then hf="$TMP/no-headers.json"; echo '{}' >"$hf"; fi
  jq -n --arg m "$1" --arg u "$2" --arg h "$3" --argjson q "$q" --slurpfile x "$hf" '{
    version: "1.0", context: {eventType: "viewer-request"}, viewer: {ip: "198.51.100.7"},
    request: {method: $m, uri: $u, querystring: $q, cookies: {},
      headers: ({host: {value: $h}} + ($x[0] | with_entries({key: (.key | ascii_downcase), value: {value: .value}})))}}' >"$ev"
  chmod 600 "$ev"
  result="$(as_test bash -c '
    etag="$(aws cloudfront describe-function --name "$1" --stage LIVE --query ETag --output text)" &&
    aws cloudfront test-function --name "$1" --if-match "$etag" --stage LIVE --event-object "fileb://$2" --output json' _ "$ROUTER_NAME" "$ev")" || result='{}'
  : >"$ev"
  TF_ERR="$(jq -r '.TestResult.FunctionErrorMessage // empty' <<<"$result")"
  TF_OUT="$(jq -c '.TestResult.FunctionOutput // "{}" | fromjson' <<<"$result" 2>/dev/null || echo '{}')"
  TF_COMPUTE="$(jq -r '.TestResult.ComputeUtilization // empty' <<<"$result")"
}
# headers_file NAME JSON-ON-STDIN: a 0600 file of request headers for test_fn; prints its path.
headers_file() { local f="$TMP/headers.$1.json"; cat >"$f"; chmod 600 "$f"; echo "$f"; }
# auth_headers TOKEN_VAR [EXTRA_JSON]: Authorization: Bearer <token> (and EXTRA) in a 0600 file.
auth_headers() { printf '%s' "${!1}" | jq -Rc --argjson e "${2:-null}" '{authorization: ("Bearer " + .)} + ($e // {})' | headers_file "auth.$1"; }
tf_status() { jq -r '.response.statusCode // "request"' <<<"$TF_OUT"; }
tf_body() { jq -r '.response.body.data // .response.body // empty' <<<"$TF_OUT"; }

# edge_tool ARGS...: test/integ/edge-tool.ts under the test role.
edge_tool() { as_test npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ/edge-tool.ts "$@"; }

# log_count GROUP REGION PATTERN SINCE_MS [ROLE]: events matching PATTERN since SINCE_MS.
log_count() {
  local runner=as_test
  [[ "${5:-}" == cp ]] && runner=in_cp
  local pattern=()
  [[ -z "$3" ]] || pattern=(--filter-pattern "$3")
  $runner aws logs filter-log-events --region "$2" --log-group-name "$1" --start-time "$4" "${pattern[@]}" \
    --query 'length(events)' --output text 2>/dev/null || echo error
}
now_ms() { echo $(( $(date +%s) * 1000 )); }
