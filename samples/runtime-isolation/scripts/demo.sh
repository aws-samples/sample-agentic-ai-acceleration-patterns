#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo (docs/sample-standard.md §7.6) against a deployed
# RuntimeIsolation-<ingress> stack and a deployed tenant-identity shared-pool.
#
#   AWS_REGION=eu-central-1 scripts/demo.sh            # reads the ingress from SSM
#   AWS_REGION=eu-central-1 scripts/demo.sh api-gateway
#
# SKELETON: step bodies are outlined and marked TODO; filled in with the first
# deployment. Walks: sign in as two users of two tenants, call the agent, show
# that the unit (session prefix, per-VM nonce) follows the token and not the
# request, then (TVM on) that a cross-tenant read fails in IAM. Cleans up what
# it created on exit, also on failure. Conventions: scripts/CONVENTIONS.md.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region the stacks are deployed in}"
for tool in aws curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
export AWS_DEFAULT_REGION="$AWS_REGION"

PARAM_PREFIX="/application-plane/shared/agent-runtime"
IDENTITY_PREFIX="/application-plane/shared/identity"

param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }

INGRESS="${1:-$(param "${PARAM_PREFIX}/ingress")}"
ENDPOINT="$(param "${PARAM_PREFIX}/endpointUrl")"
USER_POOL_ID="$(param "${IDENTITY_PREFIX}/userPoolId")"
APP_CLIENT_ID="$(param "${IDENTITY_PREFIX}/appClientId")"
: "${INGRESS:?}" "${ENDPOINT:?}" "${USER_POOL_ID:?}" "${APP_CLIENT_ID:?}"
echo "ingress=${INGRESS} (endpoint and identifiers resolved from SSM; not printed)"

BODY="$(mktemp)"
CREATED_USERS=()
cleanup() {
  set +e
  for u in "${CREATED_USERS[@]:-}"; do
    [ -n "$u" ] && aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$u" >/dev/null 2>&1
  done
  rm -f "$BODY"
}
trap cleanup EXIT

# invoke <token-var-name> <json-body> -> prints "HTTP <status>"; body in $BODY.
# The token is passed by variable name so it never appears on a command line.
invoke() {
  local token_var="$1" json="$2" status
  status="$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$ENDPOINT" \
    -H "Authorization: Bearer ${!token_var}" -H 'Content-Type: application/json' -d "$json")"
  echo "HTTP ${status}"
}

report() { jq -r "{sessionPrefix, nonce, forwardedScope, credentials, read: .read.result} | tostring" "$BODY"; }

echo "== 1. two tenants, three users (tenant-identity shared-pool)"
# TODO: create tenant-a and tenant-b via tenant-identity's platform API (SigV4), users a1, a2, b1 with
# @simulator.amazonses.com addresses, permanent passwords, and obtain access tokens into TOKEN_A1,
# TOKEN_A2, TOKEN_B1 (cognito-idp admin-initiate-auth ... --query AuthenticationResult.AccessToken).

echo "== 2. A1 opens conversation c1; the agent reports its session prefix and nonce"
# TODO: invoke TOKEN_A1 '{"conversationId":"demoConversation0001","prompt":"hello"}'; report

echo "== 3. A2 and B1 send the same conversationId: different prefix, different nonce (P-2)"
# TODO

echo "== 4. A1 resumes c1: same nonce (session module on)"
# TODO

echo "== 5. A token without tenant_id, an expired token: 401/403"
# TODO

echo "== 6. TVM: A1 reads tenant-a (ok) and tenant-b (AccessDeniedException from IAM) (P-8)"
# TODO: invoke TOKEN_A1 '{"conversationId":"demoConversation0001","prompt":"read tenant-a"}'; report
# TODO: invoke TOKEN_A1 '{"conversationId":"demoConversation0001","prompt":"read tenant-b"}'; report

echo "== 7. streaming: 'stream 10' arrives as text/event-stream over ten seconds"
# TODO: curl -N with -w ttfb/total; count 'data:' lines.

echo "demo complete"
