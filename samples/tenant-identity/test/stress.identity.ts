// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The platform stress test's own tenant-identity deployment (stress ADR-0002,
 * ADR-0042): one `shared-pool` stack named `${STRESS_PREFIX}-identity`, with
 * its own user pool, registry and API, beside whatever else the account holds.
 *
 * It never publishes the fixed-name `/application-plane/shared/identity/*`
 * parameters, nor the account-wide admin-password key alias that goes with
 * them (ADR-0017): `publishSharedParameters` is off. A run of the stress
 * slice (`scripts/stress/slice.sh`) reads this stack's outputs and publishes
 * its own identifiers under the stress prefix instead.
 *
 * `STRESS_PREFIX` is required and must not start with `TenantIdentity`, the
 * prefix the integration tests and the long-lived shared pool use, so this app
 * can never synthesise a stack that update or delete one of theirs.
 */

import { App } from 'aws-cdk-lib';
import { TenantIdentityStack } from '../src/identity.cdk';
import { stackNameOf } from './stress/plan';

const app = new App();

new TenantIdentityStack(app, stackNameOf(process.env.STRESS_PREFIX), {
  topology: 'shared-pool',
  publishSharedParameters: false,
});

app.synth();
