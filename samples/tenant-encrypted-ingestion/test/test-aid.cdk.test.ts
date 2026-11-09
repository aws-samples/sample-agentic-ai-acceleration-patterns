// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's test-aid stack (M-32, M-33): TestProbeRole's
 * Denies, the scratch key built from the §7.2 builder plus the mistaken
 * Allow, and the scratch bucket's §7.4 statements without the principal ones.
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as events from 'aws-cdk-lib/aws-events';
import { addEventCapture, DEMO_QUEUE_NAME_PREFIX, PROBE_DENIED_ACTIONS, TestAidStack } from './integ/test-aid-stack';

const app = new App();
const env = { account: '111122223333', region: 'eu-central-1' };
const aid = new TestAidStack(app, 'Aid', { env });
const other = new Stack(app, 'Other', { env });
addEventCapture(other, new events.EventBus(other, 'Bus'), aid.eventCaptureQueue, 'tenant-encrypted-ingestion');
const template = Template.fromStack(aid);

describe('test-aid stack', () => {
  it('TestProbeRole denies changing what it tests and is trusted for one hour', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const deny = policies.find((s: Record<string, unknown>) => s.Sid === 'DenyChangingWhatIsTested');
    expect(deny.Effect).toBe('Deny');
    expect([...deny.Action].sort()).toEqual([...PROBE_DENIED_ACTIONS].sort());
    template.hasResourceProperties('AWS::IAM::Role', { MaxSessionDuration: 3600, Description: 'tenant-encrypted-ingestion integ: meets each key-policy and bucket-policy Deny alone (M-32)' });
  });

  it('the scratch key carries every §7.2 Deny plus the mistaken Allow for TestProbeRole', () => {
    const key = Object.values(template.findResources('AWS::KMS::Key'))[0];
    const sids = key.Properties.KeyPolicy.Statement.map((s: { Sid: string }) => s.Sid);
    for (const sid of ['DenyUseExceptTenantRoles', 'DenyDecryptExceptTenantAndConsumerRoles', 'DenyUseExceptViaS3', 'DenyUseOutsideTenantPrefixes', 'DenyTagging', 'MistakenAllowEveryUseForTestProbeRole']) {
      expect(sids).toContain(sid);
    }
    expect(key.Properties.Tags).toEqual([{ Key: 'TenantId', Value: 'tenant-a' }]);
  });

  it('the capture rule lives with the bus and its queue policy names no rule ARN (no cross-stack cycle)', () => {
    Template.fromStack(other).hasResourceProperties('AWS::Events::Rule', { EventPattern: { source: ['tenant-encrypted-ingestion'] } });
    const policy = JSON.stringify(template.findResources('AWS::SQS::QueuePolicy'));
    expect(policy).toContain('aws:SourceAccount');
    expect(policy).not.toContain('Other');
    expect(app.synth().getStackByName('Aid').dependencies.map((d) => d.id)).not.toContain('Other');
  });

  it('the redrive operator reaches only the demo stack queues', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const move = statements.find((s: { Action: string[] }) => Array.isArray(s.Action) && s.Action.includes('sqs:StartMessageMoveTask'));
    expect(JSON.stringify(move.Resource)).toContain(DEMO_QUEUE_NAME_PREFIX);
  });

  it('the scratch bucket has the §7.4 statements but not the principal-scoped ones', () => {
    const sids = Object.values(template.findResources('AWS::S3::BucketPolicy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .map((s: { Sid?: string }) => s.Sid);
    expect(sids).toEqual(expect.arrayContaining(['DenyPutWithoutSseKms', 'DenyDropWithoutIfNoneMatch', 'DenyDropNonStandardStorageClass', 'DenyOldSignatures']));
    expect(sids).not.toContain('DenyDropWriteExceptTenantRoles');
  });
});
