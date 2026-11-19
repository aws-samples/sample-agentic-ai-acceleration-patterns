#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Path spike probes. Assumes the bounded /cell/ probe role, whose own
# policy allows every escalation on `*`, and checks that the cell boundary
# refuses each one while a change to a /cell/ role still works.
# Usage: AWS_PROFILE=<cell account profile> AWS_REGION=eu-central-1 ./probes.sh
set -uo pipefail
account="$(aws sts get-caller-identity --query Account --output text)" || exit 2
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 2; }
region="${AWS_REGION:?AWS_REGION is required}"
partition=aws
standin="arn:${partition}:iam::${account}:role/cell-spike-role-pair-stand-in"
deploy="cdk-cell-deploy-role-${account}-${region}"

read -r AK SK ST < <(aws sts assume-role --role-arn "arn:${partition}:iam::${account}:role/cell/cell-spike-probe" \
  --role-session-name q5-probe --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
[[ -n "${AK:-}" && -n "${SK:-}" && -n "${ST:-}" ]] || { echo "could not assume cell/cell-spike-probe" >&2; exit 2; }
# No shared config or credentials file and no instance metadata: the probe
# role's keys are the only ones the CLI can find.
probe() {
  env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
    AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" AWS_REGION="$region" aws "$@"
}
caller="$(probe sts get-caller-identity --query Arn --output text)"
[[ "$caller" == "arn:${partition}:sts::${account}:assumed-role/cell-spike-probe/q5-probe" ]] \
  || { echo "probes would run as ${caller}, not the probe role" >&2; exit 2; }

fails=0
expect_denied() {
  local name="$1"; shift
  local out
  if out="$(probe "$@" 2>&1)"; then
    echo "FAIL  ${name}: allowed"; fails=$((fails + 1))
  elif grep -qi 'explicit deny in a permissions boundary' <<<"$out"; then
    echo "PASS  ${name}: explicit deny in the permissions boundary"
  else
    echo "FAIL  ${name}: unexpected error: $(head -c 200 <<<"$out")"; fails=$((fails + 1))
  fi
}
expect_allowed() {
  local name="$1"; shift
  local out
  if out="$(probe "$@" 2>&1)"; then echo "PASS  ${name}: allowed"
  else echo "FAIL  ${name}: $(head -c 200 <<<"$out")"; fails=$((fails + 1)); fi
}

trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::111122223333:root"},"Action":"sts:AssumeRole"}]}'
admin='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'
lambda_trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
boundary="arn:${partition}:iam::${account}:policy/cell-permissions-boundary"
zip_file="$(mktemp -d)/fn.zip"
printf 'def h(e, c):\n    return 0\n' > "${zip_file%.zip}.py"
(cd "$(dirname "$zip_file")" && zip -q fn.zip fn.py)

expect_denied "UpdateAssumeRolePolicy on the role pair" iam update-assume-role-policy --role-name cell-spike-role-pair-stand-in --policy-document "$trust"
expect_denied "PutRolePolicy on the role pair" iam put-role-policy --role-name cell-spike-role-pair-stand-in --policy-name q5 --policy-document "$admin"
expect_denied "PutRolePolicy on a cdk-cell bootstrap role" iam put-role-policy --role-name "$deploy" --policy-name q5 --policy-document "$admin"
expect_denied "AttachRolePolicy AdministratorAccess on the role pair" iam attach-role-policy --role-name cell-spike-role-pair-stand-in --policy-arn "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied "AssumeRole of the role pair" sts assume-role --role-arn "$standin" --role-session-name q5
expect_denied "AssumeRole of the cdk-cell deploy role" sts assume-role --role-arn "arn:${partition}:iam::${account}:role/${deploy}" --role-session-name q5
expect_denied "PassRole of a role outside /cell/" lambda create-function --function-name q5-pass-role-probe --runtime python3.12 --handler fn.h --zip-file "fileb://${zip_file}" --role "$standin"
expect_denied "CreateRole on / with the boundary" iam create-role --role-name q5-root-path --assume-role-policy-document "$lambda_trust" --permissions-boundary "$boundary"
expect_denied "CreateRole on /cell/ without the boundary" iam create-role --role-name q5-no-boundary --path /cell/ --assume-role-policy-document "$lambda_trust"
expect_denied "CreateServiceLinkedRole for another service" iam create-service-linked-role --aws-service-name elasticloadbalancing.amazonaws.com
expect_denied "DeleteRolePermissionsBoundary on itself" iam delete-role-permissions-boundary --role-name cell-spike-probe
expect_denied "AttachRolePolicy AdministratorAccess on a cdk-cell bootstrap role" iam attach-role-policy --role-name "$deploy" --policy-arn "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied "PutRolePermissionsBoundary AdministratorAccess on a /cell/ role" iam put-role-permissions-boundary --role-name cell-spike-positive --permissions-boundary "arn:${partition}:iam::aws:policy/AdministratorAccess"
expect_denied "CreatePolicyVersion on the boundary" iam create-policy-version --policy-arn "$boundary" --policy-document "$admin" --set-as-default
expect_denied "SetDefaultPolicyVersion on the execution policy" iam set-default-policy-version --policy-arn "arn:${partition}:iam::${account}:policy/cell-execution-policy" --version-id v1
expect_denied "PutParameter over the identity pool id" ssm put-parameter --name /application-plane/shared/identity/userPoolId --type String --value q5 --overwrite
expect_denied "PutParameter over the cell bootstrap version" ssm put-parameter --name /cdk-bootstrap/cell/version --type String --value 99 --overwrite
expect_denied "UpdateAccount: point the API Gateway logs role at a /cell/ role" apigateway update-account --patch-operations "op=replace,path=/cloudwatchRoleArn,value=arn:${partition}:iam::${account}:role/cell/cell-spike-positive"
slr_out="$(probe iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com 2>&1)"
slr_rc=$?
if [[ $slr_rc -eq 0 ]]; then
  echo "PASS  CreateServiceLinkedRole for API Gateway under role/aws-service-role/ (positive control): allowed (created)"
elif grep -q 'has been taken' <<<"$slr_out"; then
  echo "PASS  CreateServiceLinkedRole for API Gateway under role/aws-service-role/ (positive control): allowed (already present)"
else
  echo "FAIL  CreateServiceLinkedRole for API Gateway: $(head -c 200 <<<"$slr_out")"; fails=$((fails + 1))
fi
expect_allowed "UpdateRoleDescription on a /cell/ role (positive control)" iam update-role-description --role-name cell-spike-positive --description "changed by the q5 probe"
expect_allowed "GetRole on the role pair (read stays open)" iam get-role --role-name cell-spike-role-pair-stand-in --query Role.Path --output text

echo "probes failed: ${fails}"
exit "$fails"
