#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application cell UPDATE script: the same deploy as create.sh, which `cdk deploy`
# makes idempotent (an unchanged cell is a no-op change set).
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/create.sh"
