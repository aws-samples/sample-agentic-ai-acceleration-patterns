#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# The `integ` projen task: guards, a per-run id, integ-runner, and a leftover
# check of this run's fleet (integration-test.md). Run from the package root.
#
# Environment: AWS_REGION (required), CP_INTEG_ACCOUNT_B (required),
# CP_INTEG_RUN_ID (optional: [a-z0-9]{1,23}, without aws, amazon or cognito;
# generated when unset; two runs must not share one), CDK_DEFAULT_ACCOUNT
# (resolved with sts get-caller-identity when unset).
set -uo pipefail

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
# scenario expects empty state. Other runs' stacks do not block this one.
bash test/integ-scripts/leftovers.sh stacks || {
  echo "Wait for that run to finish or clean up as described in integration-test.md, After an interruption, or use another CP_INTEG_RUN_ID"
  exit 1
}

# integ-runner synthesizes the app directly (no CDK CLI), so CDK_DEFAULT_ACCOUNT
# is not set for it; the test needs the current account id at synth time (it is
# account A of the two-account scenario).
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
AWS_DEFAULT_REGION="$AWS_REGION" integ-runner --language typescript --parallel-regions "$AWS_REGION" --update-on-failed --force integ.tenant.ts
status=$?

# After the runner (it destroys the stacks, pass or fail): what of this run's
# fleet is still there.
bash test/integ-scripts/leftovers.sh all || status=1
exit $status
