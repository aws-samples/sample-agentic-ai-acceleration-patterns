// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TenantMemoryIsolation` synthesised in a bare stack, once per option the
 * specification promises (standard §4.5, §5.1), with assertions on what the
 * threat model relies on: the Gateway's auth and protocol, the role and its
 * trust, the fence, the policies and their order, and removal policies.
 */

import { App, Stack, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { MEMORY_DATA_ACTIONS } from '../src/fence';
import { TenantMemoryIsolation, type TenantMemoryIsolationProps } from '../src/tenant-memory-isolation';

const ISSUER = { discoveryUrl: 'https://issuer.example.com/pool/.well-known/openid-configuration', allowedClients: ['demo-client'] };

function synth(props: Partial<TenantMemoryIsolationProps> = {}, nag = false): Template {
  const app = new App();
  if (nag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'Bare', { env: { account: '111122223333', region: 'us-west-2' } });
  new TenantMemoryIsolation(stack, 'Memory', { issuer: ISSUER, ...props });
  if (nag) {
    app.synth();
  }
  return Template.fromStack(stack);
}

function policyText(template: Template): string[] {
  return Object.values(template.findResources('AWS::BedrockAgentCore::Policy')).map((r) =>
    JSON.stringify(r.Properties.Definition.Cedar.Statement),
  );
}

describe('defaults', () => {
  const template = synth();

  it('authenticates with CUSTOM_JWT on the given issuer and enforces Policy, without MCP or verbose errors', () => {
    const gateways = template.findResources('AWS::BedrockAgentCore::Gateway');
    const [gateway] = Object.values(gateways);
    expect(gateway.Properties.AuthorizerType).toBe('CUSTOM_JWT');
    expect(gateway.Properties.AuthorizerConfiguration.CustomJWTAuthorizer).toEqual({
      DiscoveryUrl: ISSUER.discoveryUrl,
      AllowedClients: ['demo-client'],
    });
    expect(gateway.Properties.PolicyEngineConfiguration.Mode).toBe('ENFORCE');
    expect(gateway.Properties.ProtocolType).toBeUndefined();
    expect(gateway.Properties.ExceptionLevel).toBeUndefined();
    expect(gateway.Properties.InterceptorConfigurations).toBeUndefined();
  });

  it('targets the native Memory connector as the Gateway role', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'tenant-memory',
      TargetConfiguration: { Http: { Connector: { Source: { ConnectorId: 'agentcore-memory' }, Parameters: { memoryId: Match.anyValue() } } } },
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
  });

  it('writes each tenant\'s facts to the namespace equal to its tenant id', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: [{ SemanticMemoryStrategy: Match.objectLike({ NamespaceTemplates: ['{actorId}'] }) }],
      EventExpiryDuration: 30,
    });
  });

  it('names the Memory per stack instance, so a redeploy never collides with a Memory still being deleted', () => {
    const [memory] = Object.values(template.findResources('AWS::BedrockAgentCore::Memory'));
    const name = JSON.stringify(memory.Properties.Name);
    expect(name).toContain('AWS::StackId');
    expect(name).toMatch(/"[A-Za-z][A-Za-z0-9]{0,38}_"/);
  });

  it('trusts only the AgentCore service for this account, this Gateway\'s name, and its Policy engine', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const [role] = Object.values(roles);
    const [statement] = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statement.Principal).toEqual({ Service: 'bedrock-agentcore.amazonaws.com' });
    expect(statement.Condition.StringEquals).toEqual({ 'aws:SourceAccount': '111122223333' });
    const [gatewayPattern, engine] = statement.Condition.ArnLike['aws:SourceArn'];
    expect(JSON.stringify(gatewayPattern)).toMatch(/:gateway\/[a-z0-9-]+-memory-\?{10}"/);
    expect(engine).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/PolicyEngine/), 'PolicyEngineArn'] });
    expect(JSON.stringify(statement)).not.toContain('gateway/*');
  });

  it('grants the role exactly the agent operations on its Memory, plus target and Policy reads', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = statements.map((s) => [s.Sid, [s.Action].flat().sort()]);
    expect(actions).toEqual([
      ['AgentMemoryOperations', ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords']],
      ['ValidateMemoryTarget', ['bedrock-agentcore:GetMemory']],
      ['ReadPolicyEngine', ['bedrock-agentcore:GetPolicyEngine']],
      ['AuthorizeWithPolicyEngine', ['bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:PartiallyAuthorizeActions']],
    ]);
    expect(JSON.stringify(statements)).not.toMatch(/"Resource":"\*"/);
  });

  it('fences every Memory data operation outside the Gateway role', () => {
    const [fence] = Object.values(template.findResources('AWS::BedrockAgentCore::ResourcePolicy'));
    const text = JSON.stringify(fence.Properties.Policy);
    for (const name of MEMORY_DATA_ACTIONS) {
      expect(text).toContain(`bedrock-agentcore:${name}`);
    }
    expect(text).toContain('ArnNotEquals');
    expect(text).toContain('aws:PrincipalArn');
  });

  it('writes the event policy, then the recall policy, after the target', () => {
    const policies = template.findResources('AWS::BedrockAgentCore::Policy');
    const [target] = Object.keys(template.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const entries = Object.entries(policies);
    const events = entries.find(([id]) => id.includes('EventWrite'))!;
    const recall = entries.find(([id]) => id.includes('SharedRecall'))!;
    expect(events[1].DependsOn).toContain(target);
    expect(recall[1].DependsOn).toContain(events[0]);
    for (const [, policy] of entries) {
      expect(policy.Properties.ValidationMode).toBe('FAIL_ON_ANY_FINDINGS');
    }
  });

  it('checks token_use on every permit', () => {
    for (const text of policyText(template)) {
      expect(text).toContain('principal.getTag(\\"token_use\\") == \\"access\\"');
    }
  });

  it('limits each tenant at the Gateway on its tenant claim', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayRateLimit', {
      DimensionKeys: ['$.context.jwt.tenant_id'],
      Entries: [{ Dimensions: { '$.context.jwt.tenant_id': '*' }, Requests: [{ Period: 'second', Rate: 25 }] }],
    });
  });

  it('delivers Memory application logs to a retained log group with top-tenant rules', () => {
    template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'APPLICATION_LOGS' });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    expect(Object.keys(template.findResources('AWS::CloudWatch::InsightRule'))).toHaveLength(2);
  });

  it('is torn down completely', () => {
    for (const type of [
      'AWS::BedrockAgentCore::Memory',
      'AWS::BedrockAgentCore::Gateway',
      'AWS::BedrockAgentCore::GatewayTarget',
      'AWS::BedrockAgentCore::PolicyEngine',
      'AWS::BedrockAgentCore::Policy',
      'AWS::BedrockAgentCore::ResourcePolicy',
      'AWS::Logs::LogGroup',
    ]) {
      for (const resource of Object.values(template.findResources(type))) {
        expect(resource.DeletionPolicy).toBe('Delete');
      }
    }
  });
});

describe('options', () => {
  it('an audience-bound issuer without token_use drops the token_use check and binds sessions to the chosen claim', () => {
    const template = synth({
      issuer: { discoveryUrl: ISSUER.discoveryUrl, allowedAudience: ['agent:support'] },
      claims: { tokenUse: false, session: 'agent' },
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerConfiguration: { CustomJWTAuthorizer: { AllowedAudience: ['agent:support'] } },
    });
    for (const text of policyText(template)) {
      expect(text).not.toContain('token_use');
    }
    expect(policyText(template).join()).toContain('principal.getTag(\\"agent\\")');
  });

  it('custom event expiry, rate, and log retention', () => {
    const template = synth({ eventExpiryDays: 90, tenantRequestsPerSecond: 5, logRetention: 7 });
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', { EventExpiryDuration: 90 });
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayRateLimit', { Entries: [Match.objectLike({ Requests: [{ Period: 'second', Rate: 5 }] })] });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('passes cdk-nag with no acknowledgment', () => {
    expect(() => synth({}, true)).not.toThrow();
  });
});

describe('validation fails at synth, naming the prop', () => {
  it.each([
    [{ issuer: { discoveryUrl: 'http://issuer.example.com/.well-known/openid-configuration', allowedClients: ['c'] } }, 'issuer.discoveryUrl'],
    [{ issuer: { discoveryUrl: ISSUER.discoveryUrl } }, 'issuer needs allowedClients or allowedAudience'],
    [{ claims: { tokenUse: false } }, 'claims.tokenUse'],
    [{ claims: { session: 'tenant_id' } }, 'claims.session'],
    [{ claims: { tenant: 'bad claim' } }, 'claims.tenant'],
    [{ eventExpiryDays: 3 }, 'eventExpiryDays'],
    [{ tenantRequestsPerSecond: 0 }, 'tenantRequestsPerSecond'],
  ] as Array<[Partial<TenantMemoryIsolationProps>, string]>)('%j', (props, message) => {
    expect(() => synth(props)).toThrow(message);
  });
});
