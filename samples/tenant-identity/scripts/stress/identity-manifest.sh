#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The published identity of the stress stack as a manifest, for the slices that read it in
# platform mode (stress/README.md, "Platform mode: manifests"). slice.sh deploy and teardown
# call it:
#
#   identity-manifest.sh write    $STRESS_HOME/$STRESS_PREFIX/identity.json holds the value of
#                                 the SSM parameter /$STRESS_PREFIX/identity (ids and names, no
#                                 secret); written to a temporary file and moved into place, so
#                                 a failed read leaves the file as it was and no temporary one
#   identity-manifest.sh remove   removes the manifest

set -euo pipefail

: "${STRESS_PREFIX:?identity-manifest.sh: STRESS_PREFIX is not set}"
: "${STRESS_HOME:?identity-manifest.sh: STRESS_HOME is not set}"
run_home="${STRESS_HOME}/${STRESS_PREFIX}"
file="${run_home}/identity.json"

case "${1:-}" in
  write)
    mkdir -p -m 700 "$run_home"
    trap 'rm -f "${file}.tmp"' EXIT
    (umask 077 && aws ssm get-parameter --name "/${STRESS_PREFIX}/identity" --query Parameter.Value --output text >"${file}.tmp")
    mv "${file}.tmp" "$file"
    ;;
  remove)
    rm -f "$file" "${file}.tmp"
    ;;
  *)
    echo "usage: identity-manifest.sh write|remove" >&2
    exit 2
    ;;
esac
