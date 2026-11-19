// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { parseDemoContext, TenantUsageMeteringDemoStack } from '../src/demo.cdk';

const ACCOUNT = '111122223333';

function synthDemo(context: Record<string, string>): Template {
  // No asset bundling in unit tests: the functions' code is not under test here.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantUsageMeteringDemoStack(app, 'Demo', {
    context: parseDemoContext((key) => context[key]),
    env: { account: ACCOUNT, region: 'eu-central-1' },
  });
  return Template.fromStack(stack);
}

type Statement = { Action: string | string[]; Resource?: unknown; Principal?: unknown };
type PolicyResource = { Properties: { PolicyDocument: { Statement: Statement[] } } };

const actions = (statement: Statement): string[] => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]);

describe('demo HTTP sink receiver (threat model, Epoxy 30409050, 30408780)', () => {
  const template = synthDemo({ integLocalCell: 'true', integHttpReceiver: 'true' });
  const functions = template.findResources('AWS::Lambda::Function');
  const receiverId = Object.keys(functions).find((id) => id.startsWith('DemoHttpReceiver'))!;

  test('the receiver URL is AWS_IAM, never NONE', () => {
    const urls = Object.values(template.findResources('AWS::Lambda::Url'));
    expect(urls).toHaveLength(1);
    expect(urls[0].Properties).toMatchObject({ AuthType: 'AWS_IAM', TargetFunctionArn: { 'Fn::GetAtt': [receiverId, 'Arn'] } });
  });

  test('no Lambda permission names the receiver, and none in the stack is open to any principal', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')).map((resource) => resource.Properties);
    expect(permissions.filter((p) => JSON.stringify(p.FunctionName).includes(receiverId))).toEqual([]);
    expect(permissions.filter((p) => p.Principal === '*')).toEqual([]);
  });

  test('only the dispatcher role may invoke the receiver, through its URL', () => {
    const grants = Object.entries(template.findResources('AWS::IAM::Policy')).flatMap(([id, resource]) =>
      (resource as PolicyResource).Properties.PolicyDocument.Statement.filter((s) => JSON.stringify(s.Resource ?? '').includes(receiverId)).map((s) => ({ id, s })),
    );
    expect(grants.map((g) => g.id.startsWith('MeteringDispatcherRole'))).toEqual([true, true]);
    expect(grants.flatMap((g) => actions(g.s)).sort()).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    for (const { s } of grants) {
      expect(s.Resource).toEqual({ 'Fn::GetAtt': [receiverId, 'Arn'] });
    }
  });

  test('without integHttpReceiver there is no function URL at all', () => {
    expect(synthDemo({ integLocalCell: 'true' }).findResources('AWS::Lambda::Url')).toEqual({});
  });
});
