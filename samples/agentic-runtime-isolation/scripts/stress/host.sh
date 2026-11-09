#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress test, a debugging aid: run one shell command on the driver host
# (design/agentic-runtime-isolation.stress-test.md §8.1) and print its output.
#
#   AWS_REGION=eu-central-1 [STRESS_PREFIX=RuntimeIsolationStress] scripts/stress/host.sh '<command>'
#
# The command runs through Systems Manager Run Command (AWS-RunShellScript);
# its stdout and stderr land in the results bucket under
# host/<timestamp>/, which this script downloads and prints, then deletes.
# Nothing opens an inbound path to the host. Conventions: scripts/CONVENTIONS.md.

set -euo pipefail

REGION="${AWS_REGION:-}"
: "${REGION:?Set AWS_REGION to the Region the stacks are deployed in}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
for tool in aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
[[ $# -eq 1 && -n "$1" ]] || { echo "usage: scripts/stress/host.sh '<command>'" >&2; exit 2; }

PREFIX="${STRESS_PREFIX:-RuntimeIsolationStress}"
OUTPUTS="${HOME}/.runtime-isolation-stress/${PREFIX}/outputs.json"
[[ -f "$OUTPUTS" ]] || { echo "no ${OUTPUTS}; run scripts/stress/deploy.sh first" >&2; exit 1; }
INSTANCE="$(jq -r '.InstanceId // empty' "$OUTPUTS")"
BUCKET="$(jq -r '.ResultsBucketName // empty' "$OUTPUTS")"
[[ -n "$INSTANCE" && -n "$BUCKET" ]] || { echo "outputs.json lacks InstanceId or ResultsBucketName" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
KEY_PREFIX="host/${STAMP}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; aws s3 rm "s3://${BUCKET}/${KEY_PREFIX}/" --recursive --quiet >/dev/null 2>&1 || true' EXIT

# The remote script writes its own output to the bucket: the command's
# result is read from S3, not from the Run Command API.
REMOTE="$(printf 'set +e\n( %s ) >/tmp/host-%s.out 2>&1\necho "exit=$?" >>/tmp/host-%s.out\naws s3 cp /tmp/host-%s.out s3://%s/%s/output.txt --quiet\nrm -f /tmp/host-%s.out\n' \
  "$1" "$STAMP" "$STAMP" "$STAMP" "$BUCKET" "$KEY_PREFIX" "$STAMP")"
jq -n --arg c "$REMOTE" '{commands: [$c], executionTimeout: ["600"]}' >"${TMP}/params.json"
aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://${TMP}/params.json" --query Command.CommandId --output text >"${TMP}/command-id"

for _ in $(seq 1 120); do
  if aws s3 cp "s3://${BUCKET}/${KEY_PREFIX}/output.txt" "${TMP}/output.txt" --quiet >/dev/null 2>&1; then
    cat "${TMP}/output.txt"
    exit 0
  fi
  sleep 5
done
echo "no output from the host after 600 s (command $(cat "${TMP}/command-id"))" >&2
exit 1
