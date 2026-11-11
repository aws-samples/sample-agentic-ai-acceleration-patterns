// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack: context validation, the bundled issuer's token contract,
 * the published parameter, and cdk-nag with the demo's acknowledgments.
 */

import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { parseDemoContext, PUBLISHED_PARAMETER, TenantMemoryIsolationDemoStack } from '../src/demo.cdk';

function demo(context: Record<string, string> = {}, nag = false): { app: App; template: Template } {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (nag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new TenantMemoryIsolationDemoStack(app, 'Demo', {
    context: parseDemoContext((key) => context[key]),
    env: { account: '111122223333', region: 'us-west-2' },
  });
  return { app, template: Template.fromStack(stack) };
}

describe('context', () => {
  it('defaults to the bundled issuer', () => {
    expect(parseDemoContext(() => undefined)).toEqual({});
  });
  it('takes an external issuer only with its client ids', () => {
    expect(() => parseDemoContext((k) => ({ issuerDiscoveryUrl: 'https://x/.well-known/openid-configuration' })[k])).toThrow('issuerClientIds');
    expect(() => parseDemoContext((k) => ({ issuerClientIds: 'a' })[k])).toThrow('issuerDiscoveryUrl');
    expect(() => parseDemoContext((k) => ({ issuerDiscoveryUrl: 'https://x/.well-known/openid-configuration', issuerClientIds: 'a b' })[k])).toThrow(
      'comma-separated',
    );
    expect(parseDemoContext((k) => ({ issuerDiscoveryUrl: 'https://x/.well-known/openid-configuration', issuerClientIds: 'a, b' })[k])).toEqual({
      issuer: { discoveryUrl: 'https://x/.well-known/openid-configuration', allowedClients: ['a', 'b'] },
    });
  });
});

describe('bundled issuer', () => {
  const { template } = demo();

  it('keeps the tenant in an immutable attribute no app client can write', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: [Match.objectLike({ Name: 'tenantId', Mutable: false })],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UserPoolTier: 'ESSENTIALS',
      LambdaConfig: { PreTokenGenerationConfig: Match.objectLike({ LambdaVersion: 'V2_0' }) },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      WriteAttributes: [],
      AllowedOAuthFlows: Match.absent(),
      CallbackURLs: Match.absent(),
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_ADMIN_USER_PASSWORD_AUTH']),
      GenerateSecret: false,
      AccessTokenValidity: 5,
    });
  });

  it('trusts the pool\'s discovery URL and its one app client', () => {
    const [gateway] = Object.values(template.findResources('AWS::BedrockAgentCore::Gateway'));
    const auth = gateway.Properties.AuthorizerConfiguration.CustomJWTAuthorizer;
    expect(JSON.stringify(auth.DiscoveryUrl)).toContain('/.well-known/openid-configuration');
    expect(auth.AllowedClients).toHaveLength(1);
  });

  it('publishes the interface as one JSON parameter', () => {
    const [parameter] = Object.values(template.findResources('AWS::SSM::Parameter'));
    expect(parameter.Properties.Name).toBe(PUBLISHED_PARAMETER);
    const value = JSON.stringify(parameter.Properties.Value);
    for (const key of ['gatewayUrl', 'targetName', 'gatewayArn', 'memoryId', 'memoryArn', 'policyEngineArn', 'gatewayRoleArn', 'tenantClaim', 'sessionClaim', 'applicationLogGroup', 'demoIssuer']) {
      expect(value).toContain(`\\"${key}\\"`);
    }
  });

  it('gives the trigger its own log group and no managed policy', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0];
    expect(fn.Properties.Runtime).toBe('nodejs24.x');
    expect(JSON.stringify(template.findResources('AWS::IAM::Role'))).not.toContain('ManagedPolicyArns');
  });
});

describe('external issuer', () => {
  it('creates no user pool and publishes no demo issuer', () => {
    const { template } = demo({ issuerDiscoveryUrl: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_x/.well-known/openid-configuration', issuerClientIds: 'abc' });
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    const [parameter] = Object.values(template.findResources('AWS::SSM::Parameter'));
    expect(JSON.stringify(parameter.Properties.Value)).not.toContain('demoIssuer');
  });
});

describe('cdk-nag', () => {
  it.each<Record<string, string>>([{}, { issuerDiscoveryUrl: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_x/.well-known/openid-configuration', issuerClientIds: 'abc' }])(
    'passes for the demo stack with context %j',
    (context) => {
      const { app } = demo(context, true);
      expect(() => app.synth()).not.toThrow();
    },
  );
});
