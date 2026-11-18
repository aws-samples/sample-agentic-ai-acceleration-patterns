#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The platform stress test runner (docs/stress-test.spec.md §3.5).
#   ./run.sh check
#   ./run.sh plan --tier small --slices tenant-identity,control-plane
#   ./run.sh run  --tier small --slices agentic-runtime-isolation [--scenarios S1] [--limits limits.json]
# Builds the contract on first use.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "${here}/lib/cli.js" ]]; then
  (cd "$here" && npm ci --silent && npx projen compile >/dev/null)
fi
exec node "${here}/lib/cli.js" "$@"
