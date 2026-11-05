// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (spec §6.3, §6.4, M-30): context fails fast naming the
 * key, the build placeholders are refused at deploy by a rule, the six
 * published parameters, the two validators and the scope registration.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { INGESTION_PARAMETERS, NO_CONSUMER_ROLES, parseDemoContext, TenantEncryptedIngestionDemoStack } from '../src/demo.cdk';

function synth(context: Record<string, unknown>): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantEncryptedIngestionDemoStack(app, 'Demo', {
    context: parseDemoContext((k) => context[k]),
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  return Template.fromStack(stack);
}

describe('demo context', () => {
  it.each([
    ['identityParams', { identityParams: 'no-leading-slash/' }],
    ['consumerRoleArns', { consumerRoleArns: 'not-an-arn' }],
    ['accessLogReaderRoleArn', { accessLogReaderRoleArn: 'arn:aws:iam::111122223333:user/x' }],
    ['integProfile', { integProfile: 'maybe' }],
    ['redriveOperatorRoleArn', { redriveOperatorRoleArn: 'not-an-arn' }],
    ['maxReceiveCount', { maxReceiveCount: '1.5' }],
    ['uploadUrlTtlSeconds', { uploadUrlTtlSeconds: 'soon' }],
  ])('fails fast naming %s', (key, context) => {
    expect(() => parseDemoContext((k) => (context as Record<string, unknown>)[k])).toThrow(new RegExp(key));
  });
});

describe('demo stack', () => {
  const placeholder = synth({ identityParameterPlaceholders: 'true' });

  it('refuses to deploy a placeholder build', () => {
    expect(JSON.stringify(placeholder.toJSON().Rules)).toContain('identityParameterPlaceholders=true');
  });

  it('publishes the six parameters under /application-plane/shared/ingestion/', () => {
    for (const name of Object.values(INGESTION_PARAMETERS)) {
      placeholder.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
    placeholder.hasResourceProperties('AWS::SSM::Parameter', { Name: INGESTION_PARAMETERS.consumerRoleArns, Value: NO_CONSUMER_ROLES });
  });

  it('reads tenant-identity parameters when not a placeholder build, and registers both scopes', () => {
    const real = synth({});
    const parameters = JSON.stringify(real.toJSON().Parameters);
    for (const name of ['userPoolId', 'appClientId', 'apiUrl', 'platformInvokePolicyArn']) {
      expect(parameters).toContain(`/application-plane/shared/identity/${name}`);
    }
    real.hasResourceProperties('Custom::IngestionScopeRegistration', { Scopes: ['ingestion/deliver', 'ingestion/read'] });
  });

  it('wires the pdf-pages (limit 3) and test-switch validators', () => {
    placeholder.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: { PDF_PAGE_LIMIT: '3' } } });
    const processor = Object.values(placeholder.findResources('AWS::Lambda::Function')).find(
      (f) => f.Properties.Environment?.Variables?.TEI_VALIDATORS !== undefined,
    )!;
    const validators = JSON.stringify(processor.Properties.Environment.Variables.TEI_VALIDATORS);
    expect(validators.indexOf('pdf-pages')).toBeGreaterThan(-1);
    expect(validators.indexOf('test-switch')).toBeGreaterThan(validators.indexOf('pdf-pages'));
  });

  it('applies the spec §10 test profile with integProfile', () => {
    const integ = synth({ identityParameterPlaceholders: 'true', integProfile: 'true' });
    integ.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: Match.objectLike({ maxReceiveCount: 1 }) });
    integ.hasResourceProperties('AWS::ApiGateway::UsagePlan', {});
  });

  it('applies profile overrides from context over the test profile, and the redrive operator to the queue Deny', () => {
    const t = synth({
      identityParameterPlaceholders: 'true',
      integProfile: 'true',
      uploadUrlTtlSeconds: '120',
      maxReceiveCount: '2',
      redriveOperatorRoleArn: 'arn:aws:iam::111122223333:role/TestRedriveOperatorRole',
    });
    t.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: Match.objectLike({ maxReceiveCount: 2 }) });
    const timing = JSON.parse(t.toJSON().Outputs.PipelineTiming.Value);
    expect(timing).toEqual(
      expect.objectContaining({ uploadUrlTtlSeconds: 120, maxReceiveCount: 2, abandonGraceSeconds: 60, maxInFlightPerTenant: 5 }),
    );
    expect(timing.visibilityTimeoutSeconds).toBe(2 * timing.processorTimeoutSeconds);
    const queuePolicies = JSON.stringify(t.findResources('AWS::SQS::QueuePolicy'));
    expect(queuePolicies).toContain('arn:aws:iam::111122223333:role/TestRedriveOperatorRole');
  });

  it('gives test-switch a function timeout above the processor timeout, so sleep outlasts the processor', () => {
    const integ = synth({ identityParameterPlaceholders: 'true', integProfile: 'true' });
    const timing = JSON.parse(integ.toJSON().Outputs.PipelineTiming.Value);
    const testSwitch = Object.values(integ.findResources('AWS::Lambda::Function')).find(
      (f) => f.Properties.Environment?.Variables?.TEI_TEST_SWITCH_PARAMETER !== undefined,
    )!;
    expect(testSwitch.Properties.Timeout).toBeGreaterThan(timing.processorTimeoutSeconds);
  });

  it('outputs the log groups and the Contributor Insights rule names the integration test reads', () => {
    const outputs = placeholder.toJSON().Outputs;
    for (const name of ['LogGroupNames', 'ContributorInsightRuleNames', 'AccessLogBucketName', 'QueueArn', 'DeadLetterQueueArn', 'KeyBindingChangedAlarmName']) {
      expect(outputs[name]).toBeDefined();
    }
    expect(outputs.ContributorInsightRuleNames.Value.split(',')).toHaveLength(3);
  });

  it('passes consumer roles into the key factory environment', () => {
    const t = synth({ identityParameterPlaceholders: 'true', consumerRoleArns: 'arn:aws:iam::111122223333:role/TestConsumerRole' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ TEI_CONSUMER_ROLE_ARNS: 'arn:aws:iam::111122223333:role/TestConsumerRole' }) },
    });
  });
});
