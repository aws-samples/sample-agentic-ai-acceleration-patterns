#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Test-only tenant script (test/integ.session-tags.ts, ADR-0051). It runs
# under the inline tenant buildspec, as the tenant provisioning role's session
# tagged with CellId, TenantId and ApplicationId, and records what that
# session may do in the tenant and cell namespaces. It cleans up what it wrote
# and always exits 0; the test compares the recorded results.
#
# Environment: CELL_ID, TENANT_ID, APPLICATION_ID (as the workflow sets them),
# PEER_CELL_ID, PEER_TENANT_ID, PEER_APPLICATION_ID.
set -uo pipefail
source "$(dirname "$0")/probe-lib.sh"

own="/application-plane/tenants/$TENANT_ID/$APPLICATION_ID"
put() { aws ssm put-parameter --name "$1" --type String --value probe --overwrite; }

probe ownDeploymentWrite put "$own"
probe ownStateWrite put "$own/state"
probe otherApplicationWrite put "/application-plane/tenants/$TENANT_ID/$PEER_APPLICATION_ID"
probe otherTenantWrite put "/application-plane/tenants/$PEER_TENANT_ID/$APPLICATION_ID"
probe ownCellRead aws ssm get-parameters-by-path --path "/application-plane/cells/$CELL_ID"
probe peerCellRead aws ssm get-parameters-by-path --path "/application-plane/cells/$PEER_CELL_ID"
probe ownCellWrite put "/application-plane/cells/$CELL_ID/tenant-probe"
probe ownStateDelete aws ssm delete-parameter --name "$own/state"
probe ownDeploymentDelete aws ssm delete-parameter --name "$own"
# Writes that should have been refused are removed again (best effort), so a regression leaves nothing in the account.
if [ "${RESULTS[otherApplicationWrite]}" = allowed ]; then aws ssm delete-parameter --name "/application-plane/tenants/$TENANT_ID/$PEER_APPLICATION_ID" || true; fi
if [ "${RESULTS[otherTenantWrite]}" = allowed ]; then aws ssm delete-parameter --name "/application-plane/tenants/$PEER_TENANT_ID/$APPLICATION_ID" || true; fi
if [ "${RESULTS[ownCellWrite]}" = allowed ]; then aws ssm delete-parameter --name "/application-plane/cells/$CELL_ID/tenant-probe" || true; fi
write_results
