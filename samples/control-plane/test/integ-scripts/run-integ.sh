#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# The `integ` projen task: guards, a per-run id, integ-runner, and a leftover
# check of this run's fleet (integration-test.md). Run from the package root.
#
# Argument: the test file, integ.tenant.ts (default) or integ.session-tags.ts.
#
# Environment: AWS_REGION (required), CP_INTEG_ACCOUNT_B (required),
# CP_INTEG_RUN_ID (optional: [a-z0-9]{1,23}, without aws, amazon or cognito;
# generated when unset; two runs must not share one), CDK_DEFAULT_ACCOUNT
# (resolved with sts get-caller-identity when unset).
#
# Refuses to start while a stack of this run exists, or while
# /control-plane/tenant-api-url exists in the account and Region.
set -uo pipefail

TEST="${1:-integ.tenant.ts}"
case "$TEST" in
  integ.tenant.ts | integ.session-tags.ts) ;;
  *) echo "Unknown test file $TEST: use integ.tenant.ts or integ.session-tags.ts"; exit 1 ;;
esac

[ -n "${AWS_REGION:-}" ] || { echo "Set AWS_REGION to the single Region to test in (e.g. export AWS_REGION=eu-central-1)"; exit 1; }
[ -n "${CP_INTEG_ACCOUNT_B:-}" ] || { echo "Set CP_INTEG_ACCOUNT_B to the second (tenant-owned) test account id; it must be CDK-bootstrapped to trust this account (integration-test.md)"; exit 1; }

# A run id: a letter, the date and time to the minute, and three random bytes
# in hex (16 characters of [a-z0-9]; hex holds none of the three words).
if [ -z "${CP_INTEG_RUN_ID:-}" ]; then
  CP_INTEG_RUN_ID="r$(date -u +%m%d%H%M)$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
fi
if ! [[ "$CP_INTEG_RUN_ID" =~ ^[a-z0-9]{1,23}$ ]] || [[ "$CP_INTEG_RUN_ID" =~ aws|amazon|cognito ]]; then
  echo "CP_INTEG_RUN_ID must match [a-z0-9]{1,23} and must not contain aws, amazon or cognito"
  exit 1
fi
export CP_INTEG_RUN_ID
echo "Run id ${CP_INTEG_RUN_ID}, fleet name cp-integ-${CP_INTEG_RUN_ID}"

# Refuse to start while a stack of THIS run exists (only a reused run id can
# meet one): it belongs to a run in progress or to an interrupted run, and the
# scenario expects empty state. This check is per run; the parameter check
# below is per account and Region.
bash test/integ-scripts/leftovers.sh stacks
check=$?
if [ "$check" -eq 2 ]; then
  echo "Could not check for stacks of this run; fix the AWS call above and start again"
  exit 1
fi
if [ "$check" -ne 0 ]; then
  echo "Wait for that run to finish or clean up as described in integration-test.md, After an interruption, or use another CP_INTEG_RUN_ID"
  exit 1
fi

# integ-runner synthesizes the app directly (no CDK CLI), so CDK_DEFAULT_ACCOUNT
# is not set for it; the test needs the current account id at synth time (it is
# account A of the two-account scenario).
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"

# One control plane stack per account and Region, whatever its run id: its
# tenant API URL parameter has a fixed name, so a second stack here fails in
# CloudFormation early validation after the runner has started. Refuse up
# front instead (integration-test.md, Sharing accounts between runs).
if param_err=$(aws ssm get-parameter --name /control-plane/tenant-api-url --region "$AWS_REGION" --query Parameter.Name --output text 2>&1 >/dev/null); then
  echo "/control-plane/tenant-api-url already exists in account ${CDK_DEFAULT_ACCOUNT} ${AWS_REGION}: another control plane stack (an integ run in progress or a deployment) owns it. Use another account or Region, or wait for that run to finish"
  exit 1
elif ! grep -q ParameterNotFound <<<"$param_err"; then
  echo "Could not check for /control-plane/tenant-api-url: ${param_err}"
  exit 1
fi

AWS_DEFAULT_REGION="$AWS_REGION" integ-runner --language typescript --parallel-regions "$AWS_REGION" --update-on-failed --force "$TEST"
status=$?

# After the runner (it destroys the stacks, pass or fail): what of this run's
# fleet is still there.
bash test/integ-scripts/leftovers.sh all || status=1
exit $status
