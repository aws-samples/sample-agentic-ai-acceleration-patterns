// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's CDK app (spec §10, standard §5.2): the test-aid
 * stack and the demo stack with the §10 test profile and `TestConsumerRole`
 * as its consumer role. `scripts/integ.sh` synthesises it into
 * `cdk.integ.out/` and deploys both with the CDK CLI. The demo stack is the
 * sample's own (src/demo.cdk.ts), so the test wires nothing a deployer
 * could not: its consumer, redrive operator and access-log reader roles come
 * from the test-aid stack, and one extra rule on its bus feeds the test's
 * event capture queue.
 *
 * Context (scripts/integ.sh): `tenantKeyAccount` (enables `tenant-key`),
 * and the profile overrides `maxReceiveCount`, `visibilityTimeoutFactor`,
 * `abandonGraceSeconds`, `uploadUrlTtlSeconds`, `maxInFlightPerTenant`
 * (src/demo.cdk.ts PROFILE_CONTEXT_KEYS), applied over the §10 profile.
 */

import { App } from 'aws-cdk-lib';
import { addEventCapture, TestAidStack } from './test-aid-stack';
import { parseDemoContext, TenantEncryptedIngestionDemoStack } from '../../src/demo.cdk';
import { EVENT_SOURCE } from '../../src/shared/constants';

export const TEST_AID_STACK = 'TenantEncryptedIngestionTestAid';
export const DEMO_STACK = 'TenantEncryptedIngestionInteg';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const aid = new TestAidStack(app, TEST_AID_STACK, { env });
const demo = new TenantEncryptedIngestionDemoStack(app, DEMO_STACK, {
  env,
  context: {
    ...parseDemoContext((key) => app.node.tryGetContext(key)),
    integProfile: true,
    allowTenantKeys: app.node.tryGetContext('tenantKeyAccount') !== undefined,
    consumerRoleArns: [aid.consumerRole.roleArn],
    accessLogReaderRoleArn: aid.accessLogReaderRole.roleArn,
    redriveOperatorRoleArn: aid.redriveOperatorRole.roleArn,
  },
});
demo.addDependency(aid);
addEventCapture(demo, demo.ingestion.eventBus, aid.eventCaptureQueue, EVENT_SOURCE);
app.synth();
