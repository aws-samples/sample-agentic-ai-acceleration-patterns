#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The integration test's third global hook, tfd-probe (spec §10 step 20).
# TEST ONLY. Registered as POST on CELL_UPDATE and DEPLOYMENT_UPDATE, its id
# sorts after front-door-post, so it runs after it (control-plane R-45).
# It calls the registrar under the global hook role outside the operation
# the role is in, and exits 0 only when every answer is the expected one:
#
#   DEPLOYMENT_UPDATE  DeleteTenantRoute for the tenant (record UPDATING): 409
#                      PutCellRoute for the cell (record ACTIVE): 409
#   CELL_UPDATE        PutCellRoute with another function URL host: 409
#                      PutCellRoute with a host outside that form: 400
#
# It acts only for an application with a front door hook parameter.
# Environment (control-plane R-42): EVENT, PHASE, HOOK_SCOPE, APPLICATION_ID,
# CELL_ID, TENANT_ID, AWS_REGION.
set -euo pipefail

: "${EVENT:?EVENT env var is required}"
: "${PHASE:?PHASE env var is required}"
: "${HOOK_SCOPE:?HOOK_SCOPE env var is required}"
: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${AWS_REGION:?AWS_REGION env var is required}"
[[ "$PHASE $HOOK_SCOPE" == 'POST GLOBAL' ]] || { echo "tfd-probe is a global POST hook, got ${PHASE} ${HOOK_SCOPE}"; exit 1; }
# shellcheck source=../app/shared/registrar.sh
source "$(dirname "${BASH_SOURCE[0]}")/../app/shared/registrar.sh"

if ! err="$(aws ssm get-parameter --name "/application-plane/applications/${APPLICATION_ID}/shared/front-door-hook" --query Parameter.Value --output text 2>&1 >/dev/null)"; then
  if [[ "$err" == *ParameterNotFound* ]]; then
    echo "tfd-probe: ${APPLICATION_ID} has no front door"
    exit 0
  fi
  echo "tfd-probe: the hook parameter could not be read"
  exit 1
fi
REGISTRAR_URL="$(registrar_url)" || { echo "tfd-probe: the hook parameter names no registrar"; exit 1; }

# Function URL hosts in this Region that no cell has: 32 characters of [a-z0-9].
OTHER_HOST="$(printf 'tfdprobe%024d' 0).lambda-url.${AWS_REGION}.on.aws"
case "$EVENT" in
  DEPLOYMENT_UPDATE)
    : "${TENANT_ID:?TENANT_ID env var is required}"
    probe_expect delete-tenant-route-while-updating 409 DELETE "tenants/${TENANT_ID}"
    probe_expect put-cell-route-while-active 409 PUT "cells/${CELL_ID}" "$(jq -nc --arg d "$OTHER_HOST" '{apiDomain: $d}')"
    ;;
  CELL_UPDATE)
    probe_expect put-cell-route-other-origin 409 PUT "cells/${CELL_ID}" "$(jq -nc --arg d "$OTHER_HOST" '{apiDomain: $d}')"
    probe_expect put-cell-route-not-a-function-url 400 PUT "cells/${CELL_ID}" '{"apiDomain":"origin.example.com"}'
    ;;
  *) echo "tfd-probe runs on CELL_UPDATE and DEPLOYMENT_UPDATE, got ${EVENT}"; exit 1 ;;
esac
echo "tfd-probe: answers ${PROBE_RESULTS}"
if (( PROBE_FAILS > 0 )); then
  echo "tfd-probe: ${PROBE_FAILS} answer(s) differ"
  exit 1
fi
