#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Stress application tenant UPDATE script: the same writes as create.sh, both of which
# replace what they wrote before (PutTenantSubscription bumps the version).
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/create.sh"
