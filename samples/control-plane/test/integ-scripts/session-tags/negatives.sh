#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Test-only probe (test/integ.session-tags.ts, ADR-0051). It runs in a
# provisioning project under a test buildspec that does NOT assume the pair,
# so it holds the BUILD role's own credentials, and asks the pair's trust for
# AssumeRole calls a correct build never makes: no tags, tags not transitive,
# another key, a missing key, no external id. The last call is the correct
# one, the positive control. Always exits 0; the test compares the results.
#
# Environment: KIND (cell or tenant), PROVISIONING_ROLE_ARN,
# PROVISIONING_EXTERNAL_ID, CELL_ID, TENANT_ID, APPLICATION_ID.
set -uo pipefail
source "$(dirname "$0")/probe-lib.sh"

assume() { aws sts assume-role --role-arn "$PROVISIONING_ROLE_ARN" --role-session-name integ-probe "$@"; }
ext=(--external-id "$PROVISIONING_EXTERNAL_ID")
cell_tag="Key=CellId,Value=$CELL_ID"
tenant_tags=("$cell_tag" "Key=TenantId,Value=$TENANT_ID" "Key=ApplicationId,Value=$APPLICATION_ID")

probe untagged assume "${ext[@]}"
if [ "$KIND" = cell ]; then
  probe notTransitive assume "${ext[@]}" --tags "$cell_tag"
  probe extraKey assume "${ext[@]}" --tags "$cell_tag" "Key=Other,Value=x" --transitive-tag-keys CellId Other
  probe extraKeyNotTransitive assume "${ext[@]}" --tags "$cell_tag" "Key=Other,Value=x" --transitive-tag-keys CellId
  probe tenantTags assume "${ext[@]}" --tags "${tenant_tags[@]}" --transitive-tag-keys CellId TenantId ApplicationId
  probe noExternalId assume --tags "$cell_tag" --transitive-tag-keys CellId
  probe tagged assume "${ext[@]}" --tags "$cell_tag" --transitive-tag-keys CellId
else
  probe cellTagOnly assume "${ext[@]}" --tags "$cell_tag" --transitive-tag-keys CellId
  probe missingTenantId assume "${ext[@]}" --tags "$cell_tag" "Key=ApplicationId,Value=$APPLICATION_ID" --transitive-tag-keys CellId ApplicationId
  probe notTransitive assume "${ext[@]}" --tags "${tenant_tags[@]}"
  probe cellTransitiveOnly assume "${ext[@]}" --tags "${tenant_tags[@]}" --transitive-tag-keys CellId
  probe noExternalId assume --tags "${tenant_tags[@]}" --transitive-tag-keys CellId TenantId ApplicationId
  probe tagged assume "${ext[@]}" --tags "${tenant_tags[@]}" --transitive-tag-keys CellId TenantId ApplicationId
fi
write_results
