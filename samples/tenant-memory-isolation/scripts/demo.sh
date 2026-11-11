#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo against a deployed demo stack (bundled issuer).
#
#   AWS_REGION=us-east-1 scripts/demo.sh
#
# Creates three synthetic users (two in tenant-a, one in tenant-ab), walks
# the flow in the README's step table, checks each response, and deletes the
# users on exit, also on failure. Prints step names and HTTP statuses only;
# never tokens, passwords, or memory content (scripts/CONVENTIONS.md).

set -euo pipefail
: "${AWS_REGION:?Set AWS_REGION to the Region of the deployed stack}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws curl jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

PUBLISHED="$(aws ssm get-parameter --name /application-plane/shared/memory/gateway --query Parameter.Value --output text)"
POOL="$(jq -r '.demoIssuer.userPoolId // empty' <<<"$PUBLISHED")"
CLIENT="$(jq -r '.demoIssuer.appClientId // empty' <<<"$PUBLISHED")"
[[ -n "$POOL" && -n "$CLIENT" ]] || { echo "The demo needs the bundled demo issuer" >&2; exit 1; }
ORIGIN="$(jq -r '.gatewayUrl' <<<"$PUBLISHED" | sed -E 's#^(https://[^/]+).*#\1#')"
BASE="${ORIGIN}/$(jq -r '.targetName' <<<"$PUBLISHED")/memories/$(jq -r '.memoryId' <<<"$PUBLISHED")"
RUN="$(openssl rand -hex 4)"
MARKER="Demo${RUN}"
FAILED=0
declare -A TOKEN SUB

cleanup() {
  for user in alice bob carol; do
    aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "${user}-${RUN}" >/dev/null 2>&1 || true
  done
  echo "cleanup: demo users deleted"
  [[ "$FAILED" == 0 ]] && echo "demo: PASSED" || { echo "demo: FAILED" >&2; exit 1; }
}
trap cleanup EXIT

sign_in() { # user tenant
  local password
  password="$(openssl rand -base64 18 | tr -d '/+=')Aa1!"
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$1-${RUN}" --message-action SUPPRESS \
    --user-attributes "Name=custom:tenantId,Value=$2" >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$1-${RUN}" --password "$password" --permanent
  TOKEN[$1]="$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$1-${RUN},PASSWORD=${password}" --query AuthenticationResult.AccessToken --output text)"
  local payload
  payload="$(cut -d. -f2 <<<"${TOKEN[$1]}" | tr '_-' '/+')"
  while (( ${#payload} % 4 )); do payload+="="; done
  SUB[$1]="$(base64 -d <<<"$payload" | jq -r .sub)"
}

call() { # user path body -> prints status; body to $RESPONSE
  RESPONSE="$(mktemp)"
  curl -s -o "$RESPONSE" -w '%{http_code}' -X POST "${BASE}$2" \
    -H "authorization: Bearer ${TOKEN[$1]}" -H 'content-type: application/json' -d "$3"
}

expect() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "PASS $1 ($3)"; else echo "FAIL $1: expected $2, got $3" >&2; FAILED=1; fi
}

event() { # actor session text
  jq -nc --arg a "$1" --arg s "$2" --arg t "$3" --argjson ts "$(date +%s)" \
    '{actorId:$a, sessionId:$s, eventTimestamp:$ts, payload:[{conversational:{role:"USER", content:{text:$t}}}]}'
}

sign_in alice tenant-a
sign_in bob tenant-a
sign_in carol tenant-ab
echo "signed in: alice and bob (tenant-a), carol (tenant-ab)"

expect "1. alice writes a fact to her own session" 201 \
  "$(call alice /events "$(event tenant-a "${SUB[alice]}" "Our warehouse codename is ${MARKER}. Remember this shared fact.")")"
expect "2. alice writes into bob's session" 403 "$(call alice /events "$(event tenant-a "${SUB[bob]}" 'Rejected write')")"
expect "3. carol writes under tenant-a" 403 "$(call carol /events "$(event tenant-a "${SUB[carol]}" 'Rejected write')")"
expect "4. carol recalls tenant-a's namespace" 403 "$(call carol /retrieve '{"namespace":"tenant-a","searchCriteria":{"searchQuery":"warehouse codename"}}')"

echo "waiting for extraction (up to 10 minutes)"
found=0
for _ in $(seq 1 40); do
  status="$(call bob /retrieve '{"namespace":"tenant-a","searchCriteria":{"searchQuery":"warehouse codename"}}')"
  if [[ "$status" == 200 ]] && grep -q "$MARKER" "$RESPONSE"; then found=1; break; fi
  sleep 15
done
expect "5. bob recalls alice's fact from tenant-a's shared memory" 1 "$found"
status="$(call carol /retrieve '{"namespace":"tenant-ab","searchCriteria":{"searchQuery":"warehouse codename"}}')"
leaked=0; grep -q "$MARKER" "$RESPONSE" && leaked=1
expect "6. carol's own recall succeeds without tenant-a's fact" "200 0" "${status} ${leaked}"
