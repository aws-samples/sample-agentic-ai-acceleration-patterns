#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, step 2: seed tenants, users, subscriptions and demo rows
# (design/agentic-runtime-isolation.stress-test.md §5 steps 1.2 and 1.3, §8.2, §8.3).
#
#   AWS_REGION=eu-central-1 [STRESS_SCALE=small] [STRESS_PREFIX=RuntimeIsolationStress] \
#     scripts/stress/seed.sh [--tenants N] [--dry-run]
#
# Reuse (§8.2): the manifest ~/.runtime-isolation-stress/<prefix>/manifest.json
# lists the tenants of earlier runs. Each one is checked (GET
# platform/tenants/<id>) and kept when it is still ACTIVE, dropped otherwise;
# only what is missing up to the tier's tenantsSeeded (or N) is created
# (CreateTenant with app/use and one admin). The first tenantsActive tenants
# are active: their vendor subscription (PutTenantSubscription) names every
# agent and `<target>/*` for every target of the tier, and they get the
# tier's usersPerActiveTenant users beyond the admin. Every tenant gets one
# demo-table row (BatchWriteItem, 25 a batch, unprocessed items retried).
#
# Every platform call (GetTenant, CreateTenant, CreateUser) and every vendor
# call runs at 8 a second, under tenant-identity's 10 rps platform throttle.
# The manifest holds tenant ids, names and user names, never a token or a
# password; nothing here issues a token. --dry-run prints the plan from the
# manifest and the tier without calling AWS. Conventions: scripts/CONVENTIONS.md.

# Functions run from the trap and from launch.
# shellcheck disable=SC2329

set -euo pipefail

DRY_RUN=0
TENANTS_OVERRIDE=""
while (( $# > 0 )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tenants) TENANTS_OVERRIDE="${2:-}"; shift ;;
    *) echo "usage: $0 [--tenants N] [--dry-run]" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "$TENANTS_OVERRIDE" || "$TENANTS_OVERRIDE" =~ ^[1-9][0-9]*$ ]] || { echo "--tenants needs a positive integer" >&2; exit 2; }

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region the stress stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws curl jq npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SAMPLE_DIR"
SCALE="${STRESS_SCALE:-small}"
[[ "$SCALE" =~ ^(small|medium|large)$ ]] || { echo "STRESS_SCALE must be small, medium or large (got '${SCALE}')" >&2; exit 1; }
PREFIX="${STRESS_PREFIX:-RuntimeIsolationStress}"
[[ "$PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 1; }
STATE_DIR="${HOME}/.runtime-isolation-stress/${PREFIX}"
OUTPUTS="${STATE_DIR}/outputs.json"
MANIFEST="${STATE_DIR}/manifest.json"
# Lines of tenants and users created but not yet in the manifest; merged on
# every exit and at the next start, so a run that dies loses no tenant.
PENDING="${STATE_DIR}/pending.jsonl"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

LIB_TMP="$(mktemp -d)"
# shellcheck source=../lib.sh
source "${SCRIPT_DIR}/../lib.sh"

RUN="$(date +%s)"
INTERVAL_MS=125   # 8 calls a second
MAX_JOBS=24       # calls in flight at once; the pace, not this, sets the rate
STATUSES="${LIB_TMP}/statuses"
: >"$STATUSES"

output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS" 2>/dev/null || true; }

# tier_json -> the tier of STRESS_SCALE from test/stress/tiers.ts (§8.2).
tier_json() {
  STRESS_SCALE="$SCALE" npx ts-node -P tsconfig.json --prefer-ts-exts \
    -e "console.log(JSON.stringify(require('./test/stress/tiers').tierOf(process.env.STRESS_SCALE)))" 2>"${LIB_TMP}/tier.err" \
    | tail -1
}
TIER="$(tier_json)" || true
jq -e 'type == "object" and has("tenantsSeeded")' <<<"$TIER" >/dev/null 2>&1 \
  || { tail -5 "${LIB_TMP}/tier.err" >&2; fail "could not read the ${SCALE} tier from test/stress/tiers.ts (tierOf)"; }
# agents and toolTargets may be counts or name lists; both normalise to names.
AGENTS_JSON="$(jq -c '.agents | if type == "array" then . else ["default"] + [range(1; .) | "a" + ("00" + tostring)[-3:]] end' <<<"$TIER")"
TARGETS_JSON="$(jq -c '.toolTargets | if type == "array" then map(if type == "object" then .name else . end) else [range(1; . + 1) | "t" + ("0" + tostring)[-2:]] end' <<<"$TIER")"
SEEDED="${TENANTS_OVERRIDE:-$(jq -r .tenantsSeeded <<<"$TIER")}"
ACTIVE="$(jq -r .tenantsActive <<<"$TIER")"
(( ACTIVE > SEEDED )) && ACTIVE="$SEEDED"
USERS_PER="$(jq -r .usersPerActiveTenant <<<"$TIER")"
SUBSCRIPTION="$(jq -nc --argjson a "$AGENTS_JSON" --argjson t "$TARGETS_JSON" '{agents: $a, tools: ($t | map(. + "/*"))}')"

[[ -s "$MANIFEST" ]] || jq -n --arg s "$SCALE" --arg p "$PREFIX" --arg c "$(date -u +%FT%TZ)" \
  '{scale: $s, prefix: $p, created: $c, tenants: []}' >"$MANIFEST"
chmod 600 "$MANIFEST"
touch "$PENDING"
chmod 600 "$PENDING"

# merge_pending: folds pending.jsonl into the manifest (new tenants appended,
# new users added to their tenant), then empties it.
merge_pending() {
  [[ -s "$PENDING" ]] || return 0
  jq -s --slurpfile m "$MANIFEST" '
    ($m[0]) as $man
    | (map(select(has("tenantId") and has("admin")))) as $new
    | (map(select(has("user")))) as $users
    | $man | .tenants = ((.tenants + ($new | map(select(.tenantId as $id | ($man.tenants | map(.tenantId) | index($id)) == null))))
      | map(.tenantId as $id | .users = ((.users // []) + ($users | map(select(.tenantId == $id) | .user)) | unique)))
  ' "$PENDING" >"${MANIFEST}.new"
  mv "${MANIFEST}.new" "$MANIFEST"
  chmod 600 "$MANIFEST"
  : >"$PENDING"
}

cleanup() {
  local code=$?
  set +e
  jobs -rp | xargs -r kill 2>/dev/null
  wait 2>/dev/null
  [[ "$DRY_RUN" == 1 ]] || merge_pending
  rm -rf "$LIB_TMP"
  exit "$code"
}
trap cleanup EXIT

# pace INTERVAL_MS: successive calls start at most one per INTERVAL_MS.
PACE_NEXT=0
pace() {
  local now
  now="$(date +%s%3N)"
  if (( now < PACE_NEXT )); then
    sleep "$(awk -v d="$((PACE_NEXT - now))" 'BEGIN { printf "%.3f", d / 1000 }')"
    now="$PACE_NEXT"
  fi
  PACE_NEXT=$((now + $1))
}
# launch FN ARGS...: runs FN in the background, paced, at most MAX_JOBS at once.
launch() {
  pace "$INTERVAL_MS"
  while (( $(jobs -rp | wc -l) >= MAX_JOBS )); do wait -n 2>/dev/null || true; done
  "$@" &
}
# job_init: per-job BODY and REQ (lib.sh's are shared and would be overwritten by parallel calls).
job_init() {
  JOB_TMP="$(mktemp -d -p "$LIB_TMP")"
  BODY="${JOB_TMP}/body"; REQ="${JOB_TMP}/request"
  : >"$BODY"; : >"$REQ"; chmod 600 "$BODY" "$REQ"
}
# retry RETRY_RE FN ARGS... -> the HTTP status of the last attempt; statuses
# matching RETRY_RE are retried with backoff, five attempts in all.
retry() {
  local re="$1" st attempt=1 delay=1
  shift
  while :; do
    st="$("$@")" || st=000
    if [[ ! "$st" =~ ^(${re})$ ]] || (( attempt >= 5 )); then break; fi
    sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
  done
  printf '%s' "$st"
}

merge_pending
KNOWN="$(jq '.tenants | length' "$MANIFEST")"

if [[ "$DRY_RUN" == 1 ]]; then
  to_create=$(( SEEDED > KNOWN ? SEEDED - KNOWN : 0 ))
  users_missing="$(jq --argjson a "$ACTIVE" --argjson u "$USERS_PER" \
    '([.tenants[:$a][] | ($u - (.users | length)) | select(. > 0)] | add // 0) + ([$a - (.tenants | length), 0] | max) * $u' "$MANIFEST")"
  calls=$(( KNOWN + to_create + ACTIVE + users_missing ))
  echo "dry run: scale=${SCALE} prefix=${PREFIX}"
  echo "  tier: seeded=${SEEDED} active=${ACTIVE} usersPerActiveTenant=${USERS_PER} agents=$(jq -r 'join(",")' <<<"$AGENTS_JSON") targets=$(jq -r 'join(",")' <<<"$TARGETS_JSON")"
  echo "  manifest: ${KNOWN} tenants listed (each checked with GetTenant, kept if ACTIVE)"
  echo "  create: up to ${to_create} tenants (more if listed ones are gone)"
  echo "  subscribe: ${ACTIVE} active tenants to $(jq -r '.agents | length' <<<"$SUBSCRIPTION") agents and $(jq -r '.tools | length' <<<"$SUBSCRIPTION") target wildcards"
  echo "  users: about ${users_missing} to create"
  echo "  demo rows: $(( KNOWN > SEEDED ? KNOWN : SEEDED )) in $(( ( (KNOWN > SEEDED ? KNOWN : SEEDED) + 24) / 25 )) batches"
  echo "  outputs: $( [[ -s "$OUTPUTS" ]] && echo "${OUTPUTS} present" || echo "missing, run deploy.sh first")"
  echo "  estimate: ${calls} paced calls at 8/s, about $(( calls / 8 + 1 ))s"
  exit 0
fi

[[ -s "$OUTPUTS" ]] || fail "no ${OUTPUTS}; run scripts/stress/deploy.sh first"
ENT_API="$(output EntitlementsApiUrl)"; [[ -n "$ENT_API" ]] || fail "output EntitlementsApiUrl missing from ${OUTPUTS}"
TABLE="$(output DemoTableName)"; [[ -n "$TABLE" ]] || fail "output DemoTableName missing from ${OUTPUTS}"
identity_init
echo "scale=${SCALE} prefix=${PREFIX} seeded=${SEEDED} active=${ACTIVE} users_per_active=${USERS_PER} started=$(date -u +%FT%TZ)"

# -- reuse: keep what still exists ------------------------------------------
job_check() { # TENANT_ID RESULT_FILE
  local st state
  job_init
  st="$(retry '429|5[0-9][0-9]|000' platform GET "platform/tenants/$1")"
  echo "GetTenant ${st}" >>"$STATUSES"
  state="$(jq -r '.tenant.status // empty' "$BODY" 2>/dev/null || true)"
  if [[ "$st" == 200 && "$state" == ACTIVE ]]; then echo "keep $1" >>"$2"
  elif [[ "$st" == 404 || "$st" == 200 ]]; then echo "drop $1" >>"$2"
  else echo "unknown $1" >>"$2"; fi
  rm -rf "$JOB_TMP"
}
CHECKED="${LIB_TMP}/checked"
: >"$CHECKED"
START=$SECONDS
while read -r id; do launch job_check "$id" "$CHECKED"; done < <(jq -r '.tenants[].tenantId' "$MANIFEST")
wait
UNKNOWN="$(grep -c '^unknown ' "$CHECKED" || true)"
(( UNKNOWN == 0 )) || fail "${UNKNOWN} manifest tenants could not be checked (GetTenant not 200/404 after retry); the manifest is unchanged"
jq -R -s 'split("\n") | map(select(startswith("drop ")) | .[5:])' "$CHECKED" >"${LIB_TMP}/dropped.json"
DROPPED="$(jq length "${LIB_TMP}/dropped.json")"
jq --slurpfile d "${LIB_TMP}/dropped.json" '.tenants |= map(select(.tenantId as $id | ($d[0] | index($id)) == null))' "$MANIFEST" >"${MANIFEST}.new"
mv "${MANIFEST}.new" "$MANIFEST"; chmod 600 "$MANIFEST"
REUSED="$(jq '.tenants | length' "$MANIFEST")"
echo "reuse: ${REUSED} kept, ${DROPPED} dropped (gone from tenant-identity) in $((SECONDS - START))s"

# -- create what is missing -------------------------------------------------
job_create_tenant() { # INDEX
  local name st
  job_init
  name="rtiso-stress-${RUN}-$1"
  # 5xx and curl failures are retried too: CreateTenant answered 500 in
  # bursts at 8 rps on 2026-11-09 (139 of 180 calls) and succeeded on rerun.
  st="$(retry '429|5[0-9][0-9]|000' platform POST platform/tenants \
    "$(jq -nc --arg n "$name" --arg e "success+${name}-admin@simulator.amazonses.com" '{name: $n, adminEmail: $e, scopes: ["app/use"]}')")"
  echo "CreateTenant ${st}" >>"$STATUSES"
  # The first non-201 answer's body, once, for the diagnosis (an error body carries no credential).
  if [[ "$st" != 201 ]] && ( set -o noclobber; : >"${LIB_TMP}/first-create-error" ) 2>/dev/null; then
    echo "CreateTenant ${st}: $(head -c 300 "$BODY" | tr '\n' ' ')" >&2
  fi
  [[ "$st" == 201 ]] && jq -c --arg n "$name" '{tenantId: .tenant.tenantId, name: $n, admin: .admin.user.username, users: [], active: false}' "$BODY" >>"$PENDING"
  : >"$BODY"   # the answer carries the admin's temporary password
  rm -rf "$JOB_TMP"
}
TO_CREATE=$(( SEEDED > REUSED ? SEEDED - REUSED : 0 ))
# Headroom check (F-11): a user pool holds 10,000 groups and tenant-identity
# takes two per tenant. Counting the groups costs one ListGroups page per 60,
# so it runs only when something is to be created.
if (( TO_CREATE > 0 )); then
  POOL_ID="$(aws ssm get-parameter --name "${IDENTITY_PREFIX}/userPoolId" --query Parameter.Value --output text)"
  GROUPS=0; TOKEN=""
  while :; do
    if [[ -n "$TOKEN" ]]; then page="$(aws cognito-idp list-groups --user-pool-id "$POOL_ID" --limit 60 --next-token "$TOKEN" --output json)"
    else page="$(aws cognito-idp list-groups --user-pool-id "$POOL_ID" --limit 60 --output json)"; fi
    GROUPS=$(( GROUPS + $(jq '.Groups | length' <<<"$page") ))
    TOKEN="$(jq -r '.NextToken // empty' <<<"$page")"
    [[ -n "$TOKEN" ]] || break
  done
  ROOM=$(( (10000 - GROUPS) / 2 ))
  echo "pool groups: ${GROUPS} of 10,000; room for ${ROOM} more tenants"
  (( TO_CREATE <= ROOM )) || fail "the identity pool has room for ${ROOM} more tenants, ${TO_CREATE} wanted: lower the tier's tenantsSeeded or --tenants, or free orphan groups (two per tenant, t-<id> and admin-<id>) that no tenant row owns"
fi
START=$SECONDS
# CreateTenant writes a Cognito group and a user; above about 4 a second
# Cognito answers TooManyRequestsException, which tenant-identity returns as
# 500 (2026-11-09, medium seed: 139 of 180 at 8 rps). Half pace here.
INTERVAL_MS=250
# The manifest is folded every 50 launches, so a seed killed mid-run (a shell
# timeout, 2026-11-10) loses at most 50 answered tenants: an answered tenant
# the manifest never learns of is two orphan Cognito groups the pool counts
# against its 10,000 (F-11).
for ((i = 1; i <= TO_CREATE; i++)); do
  launch job_create_tenant "$i"
  (( i % 50 == 0 )) && { wait; merge_pending; }
done
INTERVAL_MS=125
wait
merge_pending
CREATED=$(( $(jq '.tenants | length' "$MANIFEST") - REUSED ))
echo "create: ${CREATED} of ${TO_CREATE} tenants created in $((SECONDS - START))s"
(( CREATED == TO_CREATE )) || echo "WARN: $((TO_CREATE - CREATED)) CreateTenant calls failed after retry; statuses: $(sort "$STATUSES" | uniq -c | awk '{printf "%s=%s ", $2 "_" $3, $1}')" >&2

# -- active flags, subscriptions --------------------------------------------
jq --argjson a "$ACTIVE" --arg s "$SCALE" --arg p "$PREFIX" \
  '.scale = $s | .prefix = $p | .tenants |= (to_entries | map(.value + {active: (.key < $a)}))' "$MANIFEST" >"${MANIFEST}.new"
mv "${MANIFEST}.new" "$MANIFEST"; chmod 600 "$MANIFEST"
job_subscribe() { # TENANT_ID
  local st
  job_init
  st="$(retry '429|5[0-9][0-9]|000' vendor PUT "tenants/$1" "$SUBSCRIPTION")"
  echo "PutTenantSubscription ${st}" >>"$STATUSES"
  rm -rf "$JOB_TMP"
}
START=$SECONDS
while read -r id; do launch job_subscribe "$id"; done < <(jq -r '.tenants[] | select(.active) | .tenantId' "$MANIFEST")
wait
echo "subscribe: $(jq '[.tenants[] | select(.active)] | length' "$MANIFEST") active tenants in $((SECONDS - START))s"

# -- users beyond the admin, for the active tenants -------------------------
job_create_user() { # TENANT_ID LABEL
  local st
  job_init
  st="$(retry '429' platform POST "platform/tenants/$1/users" "$(jq -nc --arg e "success+${2}@simulator.amazonses.com" '{email: $e}')")"
  echo "CreateUser ${st}" >>"$STATUSES"
  [[ "$st" == 201 ]] && jq -c --arg t "$1" '{tenantId: $t, user: .user.username}' "$BODY" >>"$PENDING"
  : >"$BODY"
  rm -rf "$JOB_TMP"
}
START=$SECONDS
USERS_WANTED=0
while IFS=$'\t' read -r idx id have; do
  for ((n = have + 1; n <= USERS_PER; n++)); do
    USERS_WANTED=$((USERS_WANTED + 1))
    launch job_create_user "$id" "rtiso-stress-${RUN}-u${idx}-${n}"
  done
done < <(jq -r '.tenants | to_entries[] | select(.value.active) | [.key, .value.tenantId, (.value.users | length)] | @tsv' "$MANIFEST")
wait
merge_pending
USERS_CREATED="$(grep -c '^CreateUser 201$' "$STATUSES" || true)"
echo "users: ${USERS_CREATED} of ${USERS_WANTED} created in $((SECONDS - START))s"

# -- demo-table rows (BatchWriteItem, 25 a batch) ---------------------------
START=$SECONDS
BATCHES="${LIB_TMP}/batches.jsonl"
jq -c --arg t "$TABLE" '.tenants | [range(0; length; 25) as $i | .[$i:$i + 25]] | .[]
  | {($t): map({PutRequest: {Item: {PK: {S: ("TENANT#" + .tenantId)}, label: {S: .name},
      crmAccount: {M: {accountId: {S: ("acc-" + .name)}, name: {S: ("Account " + .name)}}}}}})}' "$MANIFEST" >"$BATCHES"
ROWS=0
UNPROCESSED=0
batch="${LIB_TMP}/batch.json"
while read -r items; do
  printf '%s' "$items" >"$batch"
  ROWS=$((ROWS + $(jq --arg t "$TABLE" '.[$t] | length' "$batch")))
  delay=1
  for attempt in 1 2 3 4 5 6; do
    aws dynamodb batch-write-item --request-items "file://${batch}" --query UnprocessedItems --output json >"${batch}.left" \
      || fail "BatchWriteItem on the demo table"
    # No unprocessed items: the CLI prints nothing (null) or {} for the query.
    if [[ ! -s "${batch}.left" ]] || jq -e 'length == 0' "${batch}.left" >/dev/null 2>&1; then : >"${batch}.left"; break; fi
    mv "${batch}.left" "$batch"
    (( attempt < 6 )) && { sleep "$delay"; delay=$((delay * 2)); }
  done
  [[ -s "${batch}.left" ]] && UNPROCESSED=$((UNPROCESSED + $(jq --arg t "$TABLE" '.[$t] | length' "${batch}.left")))
  : >"${batch}.left"
done <"$BATCHES"
echo "demo rows: ${ROWS} written, ${UNPROCESSED} unprocessed after retry, in $((SECONDS - START))s"

echo "== summary"
echo "tenants reused=${REUSED} dropped=${DROPPED} created=${CREATED} total=$(jq '.tenants | length' "$MANIFEST") active=$(jq '[.tenants[] | select(.active)] | length' "$MANIFEST")"
echo "users created=${USERS_CREATED} rows=${ROWS} unprocessed=${UNPROCESSED} wall_seconds=${SECONDS}"
echo "status histogram: $(sort "$STATUSES" | uniq -c | awk '{printf "%s:%s=%s ", $2, $3, $1}')"
echo "manifest: ${MANIFEST}"
FAILED_CALLS="$(awk '$1 == "CreateTenant" && $2 != 201 || $1 == "CreateUser" && $2 != 201 || $1 == "PutTenantSubscription" && $2 !~ /^20[04]$/' "$STATUSES" | wc -l)"
(( FAILED_CALLS == 0 && UNPROCESSED == 0 )) || fail "${FAILED_CALLS} calls failed after retry, ${UNPROCESSED} rows unprocessed; rerun seed.sh to fill the gap"
