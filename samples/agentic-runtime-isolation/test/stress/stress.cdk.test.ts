// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Stack, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { StressAgentsStack } from './stress-agents.cdk';
import { StressDriverStack } from './stress-driver.cdk';
import { StressIngressStack, stressRegistryPrefix } from './stress-ingress.cdk';
import { stressTools, stressToolWith } from './stress-tool.function';
import { agentNames, agentsOfStack, gatewayOf, STRESS_TIERS, targetNames, tierOf } from './tiers';
import type { ToolContext } from '../../src/tools/context';
import { publishedIngress, seedPublishedIngress, TEST_ENV } from '../published-ingress';

const FIXTURE_AGENT = path.join(__dirname, '..', 'fixtures', 'agent');
const INGRESS_STACK = 'RuntimeIsolationStress-ingress';
const REGISTRY_PREFIX = stressRegistryPrefix(INGRESS_STACK);
const MAX_RESOURCES = 450;

function app(): App {
  const a = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  Validations.of(a).addPlugins(new AwsSolutionsChecks(a, { verbose: true }));
  return a;
}

function resourceCount(stack: Stack): number {
  return Object.keys(Template.fromStack(stack).toJSON().Resources ?? {}).length;
}

function outputKeys(stack: Stack): string[] {
  return Object.keys(Template.fromStack(stack).toJSON().Outputs ?? {});
}

describe('tiers (stress-test plan §8.2)', () => {
  it('defaults to small and refuses an unknown scale', () => {
    expect(tierOf(undefined)).toBe(STRESS_TIERS.small);
    expect(tierOf('')).toBe(STRESS_TIERS.small);
    expect(tierOf('large')).toBe(STRESS_TIERS.large);
    expect(() => tierOf('huge')).toThrow(/STRESS_SCALE must be one of small, medium, large/);
  });

  it('names the agents and targets', () => {
    expect(agentNames(STRESS_TIERS.small)).toEqual(['default', 'a001']);
    expect(agentNames(STRESS_TIERS.medium)).toHaveLength(10);
    expect(agentNames(STRESS_TIERS.large).slice(-1)).toEqual(['a099']);
    expect(targetNames(STRESS_TIERS.small)).toEqual(['t01', 't02']);
    expect(targetNames(STRESS_TIERS.large).slice(-1)).toEqual(['t10']);
  });

  it('spreads the targets over the gateways round-robin', () => {
    expect(targetNames(STRESS_TIERS.small).map((_, i) => gatewayOf(STRESS_TIERS.small, i))).toEqual(['default', 'finance']);
    expect(targetNames(STRESS_TIERS.large).map((_, i) => gatewayOf(STRESS_TIERS.large, i))).toEqual([
      'default', 'finance', 'hr', 'ops', 'sales', 'default', 'finance', 'hr', 'ops', 'sales',
    ]);
  });

  it('keeps every gateway under 300 tools at every tier (the Cedar schema bound, F-9)', () => {
    for (const tier of Object.values(STRESS_TIERS)) {
      const perGateway = new Map<string, number>();
      targetNames(tier).forEach((_, i) => {
        const g = gatewayOf(tier, i);
        perGateway.set(g, (perGateway.get(g) ?? 0) + tier.toolsPerTarget);
      });
      for (const [, n] of perGateway) {
        expect(n).toBeLessThan(300);
      }
    }
  });

  it('slices the non-default agents over the agents stacks', () => {
    expect(agentsOfStack(STRESS_TIERS.small, 1)).toEqual([]);
    expect(agentsOfStack(STRESS_TIERS.medium, 1)).toEqual(agentNames(STRESS_TIERS.medium).slice(1));
    const large = [1, 2, 3, 4, 5].map((k) => agentsOfStack(STRESS_TIERS.large, k));
    expect(large.map((s) => s.length)).toEqual([20, 20, 20, 20, 19]);
    expect(large.flat()).toEqual(agentNames(STRESS_TIERS.large).slice(1));
    expect(agentsOfStack(STRESS_TIERS.large, 6)).toEqual([]);
  });
});

describe('stress tool (§8.3)', () => {
  it('generates tool_001..tool_NNN with an id schema', () => {
    const tools = stressTools(3);
    expect(tools.map((t) => t.name)).toEqual(['tool_001', 'tool_002', 'tool_003']);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    }
  });

  const context = { tenantId: 'tenant-a', tool: 't01/tool_001' } as ToolContext;

  it('reports the caller ARN of the vended credentials', async () => {
    const lookup = jest.fn(async () => 'arn:aws:sts::111122223333:assumed-role/tool-role/tenant-a');
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token', expiration: '2030-01-01T00:00:00Z' };
    await expect(stressToolWith(lookup)({ context, args: {}, credentials })).resolves.toEqual({
      tool: 't01/tool_001',
      tenantId: 'tenant-a',
      callerArn: 'arn:aws:sts::111122223333:assumed-role/tool-role/tenant-a',
    });
    expect(lookup).toHaveBeenCalledWith(credentials);
  });

  it('reports null without credentials and never calls STS', async () => {
    const lookup = jest.fn(async () => 'never');
    await expect(stressToolWith(lookup)({ context, args: { id: 'x' } })).resolves.toEqual({ tool: 't01/tool_001', tenantId: 'tenant-a', callerArn: null });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('StressIngressStack at small, placeholders', () => {
  const stack = new StressIngressStack(app(), INGRESS_STACK, {
    tier: STRESS_TIERS.small,
    agentCodePath: FIXTURE_AGENT,
    identityParameterPlaceholders: true,
    env: TEST_ENV,
  });
  const template = Template.fromStack(stack);

  it('passes cdk-nag and stays under the resource ceiling', () => {
    expect(() => template.toJSON()).not.toThrow();
    expect(resourceCount(stack)).toBeLessThan(MAX_RESOURCES);
  });

  it('refuses a placeholder deployment', () => {
    expect(template.toJSON().Rules?.RefusePlaceholderDeployment).toBeDefined();
  });

  it('registers the §8.3 outputs', () => {
    expect(outputKeys(stack)).toEqual(
      expect.arrayContaining([
        'EndpointUrl', 'EntitlementsApiUrl', 'EntitlementsTableName', 'DemoTableName', 'Issuer', 'RegistryPrefix',
        'RestApiId', 'StageName', 'IngressLogGroupName', 'AuthorizerFunctionName', 'IngressFunctionName',
        'ToolsGatewayUrlDefault', 'ToolsGatewayUrlFinance', 'PolicyEngineIdDefault', 'PolicyEngineIdFinance',
        'PolicySecondsToActiveT01', 'PolicySecondsToActiveT02', 'InterceptorFunctionNames',
      ]),
    );
    template.hasOutput('RegistryPrefix', { Value: REGISTRY_PREFIX });
  });

  it('has the default agent and a001, two targets of ten tools, the tier throttle and reserved concurrency', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 2);
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 })]),
    });
    template.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 50 });
    expect(stack.targets.map((t) => [t.name, t.gateway, t.tools.length])).toEqual([
      ['t01', 'default', 10],
      ['t02', 'finance', 10],
    ]);
    expect(stack.agents.map((a) => [a.name, a.needs, a.tools])).toEqual([
      ['default', ['default/chat'], ['t01/*', 't02/*']],
      ['a001', ['a001/chat'], ['t01/*']],
    ]);
  });
});

describe('StressAgentsStack', () => {
  it('refuses a tier with no agents stack (small)', () => {
    expect(
      () => new StressAgentsStack(app(), 'A', { tier: STRESS_TIERS.small, index: 1, agentCodePath: FIXTURE_AGENT, registryPrefix: REGISTRY_PREFIX, env: TEST_ENV }),
    ).toThrow(/no agents stack 1/);
  });

  it('builds from the lookup placeholder before the document exists', () => {
    const stack = new StressAgentsStack(app(), 'RuntimeIsolationStress-agents-1', {
      tier: STRESS_TIERS.medium,
      index: 1,
      agentCodePath: FIXTURE_AGENT,
      registryPrefix: REGISTRY_PREFIX,
      env: TEST_ENV,
    });
    expect(() => Template.fromStack(stack).toJSON()).not.toThrow();
  });

  it('builds the slice from the published document, passes cdk-nag, stays under the ceiling', () => {
    const a = app();
    seedPublishedIngress(a, publishedIngress('api-gateway', STRESS_TIERS.medium.toolsGateways), REGISTRY_PREFIX);
    const stack = new StressAgentsStack(a, 'RuntimeIsolationStress-agents-1', {
      tier: STRESS_TIERS.medium,
      index: 1,
      agentCodePath: FIXTURE_AGENT,
      registryPrefix: REGISTRY_PREFIX,
      env: TEST_ENV,
    });
    const template = Template.fromStack(stack);
    expect(() => template.toJSON()).not.toThrow();
    expect(resourceCount(stack)).toBeLessThan(MAX_RESOURCES);
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 9);
    expect(stack.agents.map((b) => b.name)).toEqual(agentNames(STRESS_TIERS.medium).slice(1));
    expect(stack.agents.every((b) => b.tools.join() === 't01/*')).toBe(true);
    expect(outputKeys(stack)).toContain('AgentNames');
  });
});

describe('StressDriverStack at small', () => {
  const stack = new StressDriverStack(app(), 'RuntimeIsolationStress-driver', { tier: STRESS_TIERS.small, registryPrefix: REGISTRY_PREFIX, env: TEST_ENV });
  const template = Template.fromStack(stack);
  const json = template.toJSON();

  it('passes cdk-nag, stays under the ceiling, has the outputs', () => {
    expect(() => template.toJSON()).not.toThrow();
    expect(resourceCount(stack)).toBeLessThan(MAX_RESOURCES);
    expect(outputKeys(stack)).toEqual(expect.arrayContaining(['InstanceId', 'ResultsBucketName']));
  });

  it('has no inbound rule and outbound 443 only', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    const groups = template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: Match.stringLikeRegexp('Stress driver host') } });
    expect(Object.keys(groups)).toHaveLength(1);
    const sg = Object.values(groups)[0] as any;
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    expect(sg.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })]);
  });

  it('runs the host with no public IP, IMDSv2 required, a 30 GB encrypted gp3 root and no key pair', () => {
    const instance = Object.values(template.findResources('AWS::EC2::Instance'))[0] as any;
    expect(instance.Properties.KeyName).toBeUndefined();
    expect(instance.Properties.InstanceType).toBe('t3.large');
    expect(instance.Properties.NetworkInterfaces?.[0]?.AssociatePublicIpAddress ?? false).toBe(false);
    expect(instance.Properties.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/xvda', Ebs: { VolumeSize: 30, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } },
    ]);
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } } });
  });

  it('has one NAT gateway, the S3 gateway endpoint only, and a private results bucket', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' })] },
    });
  });

  it('grants the host exactly the §8.3 actions', () => {
    const policies = Object.values(json.Resources).filter(
      (r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('HostRole'),
    ) as any[];
    const actions = policies.flatMap((p) => p.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat()));
    expect(new Set(actions)).toEqual(new Set(['execute-api:Invoke', 'ssm:GetParameter', 's3:GetObject', 's3:PutObject', 's3:ListBucket']));
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']] }],
    });
  });
});
