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

# Each stand-in caller's signing key and session token go to curl in a
# mode-600 config file, never on a command line; the files are removed
# from the exit trap.
umask 077
reg_conf="$(mktemp)"
op_conf="$(mktemp)"
em_conf="$(mktemp)"
remove_confs() { rm -f "$reg_conf" "$op_conf" "$em_conf"; }
trap remove_confs EXIT

# assume OUTPUT_KEY CONF: writes the role's credentials as a curl config.
assume() {
  aws sts assume-role --role-arn "$(output "$1")" --role-session-name metering-demo --query Credentials --output json |
    jq -r '"user = \"\(.AccessKeyId):\(.SecretAccessKey)\"", "header = \"x-amz-security-token: \(.SessionToken)\""' >"$2"
}
assume RegistrarRoleArn "$reg_conf"
assume OperatorRoleArn "$op_conf"
assume EmitterRoleArn "$em_conf"

# call EXPECTED_STATUS CONF METHOD PATH [BODY]: prints the body.
call() {
  local expected="$1" conf="$2" method="$3" path="$4" body="${5:-}" out status
  out="$(mktemp)"
  local args=(--silent --show-error --config "$conf" --output "$out" --write-out '%{http_code}' --request "$method"
    --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --header 'content-type: application/json')
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
  call 200 "$reg_conf" DELETE "/cells/${cell}/tenants/${tenant}" >/dev/null || true
  call 200 "$reg_conf" DELETE "/cells/${cell}/emitter" >/dev/null || true
  call 200 "$op_conf" DELETE "/meters/${meter}" >/dev/null || true
  remove_confs
}
trap cleanup EXIT

echo "== 1 register the cell emitter"
call 200 "$reg_conf" PUT "/cells/${cell}/emitter" \
  "$(jq -nc --arg account "$account" '{applicationId: "demo-app", accountId: $account}')" | jq -e '.emitter.status == "ACTIVE"' >/dev/null

echo "== 2 bind a tenant to the cell"
call 200 "$reg_conf" PUT "/cells/${cell}/tenants/${tenant}" '{"applicationId":"demo-app","billingAccount":"demo-account"}' |
  jq -e '.binding.status == "ACTIVE"' >/dev/null

echo "== 3 create a meter"
call 201 "$op_conf" POST /meters \
  "$(jq -nc --arg id "$meter" --arg from "$(date -u +%Y-%m-%dT%H)" '{meterId: $id, unit: "requests", rule: "COUNT", effectiveFrom: $from}')" >/dev/null

echo "== 4 send usage: one bound tenant, one that is not"
sleep 2
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
hour="${now:0:13}"
results="$(call 200 "$em_conf" POST /usage-events "$(jq -nc --arg m "$meter" --arg t "$tenant" --arg now "$now" \
  --arg e1 "$(uuidgen | tr 'A-Z' 'a-z')" --arg e2 "$(uuidgen | tr 'A-Z' 'a-z')" \
  '{events: [{eventId: $e1, tenantId: $t, meterId: $m, value: "1", time: $now}, {eventId: $e2, tenantId: "someone-else", meterId: $m, value: "1", time: $now}]}')")"
echo "$results" | jq -c '.results'
echo "$results" | jq -e '.results[0].result == "ACCEPTED" and .results[1].reason == "TENANT_NOT_IN_CELL"' >/dev/null

echo "== 5 the event's hour is tracked, OPEN, once Firehose writes the object (up to 90 s)"
summary=""
for _ in $(seq 1 18); do
  if summary="$(call 200 "$op_conf" GET "/hours/${hour}" 2>/dev/null)" &&
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
