// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Stack, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { StressAgentsStack } from './stress-agents.cdk';
import { StressIngressStack, stressRegistryPrefix } from './stress-ingress.cdk';
import { stressTools, stressToolWith } from './stress-tool.function';
import { agentNames, agentsOfStack, gatewayOf, STRESS_TIERS, targetNames, tierOf } from './tiers';
import { TIERS } from '../../../../stress/src/tiers';
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

  it('takes the figures it shares with every slice from stress/src/tiers.ts', () => {
    for (const [name, tier] of Object.entries(STRESS_TIERS)) {
      const shared = TIERS[name as keyof typeof TIERS];
      expect({
        name: tier.name,
        tenantsSeeded: tier.tenantsSeeded,
        tenantsActive: tier.tenantsActive,
        usersPerActiveTenant: tier.usersPerActiveTenant,
        steadyRps: tier.steadyRps,
        peakRps: tier.peakRps,
        scenarioSeconds: tier.scenarioSeconds,
        driverInstanceType: tier.driverInstanceType,
      }).toEqual({
        name: shared.name,
        tenantsSeeded: shared.tenantsSeeded,
        tenantsActive: shared.tenantsActive,
        usersPerActiveTenant: shared.usersPerActiveTenant,
        steadyRps: shared.steadyRps,
        peakRps: shared.peakRps,
        scenarioSeconds: shared.scenarioSeconds,
        driverInstanceType: shared.driverInstanceType,
      });
    }
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
        'RestApiId', 'StageName', 'IngressLogGroupName', 'AuthorizerFunctionName', 'AuthorizerLogGroupName', 'IngressFunctionName',
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
    template.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 40 });
    expect(stack.targets.map((t) => [t.name, t.gateway, t.tools.length])).toEqual([
      ['t01', 'default', 10],
      ['t02', 'finance', 10],
    ]);
    expect(stack.agents.map((a) => [a.name, a.needs, a.tools])).toEqual([
      ['default', ['default/chat'], ['t01/*', 't02/*']],
      ['a001', ['a001/chat'], ['t01/*']],
    ]);
  });

  it('warns that the stage throttle is above a reserve, on purpose: the peak scenario runs past the reserve (plan §8.2, ADR-0049)', () => {
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('runtime-isolation:stage-throttle-above-concurrency'));
  });
});

describe('every tier sets the stage throttle above a reserve (plan §8.2)', () => {
  it.each(Object.values(STRESS_TIERS).map((t) => [t.name, t] as const))('%s', (_name, tier) => {
    const over = tier.stageThrottle.rateLimit > tier.ingressReservedConcurrency || tier.stageThrottle.rateLimit > tier.authorizerReservedConcurrency;
    expect(over).toBe(true);
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
