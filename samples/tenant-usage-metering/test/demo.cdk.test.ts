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

type Statement = { Effect?: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown; NotAction?: unknown; Principal?: unknown };
type PolicyResource = { Properties: { PolicyDocument: { Statement: Statement[] } } };
type InlinePolicy = { PolicyDocument: { Statement: Statement[] } };

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

  // Every identity statement in the stack: policies, managed policies and roles' inline policies.
  const statements = (): Array<{ id: string; s: Statement }> => [
    ...Object.entries({ ...template.findResources('AWS::IAM::Policy'), ...template.findResources('AWS::IAM::ManagedPolicy') }).flatMap(([id, resource]) =>
      (resource as PolicyResource).Properties.PolicyDocument.Statement.map((s) => ({ id, s })),
    ),
    ...Object.entries(template.findResources('AWS::IAM::Role')).flatMap(([id, resource]) =>
      ((resource.Properties.Policies ?? []) as InlinePolicy[]).flatMap((p) => p.PolicyDocument.Statement.map((s) => ({ id, s }))),
    ),
  ];
  // Any action that can invoke a function: `*`, a lambda wildcard, or the two invoke actions.
  const invokes = (s: Statement): boolean => actions(s).some((a) => a === '*' || /^lambda:(.*\*.*|InvokeFunction|InvokeFunctionUrl)$/.test(a));
  const apiInvokes = (s: Statement): boolean => actions(s).some((a) => /^execute-api:(.*\*.*|Invoke)$/.test(a));

  test('only the dispatcher role may invoke the receiver, through its URL', () => {
    const grants = statements().filter(({ s }) => JSON.stringify(s.Resource ?? '').includes(receiverId));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.id.startsWith('MeteringDispatcherRole'))).toBe(true);
    expect([...new Set(grants.flatMap((g) => actions(g.s)))].sort()).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    for (const { s } of grants) {
      expect(s.Resource).toEqual({ 'Fn::GetAtt': [receiverId, 'Arn'] });
    }
  });

  // A resource that covers more than named functions or APIs: `*`, any function (`function:*`),
  // any Region or account in a Lambda ARN, or any API. A version qualifier (`<arn>:*`) stays allowed.
  const BROAD_RESOURCE = /^"\*"$|function:\*|:lambda:\*|:lambda:[^:"]*:\*|execute-api:\*|execute-api:[^:"]*:\*|execute-api:[^:"]*:[^:"]*:\*/;
  const broad = (s: Statement): boolean => {
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return resources.some((r) => BROAD_RESOURCE.test(JSON.stringify(r ?? '')));
  };

  test('no identity statement grants invoke on every function or API', () => {
    const wildcard = statements().filter(({ s }) => s.Effect !== 'Deny' && (invokes(s) || apiInvokes(s)) && (broad(s) || s.NotResource !== undefined));
    expect(wildcard).toEqual([]);
    const notAction = statements().filter(({ s }) => s.Effect !== 'Deny' && s.NotAction !== undefined);
    expect(notAction).toEqual([]);
  });

  test('the wildcard check catches the broad shapes (review v3 #1)', () => {
    const allow = (Action: string, Resource: unknown): Statement => ({ Effect: 'Allow', Action, Resource });
    const fnArn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:eu-central-1:111122223333:function:*']] };
    expect(invokes(allow('lambda:Invoke*', 'x')) && broad(allow('lambda:Invoke*', fnArn))).toBe(true);
    expect(broad(allow('lambda:InvokeFunction', '*'))).toBe(true);
    expect(broad(allow('lambda:InvokeFunction', 'arn:aws:lambda:*:*:function:x'))).toBe(true);
    expect(apiInvokes(allow('execute-api:Invoke', 'x')) && broad(allow('execute-api:Invoke', 'arn:aws:execute-api:eu-central-1:111122223333:*'))).toBe(true);
    expect(broad(allow('lambda:InvokeFunction', { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Fn', 'Arn'] }, ':*']] }))).toBe(false);
  });

  test('without integHttpReceiver there is no function URL at all', () => {
    expect(synthDemo({ integLocalCell: 'true' }).findResources('AWS::Lambda::Url')).toEqual({});
  });
});
