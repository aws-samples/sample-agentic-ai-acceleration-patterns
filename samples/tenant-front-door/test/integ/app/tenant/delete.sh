#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# The integration test's demo application, tenant DELETE script. TEST ONLY.
# Empties the tenant's namespace, so the cell's hosts check no longer
# hosts the tenant (spec §3.5).
set -euo pipefail
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${TENANT_ID:?TENANT_ID env var is required}"
for name in deployed registrar-probe; do
  aws ssm delete-parameter --name "/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}/${name}" >/dev/null 2>&1 || true
done
echo "Tenant ${TENANT_ID} removed"
