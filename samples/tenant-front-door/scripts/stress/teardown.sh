#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress slice, `teardown [--fixtures]`: removes what the slice deployed and
# checks that nothing it owned is left.
#
# Order, which matters:
#   1. the run's tenants in tenant-identity and their namespace parameters, and
#      their routes while the registrar exists;
#   2. the stacks, last deployed first: cell, edge logging, main, edge,
#      stand-in control plane, support.
# A slice-mode run registers no global hook on any control plane, so this
# script unregisters none.
# Each stack's destroy time is printed. The tenants stay only at a tier whose
# onboarding is a fixture (`large`) and only without `--fixtures`; the stacks
# always go, they are not fixtures.
#
# Prints one `stack=<name> destroy_seconds=<n>` line per stack and exits
# non-zero when a stack, a resource it owned, a tenant, a log group or the edge
# parameter is still there, or when it cannot tell. A leftover that needs a
# person is listed with the AWS CLI line that removes it: this script never
# deletes a log group, a bucket or an EC2 resource by hand.

set -euo pipefail

# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fixtures=0
case "$#:${1:-}" in
  0:) ;;
  1:--fixtures) fixtures=1 ;;
  *) echo "usage: teardown.sh [--fixtures]" >&2; exit 2 ;;
esac
for tool in aws jq npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: ${tool}"
done
[[ -d "$STATE_DIR" ]] || { echo "teardown: no state under ${STATE_DIR}: nothing was deployed by this prefix"; exit 0; }
cd "$SAMPLE_DIR"
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT
status=0
# Compared with the creation time AWS gives a log group: the two clocks may differ by a few seconds, so a group made within seconds of this
# mark may be read the wrong way round.
TEARDOWN_START_MS="$(( $(date +%s) * 1000 ))"
account="$(aws sts get-caller-identity --query Account --output text)"
echo "teardown: account ${account}, ${AWS_REGION}, prefix ${PREFIX}"
# The host's record of the prefix names the account and Region it was made in. Another account's or Region's stacks of the same names are not this run's.
check_record "$CONTEXT" "$account"
check_record "$OUTPUTS" "$account"

driver() { (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts "$@"); }

# 1. Tenants, parameters, routes. At `large` the seeded tenants stay unless --fixtures (stress ADR-0004).
: "${STRESS_TIER_JSON:?teardown.sh: STRESS_TIER_JSON is not set (slice.sh sets it)}"
onboarding="$(jq -er .onboarding <<<"$STRESS_TIER_JSON")"
if [[ "$fixtures" -eq 1 || "$onboarding" == every-run ]]; then
  # The tenants are not the stacks': remove them whether or not the front door is still there. Its routes go with it.
  if stack_exists "$STACK_MAIN"; then
    driver sweep || status=1
  else
    driver sweep --no-routes || status=1
  fi
  if [[ -e "${STATE_DIR}/manifest.json" ]]; then
    echo "teardown: ${STATE_DIR}/manifest.json is still there: some tenants were not removed" >&2
    status=1
  fi
fi

# 2. What the stacks own, read before they go: the ids are the only way back. A rerun adds to what an earlier run read.
found="${LOGS}/resources.jsonl"
: >"$found"
for s in "$STACK_CELL" "$STACK_LOGGING" "$STACK_MAIN" "$STACK_EDGE" "$STACK_CP" "$STACK_SUPPORT"; do
  if stack_exists "$s"; then
    if listed="$(aws cloudformation describe-stack-resources --region "$(stack_region "$s")" --stack-name "$s" \
      --query 'StackResources[].{type: ResourceType, id: PhysicalResourceId}' --output json)"; then
      jq -c --arg r "$(stack_region "$s")" '.[] | . + {region: $r}' <<<"$listed" >>"$found"
    else
      echo "teardown: could not list the resources of ${s}; the leftover check cannot cover it" >&2
      status=1
    fi
  fi
done
[[ ! -e "$RESOURCES" ]] || cat "$RESOURCES" >>"$found"
sort -u "$found" >"$RESOURCES"
chmod 600 "$RESOURCES"

destroy_stack() { # STACK KIND
  local stack="$1" kind="$2" start=$SECONDS secs
  if ! stack_exists "$stack"; then
    echo "stack=${stack} destroy_seconds=0 (not there)"
    return 0
  fi
  echo "== destroy ${stack}"
  if [[ "$kind" == smoke ]]; then
    smoke_context_args
    npx cdk destroy "$stack" --exclusively --force --app "$SMOKE_APP" --output "${STATE_DIR}/cdk.out.smoke" "${SMOKE_CONTEXT[@]}" >"${LOGS}/${stack}.log" 2>&1 || {
      tail -30 "${LOGS}/${stack}.log" >&2; status=1; echo "teardown: destroy of ${stack} failed" >&2; return 0; }
  else
    fd_context_args
    npx cdk destroy "$(fd_selector "$stack")" --exclusively --force --output "${STATE_DIR}/cdk.out.fd" "${FD_CONTEXT[@]}" >"${LOGS}/${stack}.log" 2>&1 || {
      tail -30 "${LOGS}/${stack}.log" >&2; status=1; echo "teardown: destroy of ${stack} failed" >&2; return 0; }
  fi
  secs=$((SECONDS - start))
  echo "stack=${stack} destroy_seconds=${secs}"
  echo "$(date -u +%F) stack=${stack} destroy_seconds=${secs}" >>"$TIMINGS"
}

[[ -s "$CONTEXT" ]] || { echo "teardown: no ${CONTEXT}: this host has no stack of the prefix to destroy (deploy stopped before it created one, or an earlier teardown finished clean)"; exit "$status"; }
total_start=$SECONDS
destroy_stack "$STACK_CELL" smoke
destroy_stack "$STACK_LOGGING" fd
destroy_stack "$STACK_MAIN" fd
destroy_stack "$STACK_EDGE" fd
destroy_stack "$STACK_CP" smoke
destroy_stack "$STACK_SUPPORT" smoke
echo "teardown: stacks destroyed in $((SECONDS - total_start)) s"

# 3. Nothing left.
for s in "$STACK_CELL" "$STACK_LOGGING" "$STACK_MAIN" "$STACK_EDGE" "$STACK_CP" "$STACK_SUPPORT"; do
  if stack_exists "$s"; then echo "teardown: stack ${s} is still there" >&2; status=1; fi
done
if held="$(aws ssm get-parameter --name "$PARAM_EDGE" --query Parameter.Value --output text 2>"${LOGS}/edge-parameter.err")"; then
  # The name is fixed per account and Region: a front door another person deployed since holds it under its own distribution.
  mine="$(jq -r '.distributionArn // empty' "$CONTEXT" 2>/dev/null || true)"
  theirs="$(jq -r '.distributionArn // empty' <<<"$held" 2>/dev/null || true)"
  if [[ -n "$mine" && "$mine" == "$theirs" ]]; then
    echo "teardown: ${PARAM_EDGE} is still there; remove it with: aws ssm delete-parameter --name ${PARAM_EDGE} --region ${AWS_REGION}" >&2
    status=1
  elif [[ -n "$theirs" ]]; then
    # The main stack owns the parameter and its destroy removes it, so a parameter of another distribution (or one this run never recorded) is not this run's.
    echo "teardown: ${PARAM_EDGE} is held by a front door this run did not deploy (${theirs##*/}); it is left as it is"
  else
    echo "teardown: could not tell whose ${PARAM_EDGE} is" >&2
    status=1
  fi
elif ! grep -q 'ParameterNotFound' "${LOGS}/edge-parameter.err"; then
  echo "teardown: could not tell whether ${PARAM_EDGE} is gone" >&2
  status=1
fi

# log_group_created GROUP REGION -> the group's creation time in epoch milliseconds, `none` when it is not there; fails when AWS does not answer.
log_group_created() {
  local out
  out="$(aws logs describe-log-groups --region "$2" --log-group-name-prefix "$1" --query "logGroups[?logGroupName=='$1'].creationTime | [0]" --output text)" || return 1
  [[ "$out" == None || -z "$out" ]] && echo none || echo "$out"
}

# exists TYPE ID REGION: 0 when the resource is still there, 1 when it is gone, 2 when the type is one this
# script does not read, 3 when AWS did not say (a throttle, a denial): the check cannot tell.
exists() {
  local type="$1" id="$2" region="$3" err created
  case "$type" in
    AWS::Lambda::Function)
      err="$(aws lambda get-function --region "$region" --function-name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ResourceNotFoundException' <<<"$err" && return 1 ;;
    AWS::Logs::LogGroup)
      created="$(log_group_created "$id" "$region")" || return 3
      [[ "$created" == none ]] && return 1 || return 0 ;;
    AWS::ApiGateway::RestApi)
      err="$(aws apigateway get-rest-api --region "$region" --rest-api-id "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'NotFoundException' <<<"$err" && return 1 ;;
    AWS::Cognito::UserPool)
      err="$(aws cognito-idp describe-user-pool --region "$region" --user-pool-id "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ResourceNotFoundException' <<<"$err" && return 1 ;;
    AWS::DynamoDB::GlobalTable | AWS::DynamoDB::Table)
      err="$(aws dynamodb describe-table --region "$region" --table-name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ResourceNotFoundException' <<<"$err" && return 1 ;;
    AWS::S3::Bucket)
      err="$(aws s3api head-bucket --bucket "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'Not Found\|404' <<<"$err" && return 1 ;;
    AWS::IAM::Role)
      err="$(aws iam get-role --role-name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'NoSuchEntity' <<<"$err" && return 1 ;;
    AWS::CloudFront::Distribution)
      err="$(aws cloudfront get-distribution --id "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'NoSuchDistribution' <<<"$err" && return 1 ;;
    AWS::CloudFront::Function)
      # CloudFormation gives the function's ARN; the CLI takes its name.
      err="$(aws cloudfront describe-function --name "${id##*/}" 2>&1 >/dev/null)" && return 0
      grep -q 'NoSuchFunctionExists' <<<"$err" && return 1 ;;
    AWS::CloudFront::KeyValueStore)
      err="$(aws cloudfront describe-key-value-store --name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'EntityNotFound\|NoSuchResource' <<<"$err" && return 1 ;;
    AWS::SSM::Parameter)
      err="$(aws ssm get-parameter --region "$region" --name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ParameterNotFound' <<<"$err" && return 1 ;;
    AWS::CertificateManager::Certificate)
      err="$(aws acm describe-certificate --region "$region" --certificate-arn "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ResourceNotFoundException' <<<"$err" && return 1 ;;
    *) return 2 ;;
  esac
  return 3
}

# The log group of a function a CDK custom resource provider creates is not declared in any stack: Lambda makes it
# on the first call. CDK names such a function <prefix>-<stack part>-Custom...-<12 characters> or ...-AWS<hex>-<12 characters>.
CDK_PROVIDER="^${PREFIX}-[A-Za-z-]+-(Custom[A-Za-z0-9]+|AWS[0-9a-f]{1,32})-[A-Za-z0-9]{12}\$"

unchecked=0
unowned=0
left=0
unsure=0
while IFS= read -r line; do
  type="$(jq -r .type <<<"$line")"; id="$(jq -r .id <<<"$line")"; region="$(jq -r .region <<<"$line")"
  rc=0
  exists "$type" "$id" "$region" || rc=$?
  case "$rc" in
    0)
      created=0
      [[ "$type" != AWS::Logs::LogGroup ]] || created="$(log_group_created "$id" "$region")" || created=0
      if [[ "$type" == AWS::Logs::LogGroup && "$created" =~ ^[0-9]+$ && "$created" -ge "$TEARDOWN_START_MS" ]]; then
        # The stack deleted this group and a function that was still logging made it again (late log delivery).
        echo "teardown: NOTE log group ${id} (${region}) was made again by a late write after the stack deleted it; remove it with: aws logs delete-log-group --log-group-name ${id} --region ${region}" >&2
        unowned=$((unowned + 1))
      else
        echo "teardown: still there: ${type} ${id} (${region})" >&2
        left=$((left + 1))
      fi
      ;;
    2) unchecked=$((unchecked + 1)) ;;
    3) echo "teardown: could not tell whether ${type} ${id} (${region}) is gone" >&2; unsure=$((unsure + 1)) ;;
  esac
  # A Lambda function's own log group, which CloudFormation does not own unless the stack declares it.
  if [[ "$type" == AWS::Lambda::Function && "$rc" -eq 1 ]]; then
    if created="$(log_group_created "/aws/lambda/${id}" "$region")"; then
      if [[ "$created" != none ]]; then
        if [[ "$id" =~ $CDK_PROVIDER ]]; then
          echo "teardown: NOTE log group /aws/lambda/${id} (${region}) was created by a CDK custom resource function and no stack owns it; remove it with: aws logs delete-log-group --log-group-name /aws/lambda/${id} --region ${region}" >&2
          unowned=$((unowned + 1))
        else
          echo "teardown: log group /aws/lambda/${id} is still there; remove it with: aws logs delete-log-group --log-group-name /aws/lambda/${id} --region ${region}" >&2
          left=$((left + 1))
        fi
      fi
    else
      echo "teardown: could not tell whether log group /aws/lambda/${id} (${region}) is gone" >&2
      unsure=$((unsure + 1))
    fi
  fi
done <"$RESOURCES"
if (( left > 0 || unsure > 0 )); then status=1; fi
if (( status == 0 )); then
  kept=""
  if [[ "$fixtures" -ne 1 && "$onboarding" != every-run ]]; then
    kept=" The tenants of the fixture tier are kept (no --fixtures)."
  fi
  echo "teardown: no stack, resource, log group or edge parameter left (${unchecked} resources of types this check does not read; ${unowned} log groups noted above).${kept}"
  # The host's record of the prefix ends with its stacks: a later deploy then checks that no stack of the prefix exists.
  rm -f "$CONTEXT"
fi
exit "$status"
