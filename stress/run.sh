#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The platform stress test runner (docs/stress-test.spec.md §3.5).
#   ./run.sh check
#   ./run.sh tier small
#   ./run.sh plan --tier small --slices tenant-identity,control-plane
#   ./run.sh run  --tier small --slices agentic-runtime-isolation [--scenarios S1] [--limits limits.json]
#                 [--dashboard | --no-dashboard] [--keep-dashboard]
#   ./run.sh emit <metric> <value> [Dimension=value ...]   (a slice's script; needs STRESS_METRICS=1)
#   ./run.sh dashboard up|snapshot|down --run <run id>      (stress/dashboard/README.md)
# Installs once and compiles on every call (incremental), so it never runs a stale build.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d "${here}/node_modules" ]] || (cd "$here" && npm ci --silent)
(cd "$here" && npx tsc --build >&2)
exec node "${here}/lib/cli.js" "$@"
