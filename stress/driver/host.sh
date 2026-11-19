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
#
# A SIGINT or SIGTERM cancels the command on the host, so a k6 run does not keep loading its
# target. The wait ends early, with the reason, when the command fails or times out, when the
# host loses its SSM agent for three minutes (a k6 that ran the host out of memory, finding
# F-14) and when the credentials expire. Reading the output retries an S3 error other than
# NoSuchKey (a throttle, a network blip) for one minute before it gives up, so one transient
# error does not cancel a long k6 run. The limits count wall time.

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
COMMAND_ID=""
DONE=0
cleanup() {
  local code=$?
  set +e
  trap '' INT TERM
  if [[ -n "$COMMAND_ID" && "$DONE" == 0 ]]; then
    if aws ssm cancel-command --command-id "$COMMAND_ID" >/dev/null 2>&1; then
      echo "cancelled the command on the driver host" >&2
    else
      echo "could not cancel command ${COMMAND_ID}; run: aws ssm cancel-command --command-id ${COMMAND_ID}" >&2
    fi
  fi
  rm -f "${TMP}"/*
  rmdir "$TMP"
  aws s3api delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

REMOTE="$(printf 'set +e\n( %s\n) >/tmp/host-%s.out 2>&1\nrc=$?\nprintf "\\nexit=%%s\\n" "$rc" >>/tmp/host-%s.out\naws s3 cp /tmp/host-%s.out s3://%s/%s --quiet\nrm -f /tmp/host-%s.out\n' \
  "$1" "$STAMP" "$STAMP" "$STAMP" "$BUCKET" "$KEY" "$STAMP")"
jq -n --arg c "$REMOTE" --arg t "$TIMEOUT" '{commands: [$c], executionTimeout: [$t]}' >"${TMP}/params.json"
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://${TMP}/params.json" --query Command.CommandId --output text)"

lost=0
finished=0
read_errors=0
DEADLINE=$((SECONDS + TIMEOUT + 60))
while (( SECONDS < DEADLINE )); do
  if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "${TMP}/output.txt" >/dev/null 2>"${TMP}/get.err"; then
    DONE=1
    cat "${TMP}/output.txt"
    code="$(tail -n 1 "${TMP}/output.txt" | sed -n 's/^exit=\([0-9]*\)$/\1/p')"
    exit "${code:-1}"
  fi
  # NoSuchKey is the expected answer until the host has written. Anything else (throttling,
  # a 5xx, a network error) is retried for 12 polls, one minute, before it counts as a failure.
  if grep -q -E 'NoSuchKey|Not Found' "${TMP}/get.err"; then
    read_errors=0
  else
    read_errors=$((read_errors + 1))
    echo "reading the output failed (${read_errors} of 12): $(tail -n 1 "${TMP}/get.err")" >&2
    (( read_errors < 12 )) || { echo "reading the output kept failing for one minute; giving up (command ${COMMAND_ID})" >&2; exit 1; }
  fi
  status="$(aws ssm list-command-invocations --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
    --query 'CommandInvocations[0].Status' --output text 2>/dev/null || echo Unknown)"
  case "$status" in
    Failed | TimedOut | Cancelled | Cancelling | DeliveryTimedOut | ExecutionTimedOut | Undeliverable | Terminated)
      # The host writes its output last, so give it one more read before giving up.
      sleep 5
      if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "${TMP}/output.txt" >/dev/null 2>&1; then
        DONE=1
        cat "${TMP}/output.txt"
        exit 1
      fi
      DONE=1
      echo "the command ended ${status} on the host and wrote no output (command ${COMMAND_ID})" >&2
      exit 1
      ;;
    Success)
      # The command finished but its output is not in the bucket: the host could not upload it.
      # Only while reads answer NoSuchKey: during read errors the read budget decides.
      (( read_errors > 0 )) || finished=$((finished + 1))
      (( finished < 6 )) || { DONE=1; echo "the command succeeded but wrote no output to the results bucket (command ${COMMAND_ID})" >&2; exit 1; }
      ;;
  esac
  ping="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=${INSTANCE}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo Online)"
  if [[ "$ping" == ConnectionLost ]]; then
    (( lost > 0 )) || lost=$SECONDS
    (( SECONDS - lost < 180 )) || { echo "the host lost its SSM agent for 3 minutes (out of memory?); reboot the instance (command ${COMMAND_ID})" >&2; exit 1; }
  else
    lost=0
  fi
  sleep 5
done
echo "no output from the host after ${TIMEOUT} s (command ${COMMAND_ID})" >&2
exit 1
