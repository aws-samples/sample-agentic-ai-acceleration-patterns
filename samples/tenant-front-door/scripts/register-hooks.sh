#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Registers the front door's two global hooks on the control plane with
# PutHook (spec §5.2, ADR-0017; control-plane R-39), or removes them.
#
#   scripts/register-hooks.sh            # put front-door-pre, then front-door-post, check with ListHooks
#   scripts/register-hooks.sh --delete   # DeleteHook front-door-post, then front-door-pre, check with ListHooks
#
# Both hooks run hooks/route-hook.sh from this repository, pinned to one
# full commit SHA, and serve every front door on the control plane. A hook
# already registered with the same definition is left as it is, so a rerun
# changes nothing and does not raise the hook's revision. A changed
# definition reaches only operations the control plane accepts afterwards.
#
# Inputs (environment):
#   CONTROL_PLANE_URL      the control plane API's base URL, https
#   CONTROL_PLANE_TOKEN    an operator access token for it (never printed)
#   HOOK_SOURCE_VERSION    the commit to pin, 40 lower-case hex characters;
#                          not needed with --delete
#   HOOK_SOURCE_LOCATION   default the aws-samples repository's clone URL
#   HOOK_SOURCE_TYPE       default GITHUB
#   HOOK_TIMEOUT_MINUTES   default 10 (control-plane range 5 to 30)
#
# Run --delete before the last front door on a control plane is removed
# (spec §6.2): once no RouteHookAccess policy is attached, the hook cannot
# read its parameter and fails every create and update on the control plane.

set -euo pipefail
umask 077

fail() { echo "register-hooks: $*" >&2; exit 1; }

MODE=put
case "${1:-}" in
  '') ;;
  --delete) MODE=delete ;;
  *) fail "usage: $0 [--delete]" ;;
esac
[[ $# -le 1 ]] || fail "usage: $0 [--delete]"

: "${CONTROL_PLANE_URL:?set CONTROL_PLANE_URL}"
: "${CONTROL_PLANE_TOKEN:?set CONTROL_PLANE_TOKEN}"
[[ "$CONTROL_PLANE_URL" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)*/?$ ]] || fail "CONTROL_PLANE_URL is not an https URL"
API="${CONTROL_PLANE_URL%/}"
# Token characters only, so the value cannot break out of the curl config line.
[[ "$CONTROL_PLANE_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || fail "CONTROL_PLANE_TOKEN is not a bearer token"

HOOK_POST=front-door-post
HOOK_PRE=front-door-pre
SCRIPT=samples/tenant-front-door/hooks/route-hook.sh

TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT
BODY="$TMP/body"
REQ="$TMP/request"

# api METHOD PATH [JSON] -> STATUS; the answer in $BODY. The token reaches
# curl on stdin (--config -), never on its command line.
api() {
  local args=(-sS -o "$BODY" -w '%{http_code}' --connect-timeout 10 --max-time 30 -X "$1" --config -)
  if [[ -n "${3:-}" ]]; then
    printf '%s' "$3" >"$REQ"
    args+=(-H 'Content-Type: application/json' --data-binary "@$REQ")
  fi
  : >"$BODY"
  STATUS="$(curl "${args[@]}" "${API}$2" <<<"header = \"Authorization: Bearer ${CONTROL_PLANE_TOKEN}\"" 2>"$TMP/curl.err")" || STATUS=000
}
answer() { head -c 512 "$BODY" | tr -cd '[:print:]'; }

# list_hooks -> the ids, phases and events of every registered hook, one JSON
# array, across ListHooks pages.
list_hooks() {
  local next='' page all='[]' query
  while :; do
    query=''
    [[ -z "$next" ]] || query="?nextToken=$(jq -rn --arg t "$next" '$t | @uri')"
    api GET "/hooks${query}"
    [[ "$STATUS" == 200 ]] || fail "ListHooks: HTTP ${STATUS}: $(answer)"
    page="$(jq -c '[.hooks[] | {hookId, phase, events: (.events | sort)}]' "$BODY")" || fail "ListHooks: the answer is not a hook list"
    all="$(jq -nc --argjson a "$all" --argjson b "$page" '$a + $b')"
    next="$(jq -r '.nextToken // empty' "$BODY")"
    [[ -n "$next" ]] || break
  done
  printf '%s' "$all"
}

if [[ "$MODE" == delete ]]; then
  for id in "$HOOK_POST" "$HOOK_PRE"; do
    api DELETE "/hooks/${id}"
    case "$STATUS" in
      200) echo "register-hooks: deleted ${id}" ;;
      404) echo "register-hooks: ${id} was not registered" ;;
      *) fail "DeleteHook ${id}: HTTP ${STATUS}: $(answer)" ;;
    esac
  done
  left="$(list_hooks | jq -c --arg a "$HOOK_POST" --arg b "$HOOK_PRE" '[.[] | select(.hookId == $a or .hookId == $b) | .hookId]')"
  [[ "$left" == '[]' ]] || fail "ListHooks still names ${left}"
  echo "register-hooks: ListHooks names neither ${HOOK_POST} nor ${HOOK_PRE}"
  exit 0
fi

: "${HOOK_SOURCE_VERSION:?set HOOK_SOURCE_VERSION to the full commit SHA to pin}"
[[ "$HOOK_SOURCE_VERSION" =~ ^[0-9a-f]{40}$ ]] || fail "HOOK_SOURCE_VERSION must be a full commit SHA (40 lower-case hex characters)"
LOCATION="${HOOK_SOURCE_LOCATION:-https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns.git}"
TYPE="${HOOK_SOURCE_TYPE:-GITHUB}"
TIMEOUT="${HOOK_TIMEOUT_MINUTES:-10}"
# Inside the control plane's hook charset (control-plane R-39): no `@`, so
# no userinfo.
[[ "$LOCATION" =~ ^https://[A-Za-z0-9._~:/%-]+$ && ${#LOCATION} -le 1024 ]] \
  || fail "HOOK_SOURCE_LOCATION must be an https clone URL without userinfo, query or fragment"
[[ "$TYPE" =~ ^(CODECOMMIT|GITHUB|GITHUB_ENTERPRISE|GITLAB|GITLAB_SELF_MANAGED|BITBUCKET)$ ]] \
  || fail "HOOK_SOURCE_TYPE must be a git source type"
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && ((TIMEOUT >= 5 && TIMEOUT <= 30)) || fail "HOOK_TIMEOUT_MINUTES must be 5 to 30"

# definition PHASE EVENT... -> the PutHook body, events sorted.
definition() {
  local phase="$1"
  shift
  jq -nc --arg phase "$phase" --arg type "$TYPE" --arg location "$LOCATION" --arg version "$HOOK_SOURCE_VERSION" \
    --arg script "$SCRIPT" --argjson timeout "$TIMEOUT" '$ARGS.positional as $events | {
      events: ($events | sort), phase: $phase,
      source: {type: $type, location: $location, sourceVersion: $version},
      script: $script, timeoutMinutes: $timeout}' --args "$@"
}

put_hook() { # ID PHASE EVENT...
  local id="$1" want
  shift
  want="$(definition "$@")"
  api GET "/hooks/${id}"
  case "$STATUS" in
    200)
      if jq -e --argjson want "$want" '.hook | {events: (.events | sort), phase, source, script, timeoutMinutes} == $want' "$BODY" >/dev/null; then
        echo "register-hooks: ${id} is registered with this definition, unchanged"
        return 0
      fi
      ;;
    404) ;;
    *) fail "GetHook ${id}: HTTP ${STATUS}: $(answer)" ;;
  esac
  api PUT "/hooks/${id}" "$want"
  [[ "$STATUS" == 200 ]] || fail "PutHook ${id}: HTTP ${STATUS}: $(answer)"
  echo "register-hooks: put ${id}, revision $(jq -r '.hook.revision' "$BODY")"
}

# PRE first: a run that stops after it leaves a hook that only deletes
# routes, which answers 200 when a route is absent. POST first would leave
# a control plane that writes routes and never removes them. --delete
# removes them in the opposite order for the same reason.
put_hook "$HOOK_PRE" PRE CELL_DELETE DEPLOYMENT_DELETE
put_hook "$HOOK_POST" POST CELL_CREATE CELL_UPDATE DEPLOYMENT_CREATE DEPLOYMENT_UPDATE

hooks="$(list_hooks)"
jq -e --arg a "$HOOK_POST" --arg b "$HOOK_PRE" '
  any(.[]; .hookId == $a and .phase == "POST" and .events == ["CELL_CREATE", "CELL_UPDATE", "DEPLOYMENT_CREATE", "DEPLOYMENT_UPDATE"])
  and any(.[]; .hookId == $b and .phase == "PRE" and .events == ["CELL_DELETE", "DEPLOYMENT_DELETE"])' >/dev/null <<<"$hooks" \
  || fail "ListHooks does not name both hooks with their phases and events"
echo "register-hooks: ListHooks names ${HOOK_POST} (POST) and ${HOOK_PRE} (PRE)"
