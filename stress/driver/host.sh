#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runs one shell command on the stress driver host and prints its output (stress ADR-0007).
# Also the way to check a deployed host: `host.sh 'k6 version'`.
#
#   AWS_REGION=eu-central-1 STRESS_PREFIX=<prefix> [HOST_TIMEOUT=600] stress/driver/host.sh '<command>'
#
# The command runs through Systems Manager Run Command (AWS-RunShellScript). The host writes
# its stdout and stderr, then `exit=<code>`, to the results bucket under host/<timestamp>/,
# and this script reads that object, removes it and exits with that code: the command's output
# is read from S3, not from the Run Command API. Nothing opens an inbound path to the host.
# The instance and the bucket come from the outputs of <prefix>-driver. HOST_TIMEOUT is the
# command's limit in seconds (default 600, at most 14400).

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region the driver stack is in}"
: "${STRESS_PREFIX:?Set STRESS_PREFIX to the prefix the driver was deployed with}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
[[ $# -eq 1 && -n "$1" ]] || { echo "usage: stress/driver/host.sh '<command>'" >&2; exit 2; }

STACK="${STRESS_PREFIX}-driver"
OUTPUTS="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)" \
  || { echo "no stack ${STACK}; run stress/driver/deploy.sh first" >&2; exit 1; }
INSTANCE="$(jq -r '.[] | select(.OutputKey == "InstanceId") | .OutputValue' <<<"$OUTPUTS")"
BUCKET="$(jq -r '.[] | select(.OutputKey == "ResultsBucketName") | .OutputValue' <<<"$OUTPUTS")"
[[ -n "$INSTANCE" && -n "$BUCKET" ]] || { echo "${STACK} lacks InstanceId or ResultsBucketName" >&2; exit 1; }

TIMEOUT="${HOST_TIMEOUT:-600}"
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && (( TIMEOUT >= 10 && TIMEOUT <= 14400 )) || { echo "HOST_TIMEOUT must be 10 to 14400 seconds" >&2; exit 2; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
KEY="host/${STAMP}/output.txt"
TMP="$(mktemp -d)"
trap 'rm -f "${TMP}"/* ; rmdir "$TMP"; aws s3api delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1 || true' EXIT

REMOTE="$(printf 'set +e\n( %s ) >/tmp/host-%s.out 2>&1\necho "exit=$?" >>/tmp/host-%s.out\naws s3 cp /tmp/host-%s.out s3://%s/%s --quiet\nrm -f /tmp/host-%s.out\n' \
  "$1" "$STAMP" "$STAMP" "$STAMP" "$BUCKET" "$KEY" "$STAMP")"
jq -n --arg c "$REMOTE" --arg t "$TIMEOUT" '{commands: [$c], executionTimeout: [$t]}' >"${TMP}/params.json"
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://${TMP}/params.json" --query Command.CommandId --output text)"

for _ in $(seq 1 $((TIMEOUT / 5 + 12))); do
  if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "${TMP}/output.txt" >/dev/null 2>&1; then
    cat "${TMP}/output.txt"
    code="$(tail -n 1 "${TMP}/output.txt" | sed -n 's/^exit=\([0-9]*\)$/\1/p')"
    exit "${code:-1}"
  fi
  sleep 5
done
echo "no output from the host after ${TIMEOUT} s (command ${COMMAND_ID})" >&2
exit 1
