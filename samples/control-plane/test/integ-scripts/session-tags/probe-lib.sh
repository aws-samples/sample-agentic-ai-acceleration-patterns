#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Test-only helpers for the session tag integration test
# (test/integ.session-tags.ts, ADR-0051). A probe runs one AWS CLI call and
# records `allowed`, `refused` (an AccessDenied answer) or `error:<code>` (any
# other answer) under its name, and the error code under `<name>_code`. The results
# go to OUTPUTS_FILE as one JSON object, which the build exports as
# SCRIPT_OUTPUTS. Output of a successful call is discarded, so no credentials
# reach the build log.

declare -A RESULTS=()

probe() {
  local name=$1 err code
  shift
  if err=$("$@" 2>&1 >/dev/null); then
    RESULTS[$name]=allowed
  else
    code=$(printf '%s' "$err" | sed -n 's/.*An error occurred (\([A-Za-z]*\)).*/\1/p' | head -n 1)
    case "$code" in
      AccessDenied*) RESULTS[$name]=refused ;;
      *) RESULTS[$name]="error:${code:-none}" ;;
    esac
    RESULTS[${name}_code]=${code:-none}
  fi
  # The first line of an error names the action and resource, never a credential.
  echo "$name: ${RESULTS[$name]} $(printf '%s\n' "${err:-}" | grep -m 1 . || true)"
}

write_results() {
  local key
  for key in "${!RESULTS[@]}"; do
    printf '%s\t%s\n' "$key" "${RESULTS[$key]}"
  done | jq -R -n '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}' > "$OUTPUTS_FILE"
}
