#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The integration test's demo application, tenant CREATE and UPDATE
# script (spec §10; update.sh runs this one). TEST ONLY.
#
# Writes the tenant's namespace parameter, which the demo cell API's hosts
# check reads (§3.5). With TFD_PROBE set it first calls the registrar as
# the tenant provisioning role and fails unless every call answers 403:
#   step11: PutTenantRoute for itself, for TFD_PROBE_PEER, and for itself
#           with a customDomain (spec §10 step 11)
#   step13: DeleteTenantRoute and PutTenantRoute for itself (step 13)
#
# Environment (control-plane R-42): APPLICATION_ID, TENANT_ID, CELL_ID,
# PARAM_TFD_PROBE, PARAM_TFD_PROBE_PEER, AWS_REGION.
set -euo pipefail

: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${TENANT_ID:?TENANT_ID env var is required}"
# shellcheck source=../lib/registrar.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/registrar.sh"
NAMESPACE="/application-plane/tenants/${TENANT_ID}/${APPLICATION_ID}"

case "${PARAM_TFD_PROBE:-off}" in
  off) ;;
  step11)
    [[ "${PARAM_TFD_PROBE_PEER:-}" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]] || { echo "TFD_PROBE_PEER must be a tenant id"; exit 1; }
    REGISTRAR_URL="$(registrar_url)" || { echo "No registrar URL in this account"; exit 1; }
    probe_expect put-own-route 403 PUT "tenants/${TENANT_ID}" '{}'
    probe_expect put-peer-route 403 PUT "tenants/${PARAM_TFD_PROBE_PEER}" '{}'
    probe_expect put-own-custom-domain 403 PUT "tenants/${TENANT_ID}" '{"customDomain":"dedicated-b.example.com"}'
    probe_finish "${NAMESPACE}/registrar-probe"
    ;;
  step13)
    REGISTRAR_URL="$(registrar_url)" || { echo "No registrar URL in this account"; exit 1; }
    probe_expect delete-own-route 403 DELETE "tenants/${TENANT_ID}"
    probe_expect put-own-route 403 PUT "tenants/${TENANT_ID}" '{}'
    probe_finish "${NAMESPACE}/registrar-probe"
    ;;
  *) echo "Unknown TFD_PROBE value"; exit 1 ;;
esac

aws ssm put-parameter --name "${NAMESPACE}/deployed" --type String --overwrite --value "${CELL_ID:-unknown}" >/dev/null
echo "Wrote ${NAMESPACE}/deployed"
