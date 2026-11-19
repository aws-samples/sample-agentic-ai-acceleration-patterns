#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# End-to-end demo (README, End-to-end demo) against a stack deployed with
# -c integLocalCell=true. Each call is checked; what the demo creates is
# removed on exit, also on failure.
#
#   AWS_REGION=eu-central-1 bash scripts/demo.sh

set -euo pipefail
: "${AWS_REGION:?set AWS_REGION}"
stack=TenantUsageMetering
tenant=demo-tenant
meter="demo.requests.$RANDOM"

output() {
  aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
api="$(output ApiUrl)"
api="${api%/}"
cell="$(output CellId)"
account="$(aws sts get-caller-identity --query Account --output text)"

# Credentials of a stand-in caller, as KEY SECRET TOKEN.
assume() {
  aws sts assume-role --role-arn "$(output "$1")" --role-session-name metering-demo \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text
}
read -r reg_key reg_secret reg_token <<<"$(assume RegistrarRoleArn)"
read -r op_key op_secret op_token <<<"$(assume OperatorRoleArn)"
read -r em_key em_secret em_token <<<"$(assume EmitterRoleArn)"

# call EXPECTED_STATUS KEY SECRET TOKEN METHOD PATH [BODY]: prints the body.
call() {
  local expected="$1" key="$2" secret="$3" token="$4" method="$5" path="$6" body="${7:-}" out status
  out="$(mktemp)"
  local args=(--silent --show-error --output "$out" --write-out '%{http_code}' --request "$method"
    --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --user "${key}:${secret}"
    --header "x-amz-security-token: ${token}" --header 'content-type: application/json')
  [[ -n "$body" ]] && args+=(--data "$body")
  status="$(curl "${args[@]}" "${api}${path}")"
  if [[ "$status" != "$expected" ]]; then
    echo "FAIL $method $path: expected $expected, got $status: $(cat "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

cleanup() {
  echo "== cleanup"
  call 200 "$reg_key" "$reg_secret" "$reg_token" DELETE "/cells/${cell}/tenants/${tenant}" >/dev/null || true
  call 200 "$reg_key" "$reg_secret" "$reg_token" DELETE "/cells/${cell}/emitter" >/dev/null || true
  call 200 "$op_key" "$op_secret" "$op_token" DELETE "/meters/${meter}" >/dev/null || true
}
trap cleanup EXIT

echo "== 1 register the cell emitter"
call 200 "$reg_key" "$reg_secret" "$reg_token" PUT "/cells/${cell}/emitter" \
  "$(jq -nc --arg account "$account" '{applicationId: "demo-app", accountId: $account}')" | jq -e '.emitter.status == "ACTIVE"' >/dev/null

echo "== 2 bind a tenant to the cell"
call 200 "$reg_key" "$reg_secret" "$reg_token" PUT "/cells/${cell}/tenants/${tenant}" '{"applicationId":"demo-app","billingAccount":"demo-account"}' |
  jq -e '.binding.status == "ACTIVE"' >/dev/null

echo "== 3 create a meter"
call 201 "$op_key" "$op_secret" "$op_token" POST /meters \
  "$(jq -nc --arg id "$meter" --arg from "$(date -u +%Y-%m-%dT%H)" '{meterId: $id, unit: "requests", rule: "COUNT", effectiveFrom: $from}')" >/dev/null

echo "== 4 send usage: one bound tenant, one that is not"
sleep 2
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
hour="${now:0:13}"
results="$(call 200 "$em_key" "$em_secret" "$em_token" POST /usage-events "$(jq -nc --arg m "$meter" --arg t "$tenant" --arg now "$now" \
  --arg e1 "$(uuidgen | tr 'A-Z' 'a-z')" --arg e2 "$(uuidgen | tr 'A-Z' 'a-z')" \
  '{events: [{eventId: $e1, tenantId: $t, meterId: $m, value: "1", time: $now}, {eventId: $e2, tenantId: "someone-else", meterId: $m, value: "1", time: $now}]}')")"
echo "$results" | jq -c '.results'
echo "$results" | jq -e '.results[0].result == "ACCEPTED" and .results[1].reason == "TENANT_NOT_IN_CELL"' >/dev/null

echo "== 5 the event's hour is tracked, OPEN, once Firehose writes the object (up to 90 s)"
summary=""
for _ in $(seq 1 18); do
  if summary="$(call 200 "$op_key" "$op_secret" "$op_token" GET "/hours/${hour}" 2>/dev/null)" &&
    echo "$summary" | jq -e '.hourSummary.status' >/dev/null; then
    break
  fi
  summary=""
  sleep 5
done
if [[ -z "$summary" ]]; then
  echo "FAIL hour ${hour} was not tracked within 90 s" >&2
  exit 1
fi
echo "$summary" | jq -c '.hourSummary'
if ! echo "$summary" | jq -e '.hourSummary.status == "OPEN"' >/dev/null; then
  echo "FAIL hour ${hour} is $(echo "$summary" | jq -r '.hourSummary.status'), expected OPEN" >&2
  exit 1
fi

echo "== done: the hour is counted after it ends and its grace passes; read it with GET /tenants/${tenant}/applications/demo-app/usage?from=${hour}&to=${hour}"
