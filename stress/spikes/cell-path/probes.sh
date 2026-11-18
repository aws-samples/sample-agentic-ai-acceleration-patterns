#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Path spike probes. Assumes the bounded /cell/ probe role, whose own
# policy allows every escalation on `*`, and checks that the cell boundary
# refuses each one while a change to a /cell/ role still works.
# Usage: AWS_PROFILE=<cell account profile> AWS_REGION=eu-central-1 ./probes.sh
set -uo pipefail
account="$(aws sts get-caller-identity --query Account --output text)"
region="${AWS_REGION:?AWS_REGION is required}"
partition=aws
standin="arn:${partition}:iam::${account}:role/cell-spike-role-pair-stand-in"
deploy="cdk-cell-deploy-role-${account}-${region}"

read -r AK SK ST < <(aws sts assume-role --role-arn "arn:${partition}:iam::${account}:role/cell/cell-spike-probe" \
  --role-session-name q5-probe --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
probe() { env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" aws "$@"; }

fails=0
expect_denied() {
  local name="$1"; shift
  local out
  if out="$(probe "$@" 2>&1)"; then
    echo "FAIL  ${name}: allowed"; fails=$((fails + 1))
  elif grep -q -e AccessDenied -e 'not authorized' <<<"$out"; then
    echo "PASS  ${name}: $(grep -oE 'explicit deny in a [a-z -]+|no [a-z -]+ allows|not authorized to perform: [a-zA-Z:]+' <<<"$out" | sort -u | tr '\n' ';')"
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
expect_allowed "UpdateRoleDescription on a /cell/ role (positive control)" iam update-role-description --role-name cell-spike-positive --description "changed by the q5 probe"
expect_allowed "GetRole on the role pair (read stays open)" iam get-role --role-name cell-spike-role-pair-stand-in --query Role.Path --output text

echo "probes failed: ${fails}"
exit "$fails"
