// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IsolatedRuntime } from '../../src/runtime-isolation.cdk';
import { WAITER_SOURCE } from '../../src/shared/log-drain';

const FIXTURE_AGENT = path.join(__dirname, '..', 'fixtures', 'agent');

function synth(ingress: 'api-gateway' | 'agentcore-gateway'): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test', { env: { account: '111122223333', region: 'eu-central-1' } });
  new IsolatedRuntime(stack, 'IsolatedRuntime', {
    identity: { discoveryUrl: 'https://issuer.example.com/.well-known/openid-configuration', allowedClientIds: ['client-one'] },
    agent: { codePath: FIXTURE_AGENT, modelId: 'amazon.nova-lite-v1:0' },
    ingress,
  });
  return Template.fromStack(stack);
}

function logicalIdOf(template: Template, type: string): string[] {
  return Object.keys(template.findResources(type));
}

describe('teardown leaves no log group (ADR-0019)', () => {
  it('api-gateway: owns the execution log group, and the stage -> drain -> every log group', () => {
    const template = synth('api-gateway');
    const groups = template.findResources('AWS::Logs::LogGroup');
    const execution = Object.entries(groups).find(([, g]) => JSON.stringify((g as any).Properties.LogGroupName ?? '').includes('API-Gateway-Execution-Logs_'));
    expect(execution).toBeDefined();
    expect(JSON.stringify((execution![1] as any).Properties.LogGroupName)).toContain('/prod');

    const [drain] = logicalIdOf(template, 'AWS::CloudFormation::CustomResource');
    const drainDeps: string[] = template.toJSON().Resources[drain].DependsOn ?? [];
    const writerGroups = Object.keys(groups).filter((id) => !id.includes('LogDrain'));
    expect(writerGroups.length).toBe(4);
    for (const id of writerGroups) {
      expect(drainDeps).toContain(id);
    }
    const [stage] = logicalIdOf(template, 'AWS::ApiGateway::Stage');
    expect(template.toJSON().Resources[stage].DependsOn).toContain(drain);
  });

  it('agentcore-gateway: the Gateway -> drain -> the interceptor log group', () => {
    const template = synth('agentcore-gateway');
    const [drain] = logicalIdOf(template, 'AWS::CloudFormation::CustomResource');
    const interceptorLogs = Object.keys(template.findResources('AWS::Logs::LogGroup')).find((id) => id.includes('InterceptorLogs'))!;
    expect(template.toJSON().Resources[drain].DependsOn).toContain(interceptorLogs);
    const [gateway] = logicalIdOf(template, 'AWS::BedrockAgentCore::Gateway');
    expect(template.toJSON().Resources[gateway].DependsOn).toContain(drain);
  });

  it('the waiter always answers CloudFormation, also when the Delete wait throws', () => {
    expect(WAITER_SOURCE).toMatch(/try \{[\s\S]*RequestType === 'Delete'[\s\S]*\} finally \{\s*await respond/);
  });
});
