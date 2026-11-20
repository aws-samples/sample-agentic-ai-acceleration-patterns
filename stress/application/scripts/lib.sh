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

# One SigV4-signed call to an execute-api URL with the role's credentials:
#   sigv4 <method> <url> <response file> [<JSON body>]
# Prints the HTTP status. The credentials go to curl in a 0600 config file, never in argv.
sigv4() {
  local method="$1" url="$2" out="$3" body="${4:-}" cfg status
  cfg="$(mktemp)"
  chmod 600 "$cfg"
  {
    printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
    printf 'header = "x-amz-security-token: %s"\n' "$AWS_SESSION_TOKEN"
  } > "$cfg"
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" -K "$cfg" --max-time 30)
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  status="$(curl "${args[@]}" "$url" || echo 000)"
  rm -f "$cfg"
  echo "$status"
}
