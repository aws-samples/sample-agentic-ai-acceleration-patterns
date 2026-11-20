#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runs the runner's Linux tests (runner/tests/test_linux.py) as root in
# privileged containers on an x86_64 Docker host: the uid drop, rlimits,
# seccomp filters (the x86_64 tables), the SysV, /tmp and /dev/shm sweep,
# zombie reaping, the nitro watchdog, the agentcore job cgroup and the
# runner entry per backend. Each test class gets a fresh container.
#
# Two images: the runner image built from runner/Dockerfile (Python 3.13,
# the nitro and agentcore image), and the AL2023 minimal image with the
# python3 package version runner/microvm/Dockerfile pins (Python 3.9, as
# on microvm). No AWS call. Usage: scripts/test-runner-docker.sh
set -euo pipefail

command -v docker >/dev/null || { echo "docker not found" >&2; exit 2; }
[ "$(uname -m)" = "x86_64" ] || { echo "this script runs the x86_64 tables only" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$here/runner"
image="runner-linux-test:$$"
al2023="public.ecr.aws/amazonlinux/amazonlinux:2023-minimal"
python_pkg="$(sed -n 's/^RUN dnf install -y \(python3-[^ ]*\) .*/\1/p' "$runner/microvm/Dockerfile")"
[ -n "$python_pkg" ] || { echo "no python3 pin in runner/microvm/Dockerfile" >&2; exit 2; }

cleanup() { docker rmi -f "$image" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "build runner/Dockerfile for linux/amd64"
docker build --quiet --platform linux/amd64 -t "$image" "$runner" >/dev/null

failed=0
# run_in LABEL DOCKER_RUN_ARGS...: one fresh privileged container.
run_in() {
  local label="$1"
  shift
  echo "== $label"
  if ! docker run --rm --privileged --cgroupns private --memory 2g --platform linux/amd64 \
      -v "$runner:/src/runner:ro" -w /src -e RUNNER_LINUX_TESTS=1 -e RUNNER_TEST_UID=61001 "$@" 2>&1 | sed 's/^/  /'; then
    echo "FAILED: $label"
    failed=1
  fi
}

for cls in MicrovmLinux NitroLinux AgentcoreLinux AgentcoreEntryLinux; do
  run_in "python 3.13 $cls" --entrypoint python3 "$image" -B -m unittest -v "runner.tests.test_linux.$cls"
done
for cls in MicrovmLinux MicrovmEntryLinux; do
  run_in "python 3.9 ($python_pkg) $cls" -e RUNNER_ENTRY=/src/runner/runner.py "$al2023" \
    sh -c "dnf install -y $python_pkg >/dev/null && python3 -B -m unittest -v runner.tests.test_linux.$cls"
done
run_in "python 3.9 ($python_pkg) unit tests" -e RUNNER_LINUX_TESTS=0 "$al2023" \
  sh -c "dnf install -y $python_pkg >/dev/null && python3 -B -m unittest discover -s runner/tests -t ."
exit "$failed"
