#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Removes the two probe stacks probe-deploy.sh created, and nothing else: CellWorkloadProbe
# (through its own service role, the cell execution role) and CellBoundaryProbe. Then checks
# that no probe role is left on /cell/.
#
#   AWS_REGION=eu-central-1 stress/application/probe-remove.sh

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
account="$(aws sts get-caller-identity --query Account --output text)"
echo "account=${account} region=${AWS_REGION}"

for stack in CellWorkloadProbe CellBoundaryProbe; do
  tag="$(aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Tags[?Key=='stress:part'].Value | [0]" --output text 2>/dev/null || true)"
  if [[ -z "$tag" || "$tag" == None ]]; then
    echo "stack=${stack} absent"
    continue
  fi
  [[ "$tag" == cell-policy-probe ]] || { echo "${stack} is not a probe stack (stress:part=${tag}); left alone" >&2; exit 1; }
  start=$SECONDS
  aws cloudformation delete-stack --stack-name "$stack"
  aws cloudformation wait stack-delete-complete --stack-name "$stack"
  echo "stack=${stack} destroy_seconds=$((SECONDS - start))"
done

left="$(aws iam list-roles --path-prefix /cell/ --query "Roles[?starts_with(RoleName, 'cell-policy-probe')].RoleName" --output text)"
if [[ -n "$left" ]]; then
  echo "probe roles left on /cell/: ${left}" >&2
  exit 1
fi
echo "no probe role left"
