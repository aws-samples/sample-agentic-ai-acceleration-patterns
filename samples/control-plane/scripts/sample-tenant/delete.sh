#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample tenant DELETE script.
#
# Runs in AWS CodeBuild with: TENANT_ID, TENANT_NAME, APPLICATION_ID,
# CELL_ID, OPERATION, OPERATOR_ID, PARAM_<NAME> (one per
# deployment parameter the application declares and the deployment has a
# value or default for, ADR-039). Deprovisions the per-tenant deployment.
# Must tolerate partial provisioning - it is also the cleanup path for
# CREATE_FAILED deployments (including deployments whose cell itself failed
# to create), so a missing resource is success, not an error.
# TENANT_NAME is operator-supplied free text: expand it quoted only, never
# eval or use as an identifier (see scripts/CONVENTIONS.md).
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"

echo "Deprovisioning tenant ${TENANT_ID} for application ${APPLICATION_ID}"

if aws ssm get-parameter --name "/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}" > /dev/null 2>&1; then
  aws ssm delete-parameter --name "/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}"
  echo "Tenant ${TENANT_ID} for application ${APPLICATION_ID} deprovisioned"
else
  echo "No deployment found for tenant ${TENANT_ID} and application ${APPLICATION_ID} (partial provisioning) - nothing to clean up"
fi
