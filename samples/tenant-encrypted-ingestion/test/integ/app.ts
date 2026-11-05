// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's CDK app (spec §10, standard §5.2): the test-aid
 * stack and the demo stack with the §10 test profile and `TestConsumerRole`
 * as its consumer role. `scripts/integ.sh` synthesises it into
 * `cdk.integ.out/` and deploys both with the CDK CLI. The demo stack is the
 * sample's own (src/demo.cdk.ts), so the test wires nothing a deployer
 * could not.
 */

import { App } from 'aws-cdk-lib';
import { TestAidStack } from './test-aid-stack';
import { parseDemoContext, TenantEncryptedIngestionDemoStack } from '../../src/demo.cdk';

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
    accessLogReaderRoleArn: undefined,
  },
});
demo.addDependency(aid);
app.synth();
