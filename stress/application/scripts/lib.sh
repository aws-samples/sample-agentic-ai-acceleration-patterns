#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared helpers of the stress application's cell and tenant scripts (README, "The stress
# application"). Sourced, never run. The scripts run in the control plane's CodeBuild
# projects under the cell account's role pair (samples/control-plane/scripts/CONVENTIONS.md):
# they log names and ids only, never a parameter value, a URL they read, or a credential.

STRESS_APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${STRESS_APP_DIR}/../.." && pwd)"
SAMPLE_DIR="${REPO_ROOT}/samples/agentic-runtime-isolation"
export STRESS_APP_DIR REPO_ROOT SAMPLE_DIR

# The cell's parameter namespace in the cell account (control-plane spec §6.2).
cell_param() { printf '/application-plane/cells/%s/%s' "$CELL_ID" "$1"; }

# The runtime-isolation sample wants Node.js 24. The build image may ship an older one; `n`
# (in the CodeBuild standard images) installs 24 when it is missing.
ensure_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 24 ]; then
    command -v n > /dev/null 2>&1 || { echo "Node.js ${major} found, 24 needed, and no n to install it"; return 1; }
    n 24 > /dev/null
    hash -r
  fi
  echo "node $(node -p process.versions.node)"
}

# Installs the runtime-isolation sample's dependencies, the only package the cell app loads.
install_sample() {
  local start=$SECONDS
  (cd "$SAMPLE_DIR" && npm ci --no-audit --no-fund --loglevel=error > /dev/null)
  echo "cell_install_seconds=$((SECONDS - start))"
}

# The demo cell API (tenant-front-door) is bundled by the CDK with `npx --no-install esbuild`
# in that sample's folder (cell-app.ts), where nothing is installed: link its `node_modules`
# to the runtime-isolation sample's, so esbuild and every import of the bundle (jose, the SDK
# clients) resolve in the one install. A cell build checks the source out fresh, so there is
# nothing there yet; any other `node_modules` there is refused.
link_front_door_modules() {
  local link="${REPO_ROOT}/samples/tenant-front-door/node_modules"
  if [ -e "$link" ]; then
    [ "$(realpath "$link")" = "$(realpath "${SAMPLE_DIR}/node_modules")" ] && return 0
    echo "${link} exists and is not the runtime-isolation install: refusing" >&2
    return 1
  fi
  ln -s "${SAMPLE_DIR}/node_modules" "$link"
}

get_param() {
  aws ssm get-parameter --name "$1" --query Parameter.Value --output text
}

put_param() {
  aws ssm put-parameter --name "$1" --type String --overwrite --value "$2" > /dev/null
  echo "Wrote $1"
}

# Deletes a parameter; one that is already gone is not an error.
delete_param() {
  local err
  if err="$(aws ssm delete-parameter --name "$1" 2>&1 > /dev/null)"; then
    echo "Deleted $1"
  elif grep -q ParameterNotFound <<< "$err"; then
    echo "Already gone: $1"
  else
    echo "Could not delete $1"
    return 1
  fi
}

# Peak memory of the build container so far, in MiB, from the cgroup (spec Q-1), or `-`.
peak_memory_mib() {
  local f
  for f in /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes; do
    if [ -r "$f" ]; then
      echo $(($(cat "$f") / 1048576))
      return 0
    fi
  done
  echo -
}

# True when the URL is an execute-api URL in this Region: the only host a tenant script
# signs to, whatever the cell parameter holds.
#   execute_api_url_ok <url>
execute_api_url_ok() {
  [[ "$1" =~ ^https://[a-z0-9]{10}\.execute-api\.${AWS_REGION}\.amazonaws\.com/[A-Za-z0-9._/-]*$ ]]
}

# One SigV4-signed call to an execute-api URL with the role's credentials:
#   sigv4 <method> <url> <response file> [<JSON body>]
# Prints the HTTP status (000 when it refused to sign or curl failed). The credentials reach
# curl as a config on its stdin (`-K -`), never in argv and never on disk.
sigv4() {
  local method="$1" url="$2" out="$3" body="${4:-}" status
  if ! execute_api_url_ok "$url"; then
    echo "refusing to sign to a URL that is not an execute-api URL in ${AWS_REGION}" >&2
    echo 000
    return 0
  fi
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" -K - --max-time 30)
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  status="$(printf 'user = "%s:%s"\nheader = "x-amz-security-token: %s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" \
    | curl "${args[@]}" "$url")" || true
  echo "${status:-000}"
}
