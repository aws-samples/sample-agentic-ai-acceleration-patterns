#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The integration test's demo application, cell CREATE and UPDATE script
# (spec §10; update.sh runs this one). TEST ONLY.
#
# The cell's origin, a demo cell API, is deployed by the test ahead of the
# cell, one per account, and publishes its function URL host in this
# account. The script names it as its frontDoorApiDomain output (§5.2),
# which the front door's route hook sends to the registrar. It writes no
# output when the cell parameter FRONT_DOOR_OUTPUT is `off` (step 21).
# With TFD_CELL_PROBE `step12` it first calls the registrar's DeleteCellRoute,
# as the cell provisioning role, for its own cell and for TFD_CELL_PROBE_PEER,
# and fails unless both answer 403 (step 12).
#
# Environment (control-plane R-42): APPLICATION_ID, CELL_ID, OPERATION,
# OUTPUTS_FILE, PARAM_FRONT_DOOR_OUTPUT, PARAM_TFD_CELL_PROBE,
# PARAM_TFD_CELL_PROBE_PEER, AWS_REGION.
set -euo pipefail

: "${APPLICATION_ID:?APPLICATION_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${OUTPUTS_FILE:?OUTPUTS_FILE env var is required}"
# shellcheck source=../shared/registrar.sh
source "$(dirname "${BASH_SOURCE[0]}")/../shared/registrar.sh"

if [[ "${PARAM_TFD_CELL_PROBE:-off}" == step12 ]]; then
  [[ "${PARAM_TFD_CELL_PROBE_PEER:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "TFD_CELL_PROBE_PEER must be a cell id"; exit 1; }
  REGISTRAR_URL="$(registrar_url)" || { echo "No registrar URL in this account"; exit 1; }
  probe_expect delete-own-cell 403 DELETE "cells/${CELL_ID}"
  probe_expect delete-peer-cell 403 DELETE "cells/${PARAM_TFD_CELL_PROBE_PEER}"
  probe_finish "/application-plane/cells/${CELL_ID}/registrar-probe"
fi

if [[ "${PARAM_FRONT_DOOR_OUTPUT:-on}" == off ]]; then
  echo "FRONT_DOOR_OUTPUT is off: writing no frontDoorApiDomain"
  exit 0
fi
DOMAIN="$(aws ssm get-parameter --name "/application-plane/applications/${APPLICATION_ID}/shared/front-door-cell-api" --query Parameter.Value --output text)"
[[ "$DOMAIN" =~ ^[a-z0-9]{32}\.lambda-url\.[a-z0-9-]+\.on\.aws$ ]] || { echo "The cell API parameter is not a function URL host"; exit 1; }
jq -nc --arg d "$DOMAIN" '{frontDoorApiDomain: $d}' >"$OUTPUTS_FILE"
echo "Wrote frontDoorApiDomain for cell ${CELL_ID}"
