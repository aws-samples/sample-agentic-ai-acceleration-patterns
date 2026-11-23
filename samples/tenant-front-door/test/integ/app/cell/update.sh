#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# The integration test's demo application, cell UPDATE script: the create
# script, which reads OPERATION for nothing and does the same (spec §10).
# TEST ONLY.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/create.sh"
