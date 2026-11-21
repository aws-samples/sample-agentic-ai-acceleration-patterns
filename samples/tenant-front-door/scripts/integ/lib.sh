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
yes_no() { if "$@" >/dev/null; then echo yes; else echo no; fi; }
elapsed() { echo $(( $(date +%s) - $1 )); }
# die MESSAGE: ends the run. During the teardown (IN_TEARDOWN=1) it only
# returns 1, so a reader the teardown shares with the deploy phases fails
# its own part and the parts after it still run. Every caller that can be
# reached from the teardown writes `|| { die ...; return 1; }`.
IN_TEARDOWN=0
die() { echo "integ: $*" >&2; [[ "$IN_TEARDOWN" == 1 ]] && return 1; exit 1; }
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
# teardown reads it after an interruption. Only the names below are written
# or read, so a hand-edited file cannot set PATH, IFS or another shell
# variable.
STATE_NAMES='^(CELL_[AB]|CP_SETUP_REMOVED|DEPLOY_PHASE|FIXTURE_WRITTEN|HOOKS_REGISTERED|HOOK_PARAMETER_BROKEN|HOOK_POLICY_ATTACHED|MT_API|MT_TENANT|MT_USER|PLAIN_CELL|PROBE_HOOK|TENANT_[A-Z]|TI_USER_[A-Z])$'
state_set() { # NAME VALUE
  [[ "$1" =~ $STATE_NAMES && "$2" =~ ^[A-Za-z0-9._:/@+=-]*$ ]] || { die "state value for $1 has an unknown name or unexpected characters"; return 1; }
  printf -v "$1" '%s' "$2"
  grep -v "^$1=" "$RUN_DIR/state.env" >"$RUN_DIR/state.env.new" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >>"$RUN_DIR/state.env.new"
  mv "$RUN_DIR/state.env.new" "$RUN_DIR/state.env"
}
state_load() { [[ -f "$RUN_DIR/state.env" ]] || return 0; while IFS='=' read -r k v; do if [[ "$k" =~ $STATE_NAMES ]]; then printf -v "$k" '%s' "$v"; fi; done <"$RUN_DIR/state.env"; }

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
    --output "$RUN_DIR/cdk.out.${label}" --context integ="$(jq -c . "$RUN_DIR/context.json")" \
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
  # The CDK CLI sets CDK_DEFAULT_ACCOUNT to the credentials' account for the app it starts,
  # so the target account is set inside the app command (the control plane's cdk.json app).
  ( cd "$CONTROL_PLANE_DIR" && npx cdk "$@" --output "$RUN_DIR/cdk.out.${label}" \
      --app "env CDK_DEFAULT_ACCOUNT=$account CDK_DEFAULT_REGION=$REGION npx ts-node -P tsconfig.json --prefer-ts-exts src/main.ts" \
  ) >"$RUN_DIR/logs/${label}.log" 2>&1
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
  creds="$(aws configure export-credentials --format process)" || return 1
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
# http_status CURL_ARGS...: runs curl (its -w writes the status) and prints
# the status once; 000 when curl fails, which -w alone may also print.
http_status() { local st; st="$(curl "$@")" || st=000; echo "$st"; }
# signed METHOD URL [JSON]: SigV4 with AK/SK/ST for SIG_REGION (default REGION) -> status; body in $BODY.
signed() {
  local args=(-s -o "$BODY" -w '%{http_code}' --max-time 30 -X "$1" --aws-sigv4 "aws:amz:${SIG_REGION:-$REGION}:execute-api" --config -) config
  config="user = \"${AK}:${SK}\""
  [[ -n "$ST" ]] && config+=$'\n'"header = \"x-amz-security-token: ${ST}\""
  if [[ -n "${3:-}" ]]; then printf '%s' "$3" >"$REQ"; args+=(-H 'Content-Type: application/json' --data-binary "@$REQ"); fi
  : >"$BODY"
  http_status "${args[@]}" "$2" <<<"$config"
}
# as ROLE_ARN METHOD PATH [JSON]: one registrar call as ROLE_ARN. A 503 whose
# body says the control plane cannot be read is retried up to three times,
# 5 s apart. The registrar already retries each control-plane read once
# inside a 10 s budget (spec §3.4 step 2), so a 503 that reaches here is two
# failed reads, as after a quiet period. The harness retry stays as a second
# line. Each retry is noted on stderr and counted in $TMP/registrar-retries
# for the run summary, so a run records how often it happened. as runs in
# $(...), hence the file.
as() {
  local st i
  : >"$BODY"
  assume "$1" || { echo 000; return; }
  for i in 1 2 3 4; do
    st="$(signed "$2" "${REGISTRAR}$3" "${4:-}")"
    [[ "$st" == 503 ]] && grep -q 'control plane cannot be read' "$BODY" 2>/dev/null && (( i < 4 )) || break
    note "registrar 503 control plane unreadable on $2 $3, attempt $i of 4; retrying in 5 s" >&2
    printf '%s %s\n' "$2" "$3" >>"$TMP/registrar-retries"
    sleep 5
  done
  echo "$st"
}
# registrar_retries: how many times as() retried in this run.
registrar_retries() { [[ -f "$TMP/registrar-retries" ]] && wc -l <"$TMP/registrar-retries" | tr -d ' ' || echo 0; }

# edge METHOD HOST PATH [TOKEN_VAR] [curl args...] -> status; headers in $HEAD, body in $BODY.
edge() {
  local method="$1" host="$2" path="$3" tv="${4:-}" config=""
  shift 3; shift || true
  # A run tenant's token past its refresh age is issued again (token_for);
  # the new one is in its token file, so later calls reuse it. When
  # IssueToken fails, edge answers issue-token-failed and returns 0, so the
  # caller's check fails and a `st="$(edge ...)"` under errexit goes on.
  if [[ "$tv" =~ ^([ABC])_TOKEN$ ]]; then
    { token_for "${BASH_REMATCH[1],,}" "$tv" && [[ -n "${!tv}" ]]; } || { : >"$BODY"; : >"$HEAD"; echo issue-token-failed; return 0; }
  fi
  [[ -n "$tv" ]] && config="header = \"Authorization: Bearer ${!tv}\""
  : >"$BODY"; : >"$HEAD"
  http_status -s -D "$HEAD" -o "$BODY" -w '%{http_code}' --max-time 30 -X "$method" "$@" --config - "https://${host}${path}" <<<"$config"
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
  CP_TOKEN=""; CP_TOKEN_AT=0; : >"$TMP/cp-token"
  aws cognito-idp admin-set-user-password --region "$REGION" --cli-input-json "file://$TMP/password.json" >/dev/null \
    || { : >"$TMP/password.json"; OPERATOR_PASSWORD=""; return 1; }
  : >"$TMP/password.json"
}
api_token() {
  (( $(date +%s) - CP_TOKEN_AT < 2400 )) && [[ -n "$CP_TOKEN" ]] && return 0
  # api runs inside $(...), so a token signed in there is kept in a 0600
  # file (time, token) for the calls after it, as token_for does.
  if [[ -s "$TMP/cp-token" ]]; then
    { read -r CP_TOKEN_AT; read -r CP_TOKEN; } <"$TMP/cp-token"
    (( $(date +%s) - CP_TOKEN_AT < 2400 )) && [[ -n "$CP_TOKEN" ]] && return 0
  fi
  # The password reaches the CLI in a 0600 input file, never on its command line.
  printf '%s' "$OPERATOR_PASSWORD" | jq -Rc --arg p "$VENDOR_POOL" --arg c "$VENDOR_OPERATOR_CLIENT" \
    '{UserPoolId: $p, ClientId: $c, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: {USERNAME: "integ-operator", PASSWORD: .}}' >"$TMP/auth.json"
  chmod 600 "$TMP/auth.json"
  CP_TOKEN="$(aws cognito-idp admin-initiate-auth --region "$REGION" --cli-input-json "file://$TMP/auth.json" \
    --query AuthenticationResult.IdToken --output text)" || { : >"$TMP/auth.json"; CP_TOKEN=""; die "the operator could not sign in to the vendor IdP"; return 1; }
  : >"$TMP/auth.json"
  CP_TOKEN_AT=$(date +%s)
  ( umask 077; printf '%s\n%s\n' "$CP_TOKEN_AT" "$CP_TOKEN" >"$TMP/cp-token" )
}
# api METHOD PATH [JSON] -> status; body in $BODY. 000 when the operator cannot sign in.
# $BODY is emptied first: inside $(...) a failed sign-in ends the subshell
# (die), and a failed check must not print the body of an earlier call.
api() {
  : >"$BODY"
  api_token || { echo 000; return 1; }
  local args=(-s -o "$BODY" -w '%{http_code}' --max-time 30 -X "$1" --config -)
  if [[ -n "${3:-}" ]]; then printf '%s' "$3" >"$REQ"; args+=(-H 'Content-Type: application/json' --data-binary "@$REQ"); fi
  http_status "${args[@]}" "${CP_API}${2#/}" <<<"header = \"Authorization: Bearer ${CP_TOKEN}\""
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
# api_gone PATH [timeout s]: polls until the Get answers 404. Gives up early
# after three answers in a row that say the driver cannot see the record
# (000, 401, 403), so a lost sign-in fails a part instead of waiting it out.
api_gone() {
  local start max="${2:-1500}" st blind=0
  start=$(date +%s)
  while :; do
    st="$(api GET "$1")"
    [[ "$st" == 404 ]] && return 0
    if [[ "$st" =~ ^(000|401|403)$ ]]; then blind=$((blind + 1)); else blind=0; fi
    (( blind >= 3 )) && { note "GET $1: HTTP ${st} three times in a row"; return 1; }
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
# ti_tenant API TENANT_ID NAME [SCOPES_JSON] -> sets TI_ADMIN (the admin user's name).
# SCOPES_JSON defaults to ["app/use"]; a scope must be in that deployment's
# catalogue, and the multi-tenant deployment's catalogue is empty.
ti_tenant() {
  local st
  own_creds
  st="$(SIG_REGION="$IDENTITY_REGION" signed POST "${1}platform/tenants" "$(jq -nc --arg id "$2" --arg n "$3" --arg e "success+$3@simulator.amazonses.com" \
    --argjson s "${4:-[\"app/use\"]}" '{tenantId: $id, name: $n, adminEmail: $e, scopes: $s}')")"
  [[ "$st" == 201 ]] || die "tenant-identity CreateTenant $3: HTTP $st $(jq -r '.message // empty' "$BODY" 2>/dev/null | head -c 160)"
  TI_ADMIN="$(jq -r .admin.user.username "$BODY")"
  : >"$BODY"
}
# ti_token API TENANT_ID USER VAR: a fresh access token in VAR. The shared
# pool's app client issues access tokens valid for five minutes. Returns 1
# with the cause in TI_TOKEN_ERR when IssueToken fails.
ti_token() {
  local st pw tok
  TI_TOKEN_ERR=""
  own_creds || { TI_TOKEN_ERR="no credentials to sign with"; return 1; }
  pw="Tfd-Integ-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n')!"
  st="$(SIG_REGION="$IDENTITY_REGION" signed POST "${1}platform/tenants/$2/users/$3/token" "$(printf '%s' "$pw" | jq -Rs '{password: .}')")"
  [[ "$st" == 200 ]] || { TI_TOKEN_ERR="HTTP $st"; return 1; }
  tok="$(jq -r '.accessToken // empty' "$BODY")"; : >"$BODY"
  [[ -n "$tok" ]] || { TI_TOKEN_ERR="HTTP 200 with no accessToken"; return 1; }
  printf -v "$4" '%s' "$tok"
}
# ti_delete API TENANT_ID: 0 deleted (204), 3 already gone (404), 1 on any other answer.
# DeleteTenant is idempotent, so a rerun of the teardown sends it again.
ti_delete() {
  local st
  [[ -n "$1" ]] || { note "tenant-identity DeleteTenant ${2}: no API URL"; return 1; }
  own_creds || { note "tenant-identity DeleteTenant ${2}: no credentials to sign with"; return 1; }
  st="$(SIG_REGION="$IDENTITY_REGION" signed DELETE "${1}platform/tenants/$2")"
  case "$st" in
    200 | 202 | 204) return 0 ;;
    404) return 3 ;;
  esac
  note "tenant-identity DeleteTenant ${2}: HTTP ${st}"
  return 1
}
# ti_status API TENANT_ID: GetTenant, read only -> "gone" (404), the tenant's status (200), or "error:<HTTP status>".
ti_status() {
  local st
  [[ -n "$1" ]] || { echo "error:no-api-url"; return; }
  own_creds || { echo "error:no-credentials"; return; }
  st="$(SIG_REGION="$IDENTITY_REGION" signed GET "${1}platform/tenants/$2")"
  case "$st" in
    404) echo gone ;;
    200) jq -r '.tenant.status // "unknown"' "$BODY" 2>/dev/null || echo unknown ;;
    *) echo "error:${st}" ;;
  esac
}
# token_for T VAR: the token of one of the run's tenants (a, b, c) in VAR,
# issued again once it is three minutes old, so it outlives the request
# that sends it (the pool's tokens last five). The token and its issue time
# live in a 0600 file per tenant, $TMP/token-<t>, so a refresh made inside
# $(edge ...) holds for every call after it. When IssueToken fails, a
# token failure fails one check and the run goes on. In the step's own
# shell token_for counts a FAIL, sets VAR empty (so checks that use it fail
# and `set -u` holds) and returns 0. Inside a subshell it notes the cause on
# stderr and returns 1; edge then answers issue-token-failed and returns 0,
# so the caller's check fails. The next call that needs the token tries
# IssueToken again.
token_for() {
  local t="$1" f="$TMP/token-$1" id_var="TENANT_${1^^}" user_var="TI_USER_${1^^}" at=0 tok="" fresh=""
  [[ -s "$f" ]] && { read -r at && read -r tok; } <"$f"
  [[ "$at" =~ ^[0-9]+$ ]] || at=0
  if [[ -z "$tok" ]] || (( $(date +%s) - at > 180 )); then
    if ! ti_token "$IDENTITY_API" "${!id_var}" "${!user_var}" fresh; then
      if (( BASH_SUBSHELL == 0 )); then
        FAILS=$((FAILS + 1)); echo "  FAIL tenant ${t}'s token: tenant-identity IssueToken failed (${TI_TOKEN_ERR})"
        printf -v "$2" '%s' ""
        return 0
      fi
      note "tenant ${t}'s token: tenant-identity IssueToken failed (${TI_TOKEN_ERR}); this call's check fails" >&2
      return 1
    fi
    tok="$fresh"
    local part="$f.$BASHPID"
    ( umask 077; printf '%s\n%s\n' "$(date +%s)" "$tok" >"$part" ) && mv -f "$part" "$f"
  fi
  printf -v "$2" '%s' "$tok"
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

# log_count GROUP REGION PATTERN SINCE_MS [ROLE] [UNTIL_MS]: events matching PATTERN between SINCE_MS and UNTIL_MS (default now).
log_count() {
  local runner=as_test
  [[ "${5:-}" == cp ]] && runner=in_cp
  local pattern=() until=()
  [[ -z "$3" ]] || pattern=(--filter-pattern "$3")
  [[ -z "${6:-}" ]] || until=(--end-time "$6")
  # filter-log-events pages its answer, and --query runs once per page, so
  # the CLI prints one count per page: add them.
  local counts
  counts="$($runner aws logs filter-log-events --region "$2" --log-group-name "$1" --start-time "$4" "${until[@]}" "${pattern[@]}" \
    --query 'length(events)' --output text 2>/dev/null)" || { echo error; return; }
  awk '{ for (i = 1; i <= NF; i++) n += $i } END { print n + 0 }' <<<"$counts"
}
now_ms() { date +%s%3N; }
