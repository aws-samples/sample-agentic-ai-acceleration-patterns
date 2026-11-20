#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress slice, `teardown [--fixtures]`: removes what the slice deployed and
# checks that nothing it owned is left.
#
# Order, which matters (stress plan review, finding 12):
#   1. the run's tenants, their routes and their cell namespace parameters;
#   2. the front door's two global hooks on the control plane, when the run has
#      one (STRESS_CONTROL_PLANE_URL and CONTROL_PLANE_TOKEN set, platform
#      mode): a control plane whose hooks still point at a destroyed registrar
#      fails every cell and deployment delete. Slice mode has no hooks to
#      remove, and says so;
#   3. the stacks, last deployed first: cell, edge logging, main, edge,
#      stand-in control plane, support.
# Each stack's destroy time is printed. The tenants stay only at a tier whose
# onboarding is a fixture (`large`) and only without `--fixtures`; the stacks
# always go, they are not fixtures.
#
# Prints one `stack=<name> destroy_seconds=<n>` line per stack and exits
# non-zero when a stack, a resource it owned, a log group or the edge
# parameter is still there. A leftover is listed with the AWS CLI line that
# removes it: this script never deletes a log group, a bucket or an EC2 resource
# by hand.

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
TEARDOWN_START_MS="$(( $(date +%s) * 1000 ))"
echo "teardown: account $(aws sts get-caller-identity --query Account --output text), ${AWS_REGION}, prefix ${PREFIX}"

# 1. Tenants, routes, parameters. At `large` the seeded tenants stay unless --fixtures (stress ADR-0004).
onboarding=every-run
[[ -z "${STRESS_TIER_JSON:-}" ]] || onboarding="$(jq -er .onboarding <<<"$STRESS_TIER_JSON")"
if [[ "$fixtures" -eq 1 || "$onboarding" == every-run ]]; then
  if [[ -s "$OUTPUTS" ]] && stack_exists "$STACK_MAIN"; then
    (cd "$SAMPLE_DIR" && node_modules/.bin/ts-node -T -P test/tsconfig.json --prefer-ts-exts test/stress/driver.ts sweep) || status=1
  else
    echo "teardown: the front door is not deployed: no routes to remove"
  fi
fi

# 2. The global hooks.
if [[ -n "${STRESS_CONTROL_PLANE_URL:-}" && -n "${CONTROL_PLANE_TOKEN:-}" ]]; then
  echo "teardown: unregistering the front door's global hooks on the control plane"
  CONTROL_PLANE_URL="$STRESS_CONTROL_PLANE_URL" "${SAMPLE_DIR}/scripts/register-hooks.sh" --delete || status=1
else
  echo "teardown: no control plane in this run (slice mode: a stand-in control plane, no hooks): no global hooks to unregister"
fi

# 3. What the stacks own, read before they go: the ids are the only way back.
: >"$RESOURCES"
for s in "$STACK_CELL" "$STACK_LOGGING" "$STACK_MAIN" "$STACK_EDGE" "$STACK_CP" "$STACK_SUPPORT"; do
  if stack_exists "$s"; then
    aws cloudformation describe-stack-resources --region "$(stack_region "$s")" --stack-name "$s" \
      --query 'StackResources[].{type: ResourceType, id: PhysicalResourceId}' --output json \
      | jq -c --arg r "$(stack_region "$s")" '.[] | . + {region: $r}' >>"$RESOURCES" || true
  fi
done
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

[[ -s "$CONTEXT" ]] || { echo "teardown: no ${CONTEXT}: deploy stopped before it created a stack"; exit "$status"; }
total_start=$SECONDS
destroy_stack "$STACK_CELL" smoke
destroy_stack "$STACK_LOGGING" fd
destroy_stack "$STACK_MAIN" fd
destroy_stack "$STACK_EDGE" fd
destroy_stack "$STACK_CP" smoke
destroy_stack "$STACK_SUPPORT" smoke
echo "teardown: stacks destroyed in $((SECONDS - total_start)) s"

# 4. Nothing left.
for s in "$STACK_CELL" "$STACK_LOGGING" "$STACK_MAIN" "$STACK_EDGE" "$STACK_CP" "$STACK_SUPPORT"; do
  if stack_exists "$s"; then echo "teardown: stack ${s} is still there" >&2; status=1; fi
done
if aws ssm get-parameter --name "$PARAM_EDGE" >/dev/null 2>&1; then
  echo "teardown: ${PARAM_EDGE} is still there; remove it with: aws ssm delete-parameter --name ${PARAM_EDGE} --region ${AWS_REGION}" >&2
  status=1
fi

# exists TYPE ID REGION: 0 when the resource is still there, 1 when it is gone, 2 when this script cannot tell.
exists() {
  local type="$1" id="$2" region="$3" err
  case "$type" in
    AWS::Lambda::Function)
      err="$(aws lambda get-function --region "$region" --function-name "$id" 2>&1 >/dev/null)" && return 0
      grep -q 'ResourceNotFoundException' <<<"$err" && return 1 ;;
    AWS::Logs::LogGroup)
      [[ -n "$(aws logs describe-log-groups --region "$region" --log-group-name-prefix "$id" --query "logGroups[?logGroupName=='${id}'].logGroupName" --output text)" ]] && return 0 || return 1 ;;
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
      err="$(aws cloudfront describe-function --name "$id" 2>&1 >/dev/null)" && return 0
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
  return 2
}

unchecked=0
unowned=0
left=0
while IFS= read -r line; do
  type="$(jq -r .type <<<"$line")"; id="$(jq -r .id <<<"$line")"; region="$(jq -r .region <<<"$line")"
  rc=0
  exists "$type" "$id" "$region" || rc=$?
  case "$rc" in
    0)
      created="$(aws logs describe-log-groups --region "$region" --log-group-name-prefix "$id" --query "logGroups[?logGroupName=='${id}'].creationTime | [0]" --output text 2>/dev/null || echo 0)"
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
  esac
  # A Lambda function's own log group, which CloudFormation does not own unless the stack declares it. A function that a CDK
  # custom resource provider creates has none declared: Lambda makes the group on the first call. Those are listed with their
  # removal line and do not fail the check; any other function's group does.
  if [[ "$type" == AWS::Lambda::Function && "$rc" -ne 2 ]]; then
    if [[ -n "$(aws logs describe-log-groups --region "$region" --log-group-name-prefix "/aws/lambda/${id}" --query "logGroups[?logGroupName=='/aws/lambda/${id}'].logGroupName" --output text)" ]]; then
      if [[ "$id" =~ -(Custom|AWS[0-9a-f]{4})[A-Za-z0-9]* ]]; then
        echo "teardown: NOTE log group /aws/lambda/${id} (${region}) was created by a CDK custom resource function and no stack owns it; remove it with: aws logs delete-log-group --log-group-name /aws/lambda/${id} --region ${region}" >&2
        unowned=$((unowned + 1))
      else
        echo "teardown: log group /aws/lambda/${id} is still there; remove it with: aws logs delete-log-group --log-group-name /aws/lambda/${id} --region ${region}" >&2
        left=$((left + 1))
      fi
    fi
  fi
done <"$RESOURCES"
if (( left > 0 )); then status=1; fi
(( status == 0 )) && echo "teardown: no stack, resource, log group or edge parameter left (${unchecked} resources of types this check does not read; ${unowned} log groups noted above)"
exit "$status"
