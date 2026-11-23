#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Removes the observability sink of the run dashboard (stress ADR-0022) from the platform account.
# Remove every cell account's link first (deploy `CellAccountBase` again without
# OBSERVABILITY_SINK_ARN, or remove the account base): a sink with a link cannot be deleted, and a
# link left without its sink is dangling. The script refuses while a link is attached.
#
#   AWS_REGION=<the run's Region> stress/dashboard/remove-sink.sh

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region of the run}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

echo "account=$(aws sts get-caller-identity --query Account --output text) region=${AWS_REGION}"
sink="$(aws oam list-sinks --query "Items[?Name=='StressRunSink'].Arn | [0]" --output text)"
if [[ -n "$sink" && "$sink" != None ]]; then
  links="$(aws oam list-attached-links --sink-identifier "$sink" --query 'length(Items)' --output text)"
  if [[ "$links" != 0 ]]; then
    echo "the sink still has ${links} attached link(s): remove the cell accounts' links first" >&2
    exit 1
  fi
fi
start=$SECONDS
aws cloudformation delete-stack --stack-name StressRunSink
aws cloudformation wait stack-delete-complete --stack-name StressRunSink
echo "stack=StressRunSink destroy_seconds=$((SECONDS - start))"
left="$(aws oam list-sinks --query "Items[?Name=='StressRunSink'].Arn | [0]" --output text)"
[[ -z "$left" || "$left" == None ]] || { echo "leftover: the sink ${left} is still there" >&2; exit 1; }
echo "leftovers: none"
