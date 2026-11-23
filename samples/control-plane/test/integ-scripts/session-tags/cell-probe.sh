#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Test-only cell script (test/integ.session-tags.ts, ADR-0051). It runs under
# the inline cell buildspec, as the cell provisioning role's session tagged
# with CellId, and records what that session may do: its own cell namespace,
# another cell's, a tenant namespace, the shared namespace, and two roles it
# chains into. It cleans up what it wrote and always exits 0; the test
# compares the recorded results.
#
# Environment (from the test's StartBuild): CELL_ID, PEER_CELL_ID,
# PEER_TENANT_ID, APPLICATION_ID, FLEET_NAME, CHAIN_ROLE_ARN (the caller may
# only sts:AssumeRole it), CHAIN_TAGGED_ROLE_ARN (the caller may also
# sts:TagSession it).
set -uo pipefail
source "$(dirname "$0")/probe-lib.sh"

own="/application-plane/cells/$CELL_ID"
peer="/application-plane/cells/$PEER_CELL_ID"
ledger="/cp-integ/$FLEET_NAME/chain"
put() { aws ssm put-parameter --name "$1" --type String --value probe --overwrite; }

probe ownCellWrite put "$own/probe"
probe ownCellRead aws ssm get-parameters-by-path --path "$own"
probe peerCellWrite put "$peer/probe"
probe peerCellRead aws ssm get-parameters-by-path --path "$peer"
probe tenantWrite put "/application-plane/tenants/$PEER_TENANT_ID/$APPLICATION_ID"
# GetParameters answers a missing name in InvalidParameters, not an error.
probe sharedRead aws ssm get-parameters --names /application-plane/shared/probe

# Chaining with the inherited transitive tag needs sts:TagSession on the
# caller too: the caller holds only sts:AssumeRole on this role.
probe chainAssume aws sts assume-role --role-arn "$CHAIN_ROLE_ARN" --role-session-name integ-chain

# Transitivity: the chained role may write only under its session's CellId.
if creds=$(aws sts assume-role --role-arn "$CHAIN_TAGGED_ROLE_ARN" --role-session-name integ-chain \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null); then
  RESULTS[chainTaggedAssume]=allowed
  read -r key secret token <<< "$creds"
  as_chain() { env AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token" "$@"; }
  probe chainOwnWrite as_chain aws ssm put-parameter --name "$ledger/$CELL_ID" --type String --value probe --overwrite
  probe chainPeerWrite as_chain aws ssm put-parameter --name "$ledger/$PEER_CELL_ID" --type String --value probe --overwrite
  probe chainOwnDelete as_chain aws ssm delete-parameter --name "$ledger/$CELL_ID"
  unset creds key secret token
else
  RESULTS[chainTaggedAssume]=refused
fi

# An inherited transitive tag cannot be set again on the next hop: STS
# answers InvalidParameterValue, whatever the value.
probe chainOverride aws sts assume-role --role-arn "$CHAIN_TAGGED_ROLE_ARN" --role-session-name integ-chain \
  --tags "Key=CellId,Value=$PEER_CELL_ID"

probe ownCellDelete aws ssm delete-parameter --name "$own/probe"
write_results
