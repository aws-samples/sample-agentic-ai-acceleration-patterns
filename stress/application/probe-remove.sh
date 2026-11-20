#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Removes the two probe stacks probe-deploy.sh created, and nothing else: CellWorkloadProbe
# (through its own service role, the cell execution role) and CellBoundaryProbe, each only
# when it carries the stack tag stress:part=cell-policy-probe. It removes the probes' control
# function if an interrupted run left it, then lists anything else a probe could have left
# if a policy had let it through, and exits 1 when it finds any. It deletes none of those:
# that is a policy regression to look at first.
#
#   AWS_REGION=eu-central-1 stress/application/probe-remove.sh

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the cell account Region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
command -v aws >/dev/null 2>&1 || { echo "Missing required tool: aws" >&2; exit 1; }
account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "no caller account" >&2; exit 1; }
echo "account=${account} region=${AWS_REGION}"

if aws lambda get-function --function-name cell-policy-probe-fn >/dev/null 2>&1; then
  aws lambda delete-function --function-name cell-policy-probe-fn
  echo "removed the control function cell-policy-probe-fn"
fi

failed=0
for stack in CellWorkloadProbe CellBoundaryProbe; do
  if ! out="$(aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Tags[?Key=='stress:part'].Value | [0]" --output text 2>&1)"; then
    if grep -q 'does not exist' <<<"$out"; then
      echo "stack=${stack} absent"
      continue
    fi
    echo "could not read ${stack}: ${out}" >&2
    exit 1
  fi
  tag="$out"
  [[ "$tag" == cell-policy-probe ]] || { echo "${stack} is not a probe stack (stress:part=${tag}); left alone" >&2; exit 1; }
  start=$SECONDS
  # A failed delete still runs the leftover listing below, so nothing a probe left goes unseen.
  if aws cloudformation delete-stack --stack-name "$stack" && aws cloudformation wait stack-delete-complete --stack-name "$stack"; then
    echo "stack=${stack} destroy_seconds=$((SECONDS - start))"
  else
    echo "stack=${stack} delete failed; listing leftovers anyway" >&2
    failed=1
  fi
done

# What a let-through probe could have created.
left=()
add() { [[ -z "$2" || "$2" == None ]] || left+=("$1: $2"); }
add roles "$(aws iam list-roles --query "Roles[?starts_with(RoleName, 'cell-policy-probe') || starts_with(RoleName, 'cell-probe-')].Arn" --output text)"
add users "$(aws iam list-users --query "Users[?starts_with(UserName, 'cell-policy-probe')].UserName" --output text)"
add policies "$(aws iam list-policies --scope Local --query "Policies[?starts_with(PolicyName, 'cell-policy-probe')].Arn" --output text)"
add functions "$(aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'cell-policy-probe')].FunctionName" --output text)"
add parameters "$(aws ssm get-parameters --names /application-plane/shared/identity/cell-policy-probe /cdk-bootstrap/cell/cell-policy-probe --query 'Parameters[].Name' --output text)"
add "logs resource policies" "$(aws logs describe-resource-policies --query "resourcePolicies[?policyName=='cell-policy-probe'].policyName" --output text)"
add "logs destinations" "$(aws logs describe-destinations --destination-name-prefix cell-policy-probe --query 'destinations[].destinationName' --output text)"
# The other-service-linked-role probe aims at Elastic Load Balancing, which a cell account
# never uses, so its service-linked role there can only come from a let-through probe.
add "service-linked roles" "$(aws iam list-roles --path-prefix /aws-service-role/elasticloadbalancing.amazonaws.com/ --query 'Roles[].RoleName' --output text)"
if (( ${#left[@]} > 0 )); then
  printf 'left by a probe a policy let through:\n' >&2
  printf '  %s\n' "${left[@]}" >&2
  exit 1
fi
(( failed == 0 )) || exit 1
echo "no probe leftovers"
