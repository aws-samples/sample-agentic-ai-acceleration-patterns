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

describe('demo HTTP sink receiver (threat model T-17, M-17)', () => {
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

  // Every identity statement in the stack: standalone and managed policies, and the inline
  // policies of roles, users and groups.
  const POLICY_TYPES = ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::RolePolicy', 'AWS::IAM::UserPolicy', 'AWS::IAM::GroupPolicy'];
  const PRINCIPAL_TYPES = ['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group'];
  const statements = (): Array<{ id: string; s: Statement }> => [
    ...POLICY_TYPES.flatMap((type) =>
      Object.entries(template.findResources(type)).flatMap(([id, resource]) =>
        (resource as PolicyResource).Properties.PolicyDocument.Statement.map((s) => ({ id, s })),
      ),
    ),
    ...PRINCIPAL_TYPES.flatMap((type) =>
      Object.entries(template.findResources(type)).flatMap(([id, resource]) =>
        ((resource.Properties.Policies ?? []) as InlinePolicy[]).flatMap((p) => p.PolicyDocument.Statement.map((s) => ({ id, s }))),
      ),
    ),
  ];
  // Any action that can invoke a function: `*`, a lambda wildcard (`*` or `?`), or an invoke
  // action. IAM action names are case-insensitive, so the match is too.
  const invokes = (s: Statement): boolean => actions(s).some((a) => a === '*' || /^lambda:(.*[*?].*|InvokeFunction|InvokeFunctionUrl|InvokeAsync)$/i.test(a));
  const apiInvokes = (s: Statement): boolean => actions(s).some((a) => /^execute-api:(.*[*?].*|Invoke)$/i.test(a));

  test('only the dispatcher role may invoke the receiver, through its URL', () => {
    const grants = statements().filter(({ s }) => JSON.stringify(s.Resource ?? '').includes(receiverId));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.id.startsWith('MeteringDispatcherRole'))).toBe(true);
    expect([...new Set(grants.flatMap((g) => actions(g.s)))].sort()).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    for (const { s } of grants) {
      expect(s.Resource).toEqual({ 'Fn::GetAtt': [receiverId, 'Arn'] });
    }
  });

  // A resource as one string: `Fn::Join` and `Fn::Sub` are flattened, and a `Ref`, `Fn::GetAtt`
  // or `${...}` becomes TOKEN, a name in the template (a parameter set to `*` is out of reach of
  // a synth-time check). Any other intrinsic counts as `*`. So a wildcard counts the same whether
  // it sits in its own join piece or after a `${AWS::StackName}`.
  const TOKEN = 'TOKEN';
  const flat = (value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }
    const intrinsic = (value ?? {}) as Record<string, unknown>;
    if (Array.isArray(intrinsic['Fn::Join'])) {
      const [delimiter, parts] = intrinsic['Fn::Join'] as [string, unknown[]];
      return parts.map(flat).join(delimiter);
    }
    if (intrinsic['Fn::Sub'] !== undefined) {
      const sub = intrinsic['Fn::Sub'];
      const [body, variables] = Array.isArray(sub) ? [String(sub[0]), (sub[1] ?? {}) as Record<string, unknown>] : [String(sub), {}];
      return body.replace(/\$\{([^}]*)\}/g, (_, name: string) => (name in variables ? flat(variables[name]) : TOKEN));
    }
    if (intrinsic.Ref !== undefined || intrinsic['Fn::GetAtt'] !== undefined) {
      return TOKEN;
    }
    // Fn::If, Fn::Select, Fn::ImportValue and the like are not resolved here: count them as `*`.
    return '*';
  };
  const WILD = /[*?]/;
  // A resource that covers more than named functions or APIs: `*`, or a `*` or `?` in the
  // partition, service, Region or account of an ARN, in a Lambda function name
  // (`function:*`, `function:Demo*`, `function:${AWS::StackName}-*`) or in an API id. A wildcard
  // only in a Lambda qualifier (`<arn>:*`) or an API's stage, method or path (`<api>/*`) is
  // allowed. A string that is not an ARN, such as `<GetAtt Arn>:*`, is broad if it has a
  // wildcard before its last `:`.
  const broadResource = (resource: unknown): boolean => {
    const arn = flat(resource);
    if (!WILD.test(arn)) {
      return false;
    }
    const segments = arn.split(':');
    if (segments[0] !== 'arn') {
      const last = arn.lastIndexOf(':');
      return last < 0 || WILD.test(arn.slice(0, last));
    }
    if (segments.length < 6) {
      // A truncated ARN with a wildcard (`arn:aws:lambda:*`) is not one named resource.
      return true;
    }
    const [, partition, service, region, account, ...rest] = segments;
    if ([partition, service, region, account].some((segment) => WILD.test(segment))) {
      return true;
    }
    if (service === 'lambda') {
      return WILD.test(rest[0]) || (rest[0] === 'function' && WILD.test(rest[1] ?? ''));
    }
    if (service === 'execute-api') {
      return WILD.test(rest.join(':').split('/')[0]);
    }
    return false;
  };
  const broad = (s: Statement): boolean => {
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return resources.some((r) => broadResource(r ?? ''));
  };

  test('no identity statement grants invoke on every function or API', () => {
    const wildcard = statements().filter(({ s }) => s.Effect !== 'Deny' && (invokes(s) || apiInvokes(s)) && (broad(s) || s.NotResource !== undefined));
    expect(wildcard).toEqual([]);
    const notAction = statements().filter(({ s }) => s.Effect !== 'Deny' && s.NotAction !== undefined);
    expect(notAction).toEqual([]);
  });

  // AWS-managed policies the stack may attach. Their documents are not in the template, so any
  // other one (e.g. `service-role/AWSLambdaRole`, invoke on `*`) would get past the checks above.
  const ALLOWED_AWS_MANAGED = new Set(['service-role/AWSLambdaBasicExecutionRole']);
  // A `Ref` to an in-stack managed policy (its statements are checked above) or an allowlisted AWS one.
  const allowedManaged = (arn: unknown, inStack: Set<string>): boolean => {
    const ref = (arn as { Ref?: string } | undefined)?.Ref;
    if (ref !== undefined && inStack.has(ref)) {
      return true;
    }
    const name = /^arn:[^:]+:iam::aws:policy\/(.+)$/.exec(flat(arn))?.[1];
    return name !== undefined && ALLOWED_AWS_MANAGED.has(name);
  };
  test('roles, users and groups attach only in-stack or allowlisted managed policies', () => {
    const managed = new Set(Object.keys(template.findResources('AWS::IAM::ManagedPolicy')));
    const attached = PRINCIPAL_TYPES.flatMap((type) =>
      Object.entries(template.findResources(type)).flatMap(([id, resource]) =>
        ((resource.Properties.ManagedPolicyArns ?? []) as unknown[]).map((arn) => ({ id, arn })),
      ),
    );
    expect(attached.length).toBeGreaterThan(0);
    expect(attached.filter(({ arn }) => !allowedManaged(arn, managed))).toEqual([]);
    // The check itself: an AWS-managed policy that grants invoke, or an unknown ARN, fails.
    expect(allowedManaged({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaRole']] }, managed)).toBe(false);
    expect(allowedManaged('arn:aws:iam::111122223333:policy/Anything', managed)).toBe(false);
    expect(allowedManaged({ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }, managed)).toBe(true);
  });

  const allow = (Action: string, Resource: unknown): Statement => ({ Effect: 'Allow', Action, Resource });

  // The checker's own boundary: each resource shape, and whether it counts as broad.
  const join = (...parts: unknown[]) => ({ 'Fn::Join': ['', parts] });
  const FN = 'arn:aws:lambda:eu-central-1:111122223333:function:';
  const API = 'arn:aws:execute-api:eu-central-1:111122223333:';
  const RESOURCE_SHAPES: Array<[string, unknown, boolean]> = [
    ['any resource', '*', true],
    ['any function', `${FN}*`, true],
    ['a name prefix', `${FN}TenantUsageMetering-*`, true],
    ['a stack-name prefix in a join', join(FN, { Ref: 'AWS::StackName' }, '-*'), true],
    ['a stack-name prefix in Fn::Sub', { 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-*' }, true],
    ['a wildcard Fn::Sub variable', { 'Fn::Sub': [`${FN}\${Name}`, { Name: '*' }] }, true],
    ['a partial Region', 'arn:aws:lambda:eu-*:111122223333:function:x', true],
    ['a wildcard account in a join', join('arn:aws:lambda:', { Ref: 'AWS::Region' }, ':*:function:x'), true],
    ['a `?` in the account', 'arn:aws:lambda:eu-central-1:1111?2223333:function:x', true],
    ['every resource type', 'arn:aws:lambda:eu-central-1:111122223333:*', true],
    ['a truncated ARN', 'arn:aws:lambda:*', true],
    ['a wildcard after a function ARN token', join({ 'Fn::GetAtt': ['Fn', 'Arn'] }, '*'), true],
    ['a conditional with a wildcard branch', { 'Fn::If': ['Cond', '*', `${FN}x`] }, true],
    ['an imported prefix', join({ 'Fn::ImportValue': 'Prefix' }, ':function:*'), true],
    ['any API', join(API, '*'), true],
    ['an API id prefix', `${API}ab*/prod/POST/usage`, true],
    ['one function', `${FN}billing`, false],
    ['a qualifier on one function', `${FN}x:*`, false],
    ['a qualifier after a function ARN token', join({ 'Fn::GetAtt': ['Fn', 'Arn'] }, ':*'), false],
    ['an alias of one function', join({ 'Fn::GetAtt': ['Fn', 'Arn'] }, ':live'), false],
    ['every route of one API', join(API, { Ref: 'Api' }, '/*'), false],
    ['one stage of one API', join(API, { Ref: 'Api' }, '/prod/*'), false],
  ];
  test.each(RESOURCE_SHAPES)('resource shape: %s is broad = %s', (_name, resource, expected) => {
    expect(broadResource(resource)).toBe(expected);
  });

  const ACTION_SHAPES: Array<[string, boolean]> = [
    ['lambda:InvokeFunction', true],
    ['lambda:invokefunction', true],
    ['Lambda:InvokeFunction', true],
    ['lambda:InvokeFunctionUrl', true],
    ['lambda:InvokeFunction?rl', true],
    ['lambda:InvokeAsync', true],
    ['lambda:Invoke*', true],
    ['*', true],
    ['execute-api:Invoke', true],
    ['execute-api:*', true],
    ['lambda:GetFunction', false],
  ];
  test.each(ACTION_SHAPES)('action shape: %s invokes = %s', (action, expected) => {
    const s = allow(action, 'x');
    expect(invokes(s) || apiInvokes(s)).toBe(expected);
  });

  test('without integHttpReceiver there is no function URL at all', () => {
    expect(synthDemo({ integLocalCell: 'true' }).findResources('AWS::Lambda::Url')).toEqual({});
  });
});
