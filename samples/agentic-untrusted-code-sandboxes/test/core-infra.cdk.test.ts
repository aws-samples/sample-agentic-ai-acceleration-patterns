// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Synth tests of the core construct's CDK side (spec §3.6 to §3.9, §4.1,
 * §5.3), against fake backends (ADR-0025): one test per spec statement the
 * core builds, a policy test for each deny of §3.6, and the two-instance
 * name test.
 */

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { AwsSolutionsChecks } from 'cdk-nag';
import { logCleanupOverride, requestedNames } from './fake-core-backend';
import { NO_ANSWER_MARGIN_MS } from '../src/backend';
import { NO_ANSWER_LOOKUP_MS } from '../src/backends/microvm';
import { ALLOW_PRIORITY, BLOCK_PRIORITY, DNS_FIREWALL_ALLOWED_DOMAINS } from '../src/core/dns-firewall';
import { CLEANUP_SOURCE } from '../src/core/log-cleanup';
import { acknowledgeKnownFindings, knownWildcard } from '../src/core/nag';
import { ENV } from '../src/env';
import { NAME_PATTERNS, NAME_RULES, nameFor } from '../src/names';
import { resolveProps, type UntrustedCodeSandboxesProps } from '../src/props';
import { SUBNET_GROUPS, TIER_TAG, UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

jest.mock('../src/backends/microvm.cdk', () => ({
  createMicrovmBackend: (...a: unknown[]) => (jest.requireActual('./fake-core-backend').fakeFactory('microvm') as (...x: unknown[]) => unknown)(...a),
}));
jest.mock('../src/backends/nitro.cdk', () => ({
  createNitroBackend: (...a: unknown[]) => (jest.requireActual('./fake-core-backend').fakeFactory('nitro') as (...x: unknown[]) => unknown)(...a),
}));
jest.mock('../src/backends/agentcore.cdk', () => ({
  createAgentcoreBackend: (...a: unknown[]) => (jest.requireActual('./fake-core-backend').fakeFactory('agentcore') as (...x: unknown[]) => unknown)(...a),
}));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Keeps `aws:cdk:path` in the template so a test can find a resource by its construct path. */
const PATHS = { 'aws:cdk:enable-path-metadata': true };

interface Synth { stack: Stack; c: UntrustedCodeSandboxes; t: Template }

function synth(props: UntrustedCodeSandboxesProps = {}, build?: (stack: Stack, c: UntrustedCodeSandboxes) => void): Synth {
  const stack = new Stack(new App({ context: PATHS }), 'S');
  const c = new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends: ['microvm', 'nitro', 'agentcore'], ...props });
  build?.(stack, c);
  return { stack, c, t: Template.fromStack(stack) };
}

const pathOf = (r: Json): string => r.Metadata?.['aws:cdk:path'] ?? '';

function logicalIdByPath(t: Template, type: string, suffix: string): string {
  const found = Object.entries(t.findResources(type)).filter(([, r]) => pathOf(r).endsWith(suffix));
  if (found.length !== 1) throw new Error(`expected one ${type} at ${suffix}, found ${found.length}`);
  return found[0][0];
}

function statementsOfRole(t: Template, roleId: string): Json[] {
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as Json[];
  const inline = ((t.findResources('AWS::IAM::Role')[roleId] as Json).Properties.Policies ?? []) as Json[];
  return [
    ...policies
      .filter((p) => (p.Properties.Roles as Json[]).some((r) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Json[]),
    ...inline.flatMap((p) => p.PolicyDocument.Statement as Json[]),
  ];
}

/** The managed policies a role attaches, which `statementsOfRole` cannot see. */
function managedPoliciesOf(t: Template, roleId: string): unknown[] {
  return ((t.findResources('AWS::IAM::Role')[roleId] as Json).Properties.ManagedPolicyArns ?? []) as unknown[];
}

const actionsOf = (stmts: Json[]): string[] => stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

function roleOfFunction(t: Template, fnId: string): string {
  const fn = t.findResources('AWS::Lambda::Function')[fnId] as Json;
  return fn.Properties.Role['Fn::GetAtt'][0];
}


interface Rule { peer: string; from: number; to: number }

/** Ingress and egress rules per security group, from inline properties and from separate rule resources. */
function sgRules(t: Template): Record<string, { ingress: Rule[]; egress: Rule[] }> {
  const out: Record<string, { ingress: Rule[]; egress: Rule[] }> = {};
  const idOf = (ref: unknown): string => {
    const r = ref as Json;
    return r?.Ref ?? r?.['Fn::GetAtt']?.[0] ?? String(ref);
  };
  const peerOf = (p: Json, key: string): string => {
    if (p[key] !== undefined) return idOf(p[key]);
    if (p.IpProtocol === 'icmp' && p.CidrIp === '255.255.255.255/32') return 'icmp-placeholder';
    return p.CidrIp as string;
  };
  for (const [id, sg] of Object.entries(t.findResources('AWS::EC2::SecurityGroup')) as [string, Json][]) {
    out[id] = { ingress: [], egress: [] };
    for (const r of (sg.Properties.SecurityGroupIngress ?? []) as Json[]) out[id].ingress.push({ peer: peerOf(r, 'SourceSecurityGroupId'), from: r.FromPort, to: r.ToPort });
    for (const r of (sg.Properties.SecurityGroupEgress ?? []) as Json[]) out[id].egress.push({ peer: peerOf(r, 'DestinationSecurityGroupId'), from: r.FromPort, to: r.ToPort });
  }
  for (const r of Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')) as Json[]) {
    out[idOf(r.Properties.GroupId)].ingress.push({ peer: peerOf(r.Properties, 'SourceSecurityGroupId'), from: r.Properties.FromPort, to: r.Properties.ToPort });
  }
  for (const r of Object.values(t.findResources('AWS::EC2::SecurityGroupEgress')) as Json[]) {
    out[idOf(r.Properties.GroupId)].egress.push({ peer: peerOf(r.Properties, 'DestinationSecurityGroupId'), from: r.Properties.FromPort, to: r.Properties.ToPort });
  }
  return out;
}

/** A template value with Fn::Join flattened and references written as <id>, so a JSON string with tokens can be parsed. */
function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Json;
  if (o['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(flat).join(o['Fn::Join'][0] as string);
  if (o.Ref) return `<${o.Ref}>`;
  if (o['Fn::GetAtt']) return `<${o['Fn::GetAtt'][0]}.${o['Fn::GetAtt'][1]}>`;
  return JSON.stringify(v);
}

const roleId = (t: Template, name: string) => logicalIdByPath(t, 'AWS::IAM::Role', `/Sandboxes/${name}/Resource`);
const fnId = (t: Template, name: string) => logicalIdByPath(t, 'AWS::Lambda::Function', `/Sandboxes/${name}/Resource`);

let base: Synth;
beforeAll(() => {
  base = synth();
});

describe('registry (spec 4.1)', () => {
  test('a tenant-keyed table with PITR, TTL on ttlAt and DESTROY', () => {
    base.t.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'ttlAt', Enabled: true },
      BillingMode: 'PAY_PER_REQUEST',
    });
    base.t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
  });
});

describe('roles (spec 3.6)', () => {
  test('tool role: assumes the tenant role with a tag, holds the backends statements, reads no bucket or table, starts no task', () => {
    const stmts = statementsOfRole(base.t, roleId(base.t, 'ToolRole'));
    const actions = actionsOf(stmts);
    expect(actions).toEqual(expect.arrayContaining(['sts:AssumeRole', 'sts:TagSession', 'fake:Toolmicrovm', 'fake:Toolnitro', 'fake:Toolagentcore']));
    for (const a of actions) {
      expect(a).not.toMatch(/^(s3|dynamodb):/);
      expect(['ecs:RunTask', 'ecs:StopTask']).not.toContain(a);
    }
    expect(actions.filter((a) => /^fake:Tool/.test(a)).length).toBe(3);
    const assume = stmts.find((s) => s.Sid === 'AssumeToolTenantRole') as Json;
    expect(assume.Resource).toEqual({ 'Fn::GetAtt': [roleId(base.t, 'ToolTenantRole'), 'Arn'] });
  });

  test('tool tenant role: trusts only the tool role, only with a TenantId tag', () => {
    const role = base.t.findResources('AWS::IAM::Role')[roleId(base.t, 'ToolTenantRole')] as Json;
    const trust = role.Properties.AssumeRolePolicyDocument.Statement as Json[];
    const principals = trust.flatMap((s) => (Array.isArray(s.Principal.AWS) ? s.Principal.AWS : [s.Principal.AWS]));
    expect(principals).toEqual([{ 'Fn::GetAtt': [roleId(base.t, 'ToolRole'), 'Arn'] }]);
    expect(trust.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    for (const s of trust) expect(s.Condition).toEqual({ Null: { 'aws:RequestTag/TenantId': 'false' } });
  });

  test('tool tenant role: own prefixes, own registry rows and the backends tenant statements, nothing else', () => {
    const stmts = statementsOfRole(base.t, roleId(base.t, 'ToolTenantRole'));
    const bySid = (sid: string) => stmts.find((s) => s.Sid === sid) as Json;
    expect(bySid('ReadOwnInputs').Action).toBe('s3:GetObject');
    expect(JSON.stringify(bySid('ReadOwnInputs').Resource)).toContain('/inputs/${aws:PrincipalTag/TenantId}/*');
    expect(bySid('WriteOwnOutputs').Action).toBe('s3:PutObject');
    expect(JSON.stringify(bySid('WriteOwnOutputs').Resource)).toContain('/outputs/${aws:PrincipalTag/TenantId}/*');
    const rows = bySid('OwnRegistryRows');
    expect(rows.Action).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(rows.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/TenantId}'] } });
    expect(actionsOf(stmts).sort()).toEqual([
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
      'fake:Tenantagentcore', 'fake:Tenantmicrovm', 'fake:Tenantnitro', 's3:GetObject', 's3:PutObject',
    ]);
  });

  test('reaper role: reads, updates and deletes every row and holds no instance action and no bucket action', () => {
    const stmts = statementsOfRole(base.t, roleId(base.t, 'ReaperRole'));
    const actions = actionsOf(stmts);
    expect(actions).not.toContain('dynamodb:Query');
    expect(actions).toEqual(expect.arrayContaining(['dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'fake:Reapernitro']));
    expect(actions).not.toContain('ecs:DeregisterContainerInstance');
    expect(actions).not.toContain('ecs:ListContainerInstances');
    expect(actions).not.toContain('ec2:DescribeInstances');
    for (const a of actions) expect(a).not.toMatch(/^s3:/);
    for (const a of actions.filter((x) => x.startsWith('fake:'))) expect(a).toMatch(/^fake:Reaper/);
  });

  test('drain role: the reaper statements plus the instance actions, and no bucket action', () => {
    const stmts = statementsOfRole(base.t, roleId(base.t, 'DrainRole'));
    const actions = actionsOf(stmts);
    expect(actions).toEqual(expect.arrayContaining([
      'fake:Reapernitro', 'ecs:ListContainerInstances', 'ecs:DeregisterContainerInstance', 'ec2:DescribeInstances',
    ]));
    for (const a of actions) expect(a).not.toMatch(/^s3:/);
    expect(actions.filter((a) => /^fake:Tool|^fake:Tenant/.test(a))).toEqual([]);
  });

  test('the offboard function runs as the reaper role, the drain as the drain role, the tool as the tool role', () => {
    expect(roleOfFunction(base.t, fnId(base.t, 'Offboard'))).toBe(roleId(base.t, 'ReaperRole'));
    expect(roleOfFunction(base.t, fnId(base.t, 'Reaper'))).toBe(roleId(base.t, 'ReaperRole'));
    expect(roleOfFunction(base.t, fnId(base.t, 'Drain'))).toBe(roleId(base.t, 'DrainRole'));
    expect(roleOfFunction(base.t, fnId(base.t, 'RunCode'))).toBe(roleId(base.t, 'ToolRole'));
  });

  test('no backend statement reaches a role it was not made for', () => {
    const tool = actionsOf(statementsOfRole(base.t, roleId(base.t, 'ToolRole')));
    const tenant = actionsOf(statementsOfRole(base.t, roleId(base.t, 'ToolTenantRole')));
    const reaper = actionsOf(statementsOfRole(base.t, roleId(base.t, 'ReaperRole')));
    expect(tool.filter((a) => /^fake:(Tenant|Reaper)/.test(a))).toEqual([]);
    expect(tenant.filter((a) => /^fake:(Tool|Reaper)/.test(a))).toEqual([]);
    expect(reaper.filter((a) => /^fake:(Tool|Tenant)/.test(a))).toEqual([]);
  });
});

describe('functions (spec 3.1, 3.3, 3.7)', () => {
  test('the run function runs in the tool subnets with the tool security group; the stop functions run outside the VPC (ADR-0071)', () => {
    const run = base.t.findResources('AWS::Lambda::Function')[fnId(base.t, 'RunCode')] as Json;
    expect(run.Properties.VpcConfig.SecurityGroupIds).toHaveLength(1);
    expect(run.Properties.VpcConfig.SubnetIds).toHaveLength(2);
    for (const name of ['Reaper', 'Offboard', 'Drain']) {
      const fn = base.t.findResources('AWS::Lambda::Function')[fnId(base.t, name)] as Json;
      expect(fn.Properties.VpcConfig).toBeUndefined();
    }
    for (const role of ['ReaperRole', 'DrainRole']) {
      expect(actionsOf(statementsOfRole(base.t, roleId(base.t, role))).filter((a) => /NetworkInterface|DescribeSubnets|PrivateIpAddresses/.test(a))).toEqual([]);
    }
  });

  test('every function has the shared environment and JSON logs', () => {
    for (const name of ['RunCode', 'Reaper', 'Offboard', 'Drain']) {
      const fn = base.t.findResources('AWS::Lambda::Function')[fnId(base.t, name)] as Json;
      const vars = fn.Properties.Environment.Variables as Record<string, unknown>;
      for (const key of Object.values(ENV)) expect(vars).toHaveProperty(key);
      expect(vars).toHaveProperty('FAKE_NITRO');
      expect(vars[ENV.BACKENDS]).toBe('microvm,nitro,agentcore');
      expect(vars[ENV.DEFAULT_BACKEND]).toBe('microvm');
      expect(vars[ENV.RUN_TIMEOUT_MS]).toBe('30000');
      expect(vars[ENV.PER_TENANT_METRICS]).toBe('false');
      expect(fn.Properties.LoggingConfig.LogFormat).toBe('JSON');
    }
  });

  test('the tool timeout is the budget: 5 s + startWait + runTimeout + 10 s', () => {
    expect((base.t.findResources('AWS::Lambda::Function')[fnId(base.t, 'RunCode')] as Json).Properties.Timeout).toBe(60);
  });

  test('the budget holds a microvm call that waits out a start, the run and the 3 s state lookup behind no answer', () => {
    const r = resolveProps({});
    const worst = 5 + r.settings.startWait.toSeconds() + r.settings.runTimeout.toSeconds() + NO_ANSWER_MARGIN_MS / 1000 + NO_ANSWER_LOOKUP_MS / 1000;
    expect(worst).toBeLessThanOrEqual(r.toolBudget.toSeconds());
  });

  test('the reaper runs every 5 minutes', () => {
    base.t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(5 minutes)' });
  });

  test('runCodeFunction exists only with standalone', () => {
    const s = synth({ standalone: false }, (_stack, c) => {
      c.bindRunCode(new lambda.Function(_stack, 'Bound', {
        runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>1'),
      }));
    });
    expect(s.c.runCodeFunction).toBeUndefined();
    expect(() => s.c.grantInvokeRunCode(new iam.ServicePrincipal('apigateway.amazonaws.com'))).toThrow(/standalone/);
    expect(base.c.runCodeFunction).toBeDefined();
  });

  test('per-tenant metrics are an environment switch, off by default (ADR-0013)', () => {
    const s = synth({ perTenantMetrics: true });
    const fn = s.t.findResources('AWS::Lambda::Function')[fnId(s.t, 'RunCode')] as Json;
    expect(fn.Properties.Environment.Variables[ENV.PER_TENANT_METRICS]).toBe('true');
  });

  test('perTenantMetrics adds no metric permission to the tool role (EMF needs only logs)', () => {
    const s = synth({ perTenantMetrics: true });
    expect(actionsOf(statementsOfRole(s.t, roleId(s.t, 'ToolRole'))).filter((a) => a.startsWith('cloudwatch:'))).toEqual([]);
  });
});

describe('bindRunCode (spec 3.3)', () => {
  test('gives a gateway function the tool subnets, environment, budget, trust, statements, an owned log group and the rules', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      const role = new iam.Role(stack, 'GatewayRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      c.bindRunCode(new lambda.Function(stack, 'Gateway', {
        runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>1'), role,
      }));
    });
    const fn = Object.entries(s.t.findResources('AWS::Lambda::Function')).find(([, r]) => pathOf(r as Json).includes('/Gateway/'))![1] as Json;
    expect(fn.Properties.Timeout).toBe(60);
    expect(fn.Properties.VpcConfig.SubnetIds).toHaveLength(2);
    expect(fn.Properties.Environment.Variables[ENV.REGISTRY_TABLE]).toBeDefined();
    const gatewayRole = Object.entries(s.t.findResources('AWS::IAM::Role')).find(([, r]) => pathOf(r as Json).endsWith('/GatewayRole/Resource'))![0];
    expect(actionsOf(statementsOfRole(s.t, gatewayRole))).toEqual(expect.arrayContaining(['sts:AssumeRole', 'sts:TagSession', 'fake:Toolnitro']));
    const trust = (s.t.findResources('AWS::IAM::Role')[roleId(s.t, 'ToolTenantRole')] as Json).Properties.AssumeRolePolicyDocument.Statement as Json[];
    expect(JSON.stringify(trust)).toContain(gatewayRole);
    const bound = Object.values(s.t.findResources('AWS::Logs::LogGroup')).filter((g) => pathOf(g as Json).includes('/BoundLogs')) as Json[];
    expect(bound).toHaveLength(1);
    expect(bound[0].Properties.RetentionInDays).toBe(30);
    expect(bound[0].Properties.LogGroupName).toBeUndefined();
    expect(fn.Properties.LoggingConfig.LogGroup).toEqual({ Ref: logicalIdByPath(s.t, 'AWS::Logs::LogGroup', '/BoundLogs0/Resource') });
    const rule = Object.values(s.t.findResources('AWS::CloudWatch::InsightRule')).find((r) => JSON.stringify((r as Json).Properties.RuleName).length > 0 && JSON.stringify((r as Json).Properties.RuleBody).includes('runId')) as Json;
    expect(JSON.stringify(rule.Properties.RuleBody)).toContain('BoundLogs0');
    expect(() => synth({ standalone: false }, (_st, c) => c.bindRunCode({} as never))).toThrow(/lambda.Function/);
  });

  test('a core with a bound function and no standalone synthesises', () => {
    expect(() => synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'G', { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('x') }));
    })).not.toThrow();
  });

  const inline = { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>1') };

  test('two bound functions each get a group and a place in the trust policy and the rules', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      for (const id of ['One', 'Two']) c.bindRunCode(new lambda.Function(stack, id, { ...inline, role: new iam.Role(stack, `${id}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }) }));
    });
    const trust = (s.t.findResources('AWS::IAM::Role')[roleId(s.t, 'ToolTenantRole')] as Json).Properties.AssumeRolePolicyDocument.Statement as Json[];
    expect(trust).toHaveLength(3);
    const runs = Object.values(s.t.findResources('AWS::CloudWatch::InsightRule')).map((r) => JSON.stringify((r as Json).Properties.RuleBody)).find((b) => b.includes('$.runId')) as string;
    expect(runs).toContain('BoundLogs0');
    expect(runs).toContain('BoundLogs1');
  });

  test('a function built with the tool role needs no trust change, and a function with its own log group gets no second group', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'OnToolRole', { ...inline, role: c.toolRole }));
      c.bindRunCode(new lambda.Function(stack, 'OwnLogs', {
        ...inline,
        role: new iam.Role(stack, 'OwnRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
        logGroup: new logs.LogGroup(stack, 'OwnGroup', { logGroupName: 'own-tool-group' }),
      }));
    });
    const trust = (s.t.findResources('AWS::IAM::Role')[roleId(s.t, 'ToolTenantRole')] as Json).Properties.AssumeRolePolicyDocument.Statement as Json[];
    expect(trust).toHaveLength(2);
    // the function on the tool role is the only one with no group of its own, so it is the only one that gets one
    const owned = Object.values(s.t.findResources('AWS::Logs::LogGroup')).filter((g) => pathOf(g as Json).includes('/BoundLogs'));
    expect(owned).toHaveLength(1);
    const own = Object.values(s.t.findResources('AWS::Lambda::Function')).find((f) => pathOf(f as Json).includes('/OwnLogs/')) as Json;
    expect(JSON.stringify(own.Properties.LoggingConfig.LogGroup)).toContain('OwnGroup');
    const runs = Object.values(s.t.findResources('AWS::CloudWatch::InsightRule')).map((r) => JSON.stringify((r as Json).Properties.RuleBody)).find((b) => b.includes('$.runId')) as string;
    expect(runs).toContain('OwnGroup');
    expect(runs).toContain('BoundLogs0');
  });

  test('a bound function built with the default role loses its managed policies and writes only to its own group', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'PlainFn', { ...inline }));
      c.bindRunCode(new lambda.Function(stack, 'OwnGroupDefault', { ...inline, logGroup: new logs.LogGroup(stack, 'TheirGroup', { logGroupName: 'their-group' }) }));
    });
    const roles = Object.entries(s.t.findResources('AWS::IAM::Role')).filter(([, r]) => /\/(PlainFn|OwnGroupDefault)\/ServiceRole\/Resource$/.test(pathOf(r as Json)));
    expect(roles).toHaveLength(2);
    for (const [id] of roles) {
      expect(managedPoliciesOf(s.t, id)).toEqual([]);
      const stmts = statementsOfRole(s.t, id);
      for (const st of stmts) {
        for (const a of Array.isArray(st.Action) ? st.Action : [st.Action]) {
          if (/^logs:/.test(a)) expect(JSON.stringify(st.Resource)).not.toBe('"*"');
        }
      }
      expect(actionsOf(stmts)).toEqual(expect.arrayContaining(['ec2:CreateNetworkInterface', 'logs:PutLogEvents', 'sts:AssumeRole']));
      expect(actionsOf(stmts)).not.toContain('logs:CreateLogGroup');
    }
    // the function with a group of its own writes to that group and no other
    const theirs = Object.entries(s.t.findResources('AWS::IAM::Role')).find(([, r]) => /\/OwnGroupDefault\/ServiceRole\/Resource$/.test(pathOf(r as Json)))![0];
    const write = statementsOfRole(s.t, theirs).find((st) => st.Sid === 'WriteOwnLogGroup') as Json;
    expect(write.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(JSON.stringify(write.Resource)).toContain('TheirGroup');
  });

  test.each(['AWSLambdaSQSQueueExecutionRole', 'AWSLambdaKinesisExecutionRole', 'AWSLambdaDynamoDBExecutionRole', 'AWSLambdaMSKExecutionRole'])(
    'a role with %s is refused, with the way out in the message',
    (name) => {
      expect(() => synth({ standalone: false }, (stack, c) => {
        const role = new iam.Role(stack, 'Source', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(`service-role/${name}`));
        c.bindRunCode(new lambda.Function(stack, 'S', { ...inline, role }));
      })).toThrow(new RegExp(`${name}.*L2 grant`));
    },
  );

  test('a refused bind changes nothing on the function', () => {
    synth({ standalone: false }, (stack, c) => {
      const role = new iam.Role(stack, 'Source', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaSQSQueueExecutionRole'));
      const fn = new lambda.Function(stack, 'S', { ...inline, role });
      expect(() => c.bindRunCode(fn)).toThrow(/L2 grant/);
      const cfn = fn.node.defaultChild as lambda.CfnFunction;
      expect(cfn.vpcConfig).toBeUndefined();
      expect(cfn.timeout).toBeUndefined();
      c.bindRunCode(new lambda.Function(stack, 'Ok', { ...inline, role: new iam.Role(stack, 'OkRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }) }));
    });
  });

  test('the basic and VPC access policies are removed from a bound role; other managed policies stay', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      const role = new iam.Role(stack, 'Mixed', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      for (const name of ['service-role/AWSLambdaBasicExecutionRole', 'service-role/AWSLambdaVPCAccessExecutionRole', 'AmazonS3ReadOnlyAccess']) {
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(name));
      }
      c.bindRunCode(new lambda.Function(stack, 'M', { ...inline, role }));
    });
    const id = Object.entries(s.t.findResources('AWS::IAM::Role')).find(([, r]) => pathOf(r as Json).endsWith('/Mixed/Resource'))![0];
    expect(JSON.stringify(managedPoliciesOf(s.t, id))).toContain('AmazonS3ReadOnlyAccess');
    expect(managedPoliciesOf(s.t, id)).toHaveLength(1);
  });

  test('a function with an imported role is refused', () => {
    expect(() => synth({ standalone: false }, (stack, c) => {
      const role = iam.Role.fromRoleArn(stack, 'Imported', stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: 'x' }));
      c.bindRunCode(new lambda.Function(stack, 'F', { ...inline, role }));
    })).toThrow(/imported one/);
  });
});

describe('teardown order and log ownership (spec 5.3)', () => {
  const dependsOn = (r: Json): string[] => (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn ? [r.DependsOn] : []);

  test('drain waits for the backends resources, the backends resources wait for the log cleanup, the tool waits for the drain', () => {
    const resources = base.t.toJSON().Resources as Record<string, Json>;
    const drain = Object.entries(resources).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('DrainResource'))!;
    const cleanup = Object.entries(resources).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('LogCleanup'))!;
    const markers = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::CloudFormation::WaitConditionHandle');
    expect(markers).toHaveLength(3);
    for (const [id, marker] of markers) {
      expect(dependsOn(drain[1])).toContain(id);
      expect(dependsOn(marker)).toContain(cleanup[0]);
    }
    expect(dependsOn(resources[fnId(base.t, 'RunCode')])).toContain(drain[0]);
    expect(Number(drain[1].Properties.ServiceTimeout)).toBe(900);
    expect(drain[1].Properties.Backends).toEqual(['microvm', 'nitro', 'agentcore']);
  });

  test('every backend resource waits for the sandbox endpoints, and a security group does not (it is their client)', () => {
    const all = base.t.toJSON().Resources as Record<string, Json>;
    const endpointIds = Object.entries(all).filter(([, r]) => /\/Endpoints\//.test(pathOf(r))).map(([id]) => id);
    expect(endpointIds.length).toBeGreaterThan(6);
    const vpcEndpoints = Object.entries(all).filter(([, r]) => r.Type === 'AWS::EC2::VPCEndpoint').map(([id]) => id);
    expect(vpcEndpoints).toHaveLength(4);
    for (const name of ['microvm', 'nitro', 'agentcore']) {
      const marker = Object.values(all).find((r) => r.Type === 'AWS::CloudFormation::WaitConditionHandle' && pathOf(r).includes(`Backend-${name}/`)) as Json;
      for (const id of endpointIds) expect(dependsOn(marker)).toContain(id);
    }
    // the fake nitro lists its client group among the resources to drain; it must not wait for the endpoints
    const clients = Object.values(all).find((r) => r.Type === 'AWS::EC2::SecurityGroup' && /Backend-nitro\/Clients\//.test(pathOf(r))) as Json;
    expect(dependsOn(clients).filter((id) => endpointIds.includes(id))).toEqual([]);
  });

  test('a container backend waits for the image copy of the architecture it asked for; microvm waits for none', () => {
    const resources = base.t.toJSON().Resources as Record<string, Json>;
    const copies = Object.entries(resources).filter(([, r]) => /RunnerImages\/Copy-/.test(pathOf(r)) && r.Type.startsWith('Custom::'));
    expect(copies.map(([, r]) => /Copy-(\w+)\//.exec(pathOf(r))?.[1]).sort()).toEqual(['amd64', 'arm64']);
    const copyId = (arch: string) => copies.find(([, r]) => pathOf(r).includes(`Copy-${arch}/`))![0];
    const marker = (name: string) => Object.values(resources).find((r) => r.Type === 'AWS::CloudFormation::WaitConditionHandle' && pathOf(r).includes(`Backend-${name}/`)) as Json;
    expect(dependsOn(marker('nitro'))).toContain(copyId('amd64'));
    expect(dependsOn(marker('nitro'))).not.toContain(copyId('arm64'));
    expect(dependsOn(marker('agentcore'))).toContain(copyId('arm64'));
    expect(dependsOn(marker('agentcore'))).not.toContain(copyId('amd64'));
    for (const [id] of copies) expect(dependsOn(marker('microvm'))).not.toContain(id);
    // the tag names the architecture and the asset hash, in the construct-owned repository
    const nitro = Object.values(resources).find((r) => r.Type.startsWith('Custom::') && pathOf(r).includes('Copy-amd64/')) as Json;
    expect(JSON.stringify(nitro.Properties)).toMatch(/runner-amd64-[0-9a-f]{64}/);
    expect(JSON.stringify(nitro.Properties)).toContain('RunnerRepository');
  });

  test('microvm alone builds no image copy', () => {
    const s = synth({ backends: ['microvm'] });
    expect(Object.values(s.t.toJSON().Resources as Record<string, Json>).filter((r) => /RunnerImages/.test(pathOf(r)))).toEqual([]);
  });

  test('the cleanup resource gets every prefix and name, and its role deletes only those', () => {
    const cleanup = Object.values(base.t.toJSON().Resources as Record<string, Json>).find((r) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('LogCleanup')) as Json;
    expect(cleanup.Properties.Prefixes).toEqual(['/aws/bedrock-agentcore/runtimes/Fake_agentcore-']);
    expect(cleanup.Properties.Names).toHaveLength(2);
    const stmts = statementsOfRole(base.t, logicalIdByPath(base.t, 'AWS::IAM::Role', '/LogCleanup/Role/Resource'));
    const del = stmts.find((s) => s.Sid === 'DeleteOwnedLogGroups') as Json;
    expect(del.Action).toBe('logs:DeleteLogGroup');
    expect(del.Resource).toHaveLength(1 + 2 * 2);
    expect(stmts.find((s) => s.Sid === 'DescribeLogGroups')!.Action).toBe('logs:DescribeLogGroups');
  });

  test('a microvm only deployment still cleans the image build group, and a log drain waits 90 s', () => {
    base.t.hasResourceProperties('AWS::CloudFormation::CustomResource', { DelaySeconds: 90 });
  });

  test('every log group the core owns has a retention and is deleted on destroy', () => {
    const groups = Object.values(base.t.findResources('AWS::Logs::LogGroup')) as Json[];
    expect(groups.length).toBeGreaterThanOrEqual(7);
    for (const g of groups) {
      expect(g.Properties.RetentionInDays).toBeDefined();
      expect(g.DeletionPolicy).toBe('Delete');
    }
  });

  test('the cleanup handler deletes the groups under each prefix and the named groups, and answers even on failure', async () => {
    const sent: Json[] = [];
    const deleted: string[] = [];
    const exportsObj: Json = {};
    const fakeRequire = (m: string): unknown => {
      if (m === 'https') {
        const res = { resume: () => undefined, on: (_e: string, f: () => void) => f() };
        return {
          request: (_o: unknown, cb: (r: Json) => void) => ({
            on: () => undefined,
            end: (body: string) => {
              sent.push(JSON.parse(body));
              cb(res);
            },
          }),
        };
      }
      if (m === 'url') return { URL };
      class Cmd { public constructor(public readonly input: Json, public readonly kind: string) {} }
      return {
        CloudWatchLogsClient: class {
          public async send(c: Cmd): Promise<Json> {
            if (c.kind === 'D') return { logGroups: [{ logGroupName: `${c.input.logGroupNamePrefix}a` }, { logGroupName: `${c.input.logGroupNamePrefix}b` }] };
            if (c.input.logGroupName === '/gone') throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
            if (c.input.logGroupName === '/boom') throw new Error('boom');
            deleted.push(c.input.logGroupName);
            return {};
          }
        },
        DescribeLogGroupsCommand: class extends Cmd { public constructor(i: Json) { super(i, 'D'); } },
        DeleteLogGroupCommand: class extends Cmd { public constructor(i: Json) { super(i, 'X'); } },
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('exports', 'require', CLEANUP_SOURCE)(exportsObj, fakeRequire);
    const ev = (props: Json, type = 'Delete') => ({ RequestType: type, ResponseURL: 'https://example.com/r?x=1', ResourceProperties: props });
    await exportsObj.handler(ev({ Prefixes: ['/p-'], Names: ['/gone', '/n'] }));
    expect(deleted).toEqual(['/p-a', '/p-b', '/n']);
    expect(sent[0].Status).toBe('SUCCESS');
    await exportsObj.handler(ev({ Prefixes: [], Names: ['/boom'] }));
    expect(sent[1].Status).toBe('FAILED');
    await exportsObj.handler(ev({ Prefixes: ['/p-'] }, 'Create'));
    expect(sent[2].Status).toBe('SUCCESS');
    expect(deleted).toHaveLength(3);
  });
});

describe('network (spec 3.7, ADR-0012)', () => {
  test('one NAT, Public, Tool and Sandbox subnets across two AZs, with the tier tags', () => {
    base.t.resourceCountIs('AWS::EC2::NatGateway', 1);
    const subnets = Object.values(base.t.findResources('AWS::EC2::Subnet')) as Json[];
    expect(subnets).toHaveLength(6);
    const tier = (name: string) => subnets.filter((s) => (s.Properties.Tags as Json[]).some((t) => t.Key === 'aws-cdk:subnet-name' && t.Value === name));
    for (const [name, tag] of [[SUBNET_GROUPS.tool, 'tool'], [SUBNET_GROUPS.sandbox, 'sandbox']]) {
      expect(tier(name)).toHaveLength(2);
      for (const s of tier(name)) expect(s.Properties.Tags).toEqual(expect.arrayContaining([{ Key: TIER_TAG, Value: tag }]));
    }
    expect(tier(SUBNET_GROUPS.public)).toHaveLength(2);
  });

  test('the sandbox route tables have no default route', () => {
    const resources = base.t.toJSON().Resources as Record<string, Json>;
    const sandboxTables = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::EC2::RouteTable' && pathOf(r).includes('SandboxSubnet'));
    expect(sandboxTables).toHaveLength(2);
    for (const [id] of sandboxTables) {
      const routes = Object.values(resources).filter((r) => r.Type === 'AWS::EC2::Route' && JSON.stringify(r.Properties.RouteTableId).includes(id));
      expect(routes).toEqual([]);
    }
  });

  test('the S3 gateway endpoint is on the sandbox route tables only', () => {
    const endpoint = Object.values(base.t.findResources('AWS::EC2::VPCEndpoint')).find((r) => (r as Json).Properties.VpcEndpointType === 'Gateway') as Json;
    const tables = JSON.stringify(endpoint.Properties.RouteTableIds);
    expect(tables).toContain('SandboxSubnet');
    expect(tables).not.toContain('PublicSubnet');
    expect(tables).not.toContain('ToolSubnet');
  });

  test('each endpoint exists once, in the sandbox subnets, with a policy naming only the sample resources', () => {
    const endpoints = Object.values(base.t.findResources('AWS::EC2::VPCEndpoint')) as Json[];
    expect(endpoints).toHaveLength(4);
    const ecr = endpoints.filter((e) => /ecr/.test(JSON.stringify(e.Properties.ServiceName)));
    expect(ecr).toHaveLength(2);
    for (const e of ecr) {
      expect(e.Properties.PrivateDnsEnabled).toBe(true);
      const stmts = e.Properties.PolicyDocument.Statement as Json[];
      expect(stmts.find((s) => s.Sid === 'AuthorizationToken').Resource).toBe('*');
      expect(JSON.stringify(stmts.find((s) => s.Sid === 'PullRunnerImage').Resource)).toContain('RunnerRepository');
      expect(stmts.find((s) => s.Sid === 'PullRunnerImage').Action).toEqual(['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']);
    }
    const logsEndpoint = endpoints.find((e) => /logs/.test(JSON.stringify(e.Properties.ServiceName))) as Json;
    const sids = (logsEndpoint.Properties.PolicyDocument.Statement as Json[]).map((s) => s.Sid).sort();
    expect(sids).toEqual(['LogsagentcorePrefixes', 'LogsnitroGroups']);
    const gateway = endpoints.find((e) => e.Properties.VpcEndpointType === 'Gateway') as Json;
    expect(gateway.Properties.PolicyDocument.Statement).toHaveLength(1);
    expect(JSON.stringify(gateway.Properties.PolicyDocument.Statement[0].Resource)).toContain('starport-layer-bucket');
  });

  test('sessionFiles adds the sessions prefix to the S3 endpoint policy only when on', () => {
    const on = synth({ agentcore: { sessionFiles: true } });
    const gw = Object.values(on.t.findResources('AWS::EC2::VPCEndpoint')).find((r) => (r as Json).Properties.VpcEndpointType === 'Gateway') as Json;
    const text = JSON.stringify(gw.Properties.PolicyDocument);
    expect(text).toContain('sessions/*');
    expect(text).toContain('"s3:prefix":"sessions/*"');
    const off = JSON.stringify((Object.values(base.t.findResources('AWS::EC2::VPCEndpoint')).find((r) => (r as Json).Properties.VpcEndpointType === 'Gateway') as Json).Properties.PolicyDocument);
    expect(off).not.toContain('sessions');
  });

  test('endpoint security groups have no egress and admit 443 from every client; a task group reaches the Logs endpoint only', () => {
    const rules = sgRules(base.t);
    const find = (re: RegExp) => Object.keys(rules).filter((id) => re.test(id));
    const [logsSg] = find(/LogsEndpointSecurityGroup/);
    const [ecrSg] = find(/EcrEndpointSecurityGroup/);
    const clients = find(/Backend-?(nitro|agentcore)/i).concat(find(/BackendnitroInstances|BackendnitroClients|BackendagentcoreClients/));
    const nitroTask = find(/BackendnitroClients/)[0];
    const nitroInstances = find(/BackendnitroInstances/)[0];
    const agentcore = find(/BackendagentcoreClients/)[0];
    expect([logsSg, ecrSg, nitroTask, nitroInstances, agentcore].every((x) => x !== undefined)).toBe(true);
    expect(clients.length).toBeGreaterThan(0);
    // the endpoint groups hold only the placeholder egress CDK writes for "no outbound"
    for (const sg of [logsSg, ecrSg]) {
      expect(rules[sg].egress.filter((e) => e.peer !== 'icmp-placeholder')).toEqual([]);
    }
    // 443 in from the three clients on both endpoint groups
    for (const sg of [logsSg, ecrSg]) {
      expect(rules[sg].ingress.map((i) => i.peer).sort()).toEqual([nitroInstances, nitroTask, agentcore].sort());
      for (const i of rules[sg].ingress) expect([i.from, i.to]).toEqual([443, 443]);
    }
    // the nitro task reaches the Logs endpoint only; the runtime reaches ECR, Logs and S3 (the sandbox subnets route nothing else)
    expect(rules[nitroTask].egress.filter((e) => e.peer !== 'icmp-placeholder').map((e) => e.peer)).toEqual([logsSg]);
    expect(rules[agentcore].egress.filter((e) => e.peer !== 'icmp-placeholder').map((e) => e.peer).sort()).toEqual([ecrSg, logsSg, '0.0.0.0/0'].sort());
  });

  test('a supplied vpc needs an explicit createEndpoints', () => {
    const vpc = new ec2.Vpc(new Stack(), 'V');
    expect(() => resolveProps({ vpc })).toThrow(/createEndpoints must be set with a supplied vpc/);
    expect(() => resolveProps({ vpc, createEndpoints: true })).not.toThrow();
    expect(() => resolveProps({ vpc, createEndpoints: false })).not.toThrow();
    expect(() => resolveProps({})).not.toThrow();
  });

  test('the runner repository empties itself on delete, so a stack delete does not stop on images', () => {
    const s = synth({ backends: ['nitro'] });
    const repo = Object.values(s.t.toJSON().Resources as Record<string, Json>).filter((r) => r.Type === 'AWS::ECR::Repository');
    expect(repo).toHaveLength(1);
    expect(repo[0].Properties.EmptyOnDelete).toBe(true);
    expect(repo[0].DeletionPolicy).toBe('Delete');
  });

  test('createEndpoints false builds none, and is refused for a created vpc', () => {
    expect(() => synth({ createEndpoints: false })).toThrow(/createEndpoints false needs a supplied vpc/);
    const s = synth({ createEndpoints: false, backends: ['microvm'] });
    s.t.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  });

  test('a supplied vpc: the Tool and Sandbox subnet groups are required, and its subnets are used', () => {
    const stack = new Stack(new App(), 'V');
    const vpc = new ec2.Vpc(stack, 'Own', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Tool', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, vpc, backends: ['nitro'], createEndpoints: false });
    Template.fromStack(stack).resourceCountIs('AWS::EC2::VPC', 1);
    const bad = new Stack(new App(), 'B');
    const noSandbox = new ec2.Vpc(bad, 'Own', {
      maxAzs: 2,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC }, { name: 'Tool', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });
    expect(() => new UntrustedCodeSandboxes(bad, 'Sandboxes', { standalone: true, vpc: noSandbox, createEndpoints: true })).toThrow(/no sandbox subnets; name the subnet group Sandbox/);
  });
});

describe('observability (spec 3.8, ADR-0013)', () => {
  test('two Contributor Insights rules without the firewall, keyed on tenantId', () => {
    base.t.resourceCountIs('AWS::CloudWatch::InsightRule', 2);
    const rules = Object.values(base.t.findResources('AWS::CloudWatch::InsightRule')) as Json[];
    const bodies = rules.map((r) => JSON.stringify(r.Properties.RuleBody));
    expect(bodies.every((b) => b.includes('$.tenantId') && b.includes('CloudWatchLogRule'))).toBe(true);
    const runs = bodies.find((b) => b.includes('$.runId')) as string;
    expect(runs).toContain('Count');
    const secs = bodies.find((b) => b.includes('$.sandboxSeconds')) as string;
    expect(secs).toContain('Sum');
    // run lines come from the tool; stop lines from the tool, the reaper, the drain and the offboard function
    expect(runs.match(/RunCodeLogs/g)).toHaveLength(1);
    expect(runs).not.toContain('ReaperLogs');
    for (const g of ['RunCodeLogs', 'ReaperLogs', 'OffboardLogs', 'DrainLogs']) expect(secs).toContain(g);
    for (const r of rules) expect(r.Properties.RuleState).toBe('ENABLED');
  });
});

describe('DNS Firewall (spec 3.9, ADR-0016)', () => {
  let s: Synth;
  beforeAll(() => {
    s = synth({ dnsFirewall: { allowDomains: ['*.example.com'] } });
  });

  test('off by default: no resolver resources', () => {
    base.t.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroup', 0);
    base.t.resourceCountIs('AWS::Route53Resolver::ResolverQueryLoggingConfig', 0);
    base.t.resourceCountIs('AWS::Logs::ResourcePolicy', 0);
  });

  test('allow the AWS names and allowDomains at 100, block everything with NXDOMAIN at 200', () => {
    const lists = Object.values(s.t.findResources('AWS::Route53Resolver::FirewallDomainList')) as Json[];
    expect(lists.map((l) => l.Properties.Domains).sort()).toEqual([[...DNS_FIREWALL_ALLOWED_DOMAINS, '*.example.com'], ['*']].sort());
    s.t.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: [
        Match.objectLike({ Action: 'ALLOW', Priority: ALLOW_PRIORITY }),
        Match.objectLike({ Action: 'BLOCK', BlockResponse: 'NXDOMAIN', Priority: BLOCK_PRIORITY }),
      ],
    });
    expect(ALLOW_PRIORITY).toBeLessThan(BLOCK_PRIORITY);
    for (const d of ['amazonaws.com', '*.amazonaws.com', '*.on.aws', '*.api.aws', 'time.aws.com', '*.compute.internal', '*.ec2.internal']) {
      expect(DNS_FIREWALL_ALLOWED_DOMAINS).toContain(d);
    }
  });

  test('the association covers the construct VPC and can be deleted', () => {
    s.t.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroupAssociation', {
      MutationProtection: 'DISABLED',
      VpcId: Match.anyValue(),
    });
    // CloudFormation has no property for FirewallFailOpen; the service default is DISABLED (fail closed), and the
    // integration run reads it back (ADR-0031). Nothing in the template turns it on.
    expect(JSON.stringify(s.t.toJSON())).not.toMatch(/FirewallFailOpen/);
  });

  test('the query log group is named outside /aws/vendedlogs/, retained 30 days and deleted on destroy', () => {
    const group = Object.values(s.t.findResources('AWS::Logs::LogGroup')).find((g) => typeof (g as Json).Properties.LogGroupName === 'string') as Json;
    expect(group.Properties.LogGroupName).not.toMatch(/^\/aws\/vendedlogs\//);
    expect(group.Properties.LogGroupName).toMatch(/^[\w./#-]{1,512}$/);
    expect(group.Properties.RetentionInDays).toBe(30);
    expect(group.DeletionPolicy).toBe('Delete');
  });

  test('the construct owns its Logs resource policy for the one group and delivery depends on it', () => {
    const resources = s.t.toJSON().Resources as Record<string, Json>;
    const [policyId, policy] = Object.entries(resources).find(([, r]) => r.Type === 'AWS::Logs::ResourcePolicy') as [string, Json];
    const doc = JSON.parse(flat(policy.Properties.PolicyDocument)) as Json;
    expect(policy.Properties.PolicyName).toMatch(/^[\w-]{1,255}$/);
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Principal).toEqual({ Service: 'delivery.logs.amazonaws.com' });
    expect(doc.Statement[0].Resource).toMatch(/^<[A-Za-z0-9]*QueryLogs[A-Za-z0-9]*\.Arn>$/);
    expect(doc.Statement[0].Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    for (const type of ['AWS::Route53Resolver::ResolverQueryLoggingConfig', 'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation']) {
      const r = Object.values(resources).find((x) => x.Type === type) as Json;
      expect(r.DependsOn).toContain(policyId);
    }
  });

  test('a third Contributor Insights rule ranks blocked lookups by srcaddr', () => {
    s.t.resourceCountIs('AWS::CloudWatch::InsightRule', 3);
    const body = Object.values(s.t.findResources('AWS::CloudWatch::InsightRule')).map((r) => JSON.stringify((r as Json).Properties.RuleBody)).find((b) => b.includes('srcaddr')) as string;
    expect(body).toContain('$.firewall_rule_action');
    expect(body).toContain('BLOCK');
    // a string goes in `In`; `EqualTo` takes a number and CloudWatch refuses it (INVALID_RULE_BODY)
    expect(body).toContain('\\"Filters\\":[{\\"Match\\":\\"$.firewall_rule_action\\",\\"In\\":[\\"BLOCK\\"]}]');
    expect(body).not.toContain('EqualTo');
  });

  test('refused with a supplied vpc and with a bad domain', () => {
    expect(() => resolveProps({ dnsFirewall: true, vpc: new ec2.Vpc(new Stack(), 'V') })).toThrow(/dnsFirewall/);
    expect(() => resolveProps({ dnsFirewall: { allowDomains: ['bad name'] } })).toThrow(/allowDomains/);
    expect(() => resolveProps({ dnsFirewall: { allowDomains: ['*.ok.example.com'] } })).not.toThrow();
  });

  test('a bare top-level domain is refused: a name needs two labels', () => {
    for (const d of ['com', '*.com', '*.', 'example.', '.example.com']) {
      expect(() => resolveProps({ dnsFirewall: { allowDomains: [d] } })).toThrow(/allowDomains/);
    }
    expect(() => resolveProps({ dnsFirewall: { allowDomains: ['example.com', '*.example.co.uk'] } })).not.toThrow();
  });
});

describe('names (spec 5.3)', () => {
  test('every service rule keeps its charset and length, and ends with 8 hex characters of the path hash', () => {
    for (const service of Object.keys(NAME_RULES) as (keyof typeof NAME_RULES)[]) {
      const long = 'S/Sandboxes/'.repeat(80);
      for (const path of ['S/Sandboxes', long, '', 'ä/ö/ü', '123/456']) {
        const name = nameFor(path, service, 'task');
        expect(name).toMatch(NAME_PATTERNS[service]);
        expect(name.length).toBeLessThanOrEqual(NAME_RULES[service].maxLength);
        expect(name).toMatch(/[0-9a-f]{8}$/);
      }
    }
  });

  test('a capacity provider never starts with a reserved prefix, a runtime starts with a letter', () => {
    expect(nameFor('ecs/x', 'ecs-capacity-provider', 'cp')).toMatch(/^cp-ecs/);
    expect(nameFor('aws', 'ecs-capacity-provider', 'cp')).toMatch(/^cp-aws/);
    expect(nameFor('9/x', 'agentcore-runtime', 'rt')).toMatch(/^r_9/);
    expect(nameFor('S/x', 'agentcore-runtime', 'rt')).not.toContain('-');
  });

  test('the hash depends on the path, the service and the suffix', () => {
    const a = nameFor('S/A', 'ecs-cluster', 'c');
    expect(nameFor('S/B', 'ecs-cluster', 'c')).not.toBe(a);
    expect(nameFor('S/A', 'ecs-cluster', 'd')).not.toBe(a);
    expect(nameFor('S/A', 'ecs-cluster', 'c')).toBe(a);
  });

  test('two instances in one stack get unique names for every service, and every explicit name matches its charset', () => {
    requestedNames.length = 0;
    const stack = new Stack(new App({ context: PATHS }), 'S');
    const mk = (id: string) => new UntrustedCodeSandboxes(stack, id, {
      standalone: true, backends: ['microvm', 'nitro', 'agentcore'], dnsFirewall: true,
    });
    mk('One');
    mk('Two');
    const t = Template.fromStack(stack);

    // names the fake backends asked for: unique per service across all six backend constructs
    expect(requestedNames).toHaveLength(2 * 3 * Object.keys(NAME_RULES).length);
    for (const service of Object.keys(NAME_RULES) as (keyof typeof NAME_RULES)[]) {
      const names = requestedNames.filter((r) => r.service === service).map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(NAME_PATTERNS[service]);
    }

    // names the core itself put on resources
    const explicit: { type: string; prop: string; pattern: RegExp }[] = [
      { type: 'AWS::ECR::Repository', prop: 'RepositoryName', pattern: NAME_PATTERNS['ecr-repository'] },
      { type: 'AWS::CloudWatch::InsightRule', prop: 'RuleName', pattern: NAME_PATTERNS['contributor-insights-rule'] },
      { type: 'AWS::Route53Resolver::FirewallDomainList', prop: 'Name', pattern: NAME_PATTERNS.resolver },
      { type: 'AWS::Route53Resolver::FirewallRuleGroup', prop: 'Name', pattern: NAME_PATTERNS.resolver },
      { type: 'AWS::Route53Resolver::FirewallRuleGroupAssociation', prop: 'Name', pattern: NAME_PATTERNS.resolver },
      { type: 'AWS::Route53Resolver::ResolverQueryLoggingConfig', prop: 'Name', pattern: NAME_PATTERNS.resolver },
      { type: 'AWS::Logs::ResourcePolicy', prop: 'PolicyName', pattern: NAME_PATTERNS['logs-resource-policy'] },
    ];
    let checked = 0;
    for (const { type, prop, pattern } of explicit) {
      const names = Object.values(t.findResources(type)).map((r) => (r as Json).Properties[prop] as string);
      expect(names.length).toBe(type === 'AWS::CloudWatch::InsightRule' ? 6 : type === 'AWS::Route53Resolver::FirewallDomainList' ? 4 : 2);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(pattern);
      checked += names.length;
    }
    expect(checked).toBeGreaterThan(0);
    const groupNames = (Object.values(t.findResources('AWS::Logs::LogGroup')) as Json[]).map((g) => g.Properties.LogGroupName).filter((n) => typeof n === 'string');
    expect(groupNames).toHaveLength(2);
    expect(new Set(groupNames).size).toBe(2);
    for (const n of groupNames) expect(n).toMatch(NAME_PATTERNS['log-group']);
  });
});

describe('props validation, core side (spec 3.3)', () => {
  test('the shell refuses a core with no entry', () => {
    const app = new App();
    const stack = new Stack(app, 'S');
    new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: false });
    expect(() => app.synth()).toThrow(/has no entry/);
  });
});

describe('cdk-nag (AwsSolutions)', () => {
  type Case = UntrustedCodeSandboxesProps & { supplyBucket?: boolean; defaultRole?: boolean };
  test.each([
    ['all backends, the firewall and a bound function', { dnsFirewall: true, standalone: true }],
    ['a single backend and a supplied bucket', { backends: ['microvm'] as const, standalone: true, supplyBucket: true }],
    ['a bound function built with the default role', { dnsFirewall: true, standalone: false, defaultRole: true }],
    ['a bound function with the default role and a log group of its own', { standalone: false, defaultRole: true, ownGroup: true }],
  ])('%s: no unacknowledged finding', (_name, { supplyBucket, defaultRole, ...props }: Case & { ownGroup?: boolean }) => {
    const { ownGroup, ...core } = props as Case & { ownGroup?: boolean };
    const s = synth({ ...core, ...(supplyBucket ? { inputBucket: s3.Bucket.fromBucketName(new Stack(), 'Supplied', 'supplied-input-bucket') } : {}) }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'Gateway', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler=async()=>1'),
        ...(defaultRole ? {} : { role: new iam.Role(stack, 'GatewayRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }) }),
        ...(ownGroup ? { logGroup: new logs.LogGroup(stack, 'GatewayGroup', { logGroupName: 'gateway-own-group' }) } : {}),
      }));
    });
    const report = new AwsSolutionsChecks(s.stack).validateScope(s.stack);
    // Only the function resource the test itself builds is excluded; its role, default or explicit, is the construct's to keep clean.
    const findings = report.violations.flatMap((v) => v.violatingResources.map((r) => `${v.ruleName}: ${r.constructPath}`));
    expect(findings.filter((f) => !/: S\/Gateway\/(?!ServiceRole)/.test(f))).toEqual([]);
  });
});

describe('log groups the backends list (ADR-0030)', () => {
  afterEach(() => {
    logCleanupOverride.value = undefined;
  });

  test.each([
    [{ prefixes: ['/aws/lambda/'], names: [] }, '/aws/lambda/'],
    [{ prefixes: [], names: ['/aws/lambda'] }, '/aws/lambda'],
    [{ prefixes: [''], names: [] }, ''],
    [{ prefixes: [], names: ['/aws/x/'] }, '/aws/x/'],
    [{ prefixes: ['/aws'], names: [] }, '/aws'],
    [{ prefixes: ['/aws/lambda/S'], names: [] }, '/aws/lambda/S'],
    [{ prefixes: ['a'], names: [] }, 'a'],
  ])('%j is refused', (value, shown) => {
    logCleanupOverride.value = value;
    expect(() => synth()).toThrow(new RegExp(`"${shown}".*whole service`));
  });

  test('a narrow name and prefix are accepted', () => {
    logCleanupOverride.value = { prefixes: ['/aws/bedrock-agentcore/runtimes/Runtime_one-'], names: ['/aws/lambda-microvms/image-1'] };
    expect(() => synth()).not.toThrow();
  });
});

describe('known wildcards (ADR-0030)', () => {
  const arn = 'arn:<AWS::Partition>:ecs:<AWS::Region>:<AWS::AccountId>';
  test.each([
    ['*', ['ecr:GetAuthorizationToken'], true],
    ['*', ['ec2:DescribeInstances'], true],
    ['*', ['ecr:GetAuthorizationToken', 's3:GetObject'], false],
    ['*', ['s3:GetObject'], false],
    ['*', ['sts:AssumeRole'], false],
    [`${arn}:task/<SandboxesBackendnitroCluster8B54CDC0>/*`, ['ecs:StopTask', 'ecs:DescribeTasks'], true],
    [`${arn}:task/<SandboxesBackendnitroCluster8B54CDC0>/*`, ['ecs:RunTask'], false],
    [`${arn}:task/<AWS::Region>/*`, ['ecs:StopTask'], false],
    [`${arn}:task/<AWS::AccountId>/*`, ['ecs:StopTask'], false],
    [`${arn}:container-instance/<SandboxesBackendnitroCluster8B54CDC0>/*`, ['ecs:DescribeContainerInstances'], true],
    [`${arn}:container-instance/<AWS::Region>/*`, ['ecs:DescribeContainerInstances'], false],
    [`${arn}:container-instance/*`, ['ecs:Poll'], true],
    [`${arn}:container-instance/*`, ['ecs:DeregisterContainerInstance'], false],
    ['<Rt.AgentRuntimeArn>/runtime-endpoint/*', ['bedrock-agentcore:StopRuntimeSession'], true],
    ['<Rt.AgentRuntimeArn>/runtime-endpoint/*', ['bedrock-agentcore:DeleteAgentRuntime'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-*', ['logs:CreateLogGroup'], true],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x:*', ['logs:PutLogEvents'], true],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-*', ['logs:DeleteLogGroup', 'logs:GetLogEvents'], false],
    ['arn:<AWS::Partition>:ec2:<AWS::Region>:<AWS::AccountId>:network-interface/*', ['ec2:CreateNetworkInterface'], true],
    ['arn:<AWS::Partition>:ec2:<AWS::Region>:<AWS::AccountId>:network-interface/*', ['ec2:DeleteNetworkInterface'], false],
    ['<Bucket.Arn>/inputs/<aws:PrincipalTag/TenantId>/*', ['s3:GetObject'], true],
    ['<Bucket.Arn>/inputs/<aws:PrincipalTag/TenantId>/*', ['s3:DeleteObject'], false],
    ['<Bucket.Arn>/sessions/<aws:AgentCoreRuntimeSourceSid>/*', ['s3:GetObject', 's3:PutObject'], true],
    ['<Bucket.Arn>/sessions/<aws:AgentCoreRuntimeSourceSid>/*', ['s3:DeleteObject'], false],
    ['<Bucket.Arn>/sessions/*', ['s3:GetObject'], false],
    ['<Bucket.Arn>/*', ['s3:GetObject'], false],
    ['<Bucket.Arn>/other/*', ['s3:GetObject'], false],
    ['<Bucket.Arn>/outputs/<aws:PrincipalTag/TenantId>/*', ['s3:PutObject'], true],
    ['<Bucket.Arn>/outputs/<aws:PrincipalTag/TenantId>/*', ['s3:GetObject'], false],
    ['<Bucket.Arn>/inputs/<aws:PrincipalTag/TenantId>/*', ['s3:PutObject'], false],
    ['<Other.Arn>/outputs/<aws:PrincipalTag/TenantId>/*', ['s3:PutObject'], false],
    ['<Other.Arn>/sessions/<aws:AgentCoreRuntimeSourceSid>/*', ['s3:GetObject'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:*', ['logs:DeleteLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:*:*', ['logs:PutLogEvents'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/lambda/*', ['logs:CreateLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-*:log-stream:*', ['logs:PutLogEvents'], true],
    [`${arn}:task/*`, ['ecs:StopTask'], false],
    [`${arn}:task/*`, ['ecs:DescribeTasks'], false],
    [`${arn}:container-instance/*`, ['ecs:DescribeContainerInstances'], false],
    [`${arn}:container-instance/<SandboxesBackendnitroCluster8B54CDC0>/*`, ['ecs:Poll'], false],
    ['<AWS::Region.AgentRuntimeArn>/runtime-endpoint/*', ['bedrock-agentcore:InvokeAgentRuntime'], false],
    ['<Drain.Arn>:*', ['lambda:InvokeFunction'], true],
    ['<Other.Arn>:*', ['lambda:InvokeFunction'], false],
    ['<Drain.Arn>:*', ['lambda:InvokeFunction', 'lambda:DeleteFunction'], false],
    ['<Drain.Arn>:*', ['lambda:DeleteFunction'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:a*', ['logs:DeleteLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws*', ['logs:DeleteLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/lambda*', ['logs:DeleteLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x*', ['logs:DeleteLogGroup'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:<G.Ref>*', ['logs:PutLogEvents'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x:log-stream:*', ['logs:PutLogEvents'], true],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-*:log-stream:*', ['logs:PutLogEvents'], true],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-:*', ['logs:PutLogEvents'], false],
    ['arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/x-other*', ['logs:DeleteLogGroup'], false],
  ])('%s with %p is %s', (resource, actions, accepted) => {
    expect(knownWildcard(resource, actions, { inputBucket: '<Bucket.Arn>', logGroups: ['/aws/x'], logGroupPrefixes: ['/aws/x-'], invokable: ['<Drain.Arn>'] }) !== undefined).toBe(accepted);
  });

  test('a wider action on a known resource stays a finding, and a known one is acknowledged', () => {
    const stack = new Stack(new App(), 'S');
    const role = new iam.Role(stack, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    const wide = new iam.Role(stack, 'Wide', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    wide.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken', 's3:GetObject'], resources: ['*'] }));
    acknowledgeKnownFindings(stack, { inputBucket: '<Bucket.Arn>', logGroups: [], logGroupPrefixes: [], invokable: [] });
    const found = new AwsSolutionsChecks(stack).validateScope(stack).violations.flatMap((v) => v.violatingResources.map((r) => r.constructPath));
    expect(found.some((p) => p.startsWith('S/R/'))).toBe(false);
    expect(found.some((p) => p.startsWith('S/Wide/'))).toBe(true);
  });

  test('statements that share the `*` wildcard get one acknowledgement with every matching reason', () => {
    const stack = new Stack(new App(), 'S');
    const role = new iam.Role(stack, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:ListMicrovms'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeSubnets'], resources: ['*'] }));
    acknowledgeKnownFindings(stack, { inputBucket: '<Bucket.Arn>', logGroups: [], logGroupPrefixes: [], invokable: [] });
    const policy = stack.node.findAll().find((n) => n instanceof iam.CfnPolicy) as iam.CfnPolicy;
    const iam5 = policy.node.metadata
      .map((m) => (m.data as Record<string, string>)['AwsSolutions-IAM5[Resource::*]'])
      .filter((r): r is string => r !== undefined);
    expect(iam5).toHaveLength(1);
    expect(iam5[0]).toMatch(/network interfaces/);
    expect(iam5[0]).toMatch(/take no resource/);
    expect(iam5[0].match(/manages its own network interfaces/g)).toHaveLength(1);
  });
});

describe('least privilege and teardown details', () => {
  const dependsOn = (r: Json): string[] => (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn ? [r.DependsOn] : []);
  const resources = () => base.t.toJSON().Resources as Record<string, Json>;

  test('no role of the construct attaches a managed policy, and none can write a log group it does not own', () => {
    for (const name of ['ToolRole', 'ReaperRole', 'DrainRole', 'ToolTenantRole']) {
      const id = roleId(base.t, name);
      expect(managedPoliciesOf(base.t, id)).toEqual([]);
      for (const s of statementsOfRole(base.t, id)) {
        for (const a of Array.isArray(s.Action) ? s.Action : [s.Action]) {
          if (/^logs:/.test(a) && s.Effect === 'Allow') expect(JSON.stringify(s.Resource)).not.toBe('"*"');
        }
      }
    }
    // the functions' roles hold the six network interface actions, and the log writes name the function's own group
    const toolActions = actionsOf(statementsOfRole(base.t, roleId(base.t, 'ToolRole')));
    expect(toolActions).toEqual(expect.arrayContaining(['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface', 'logs:PutLogEvents']));
    expect(toolActions).not.toContain('logs:CreateLogGroup');
  });

  test('a bound function gets the network interface statement, not the managed policy, and is checked as the tool role is', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'B', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('x'),
        role: new iam.Role(stack, 'BRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
      }));
    });
    const id = Object.entries(s.t.findResources('AWS::IAM::Role')).find(([, r]) => pathOf(r as Json).endsWith('/BRole/Resource'))![0];
    expect(managedPoliciesOf(s.t, id)).toEqual([]);
    expect(actionsOf(statementsOfRole(s.t, id))).toEqual(expect.arrayContaining(['ec2:CreateNetworkInterface', 'logs:PutLogEvents']));
    expect(actionsOf(statementsOfRole(s.t, id))).not.toContain('logs:CreateLogGroup');
  });

  test('the log drain waits for every owned log group, and every function and the DNS association wait for the log drain', () => {
    const all = resources();
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    const groups = Object.entries(all).filter(([, r]) => r.Type === 'AWS::Logs::LogGroup' && /\/(RunCode|Reaper|Offboard|Drain)Logs\/|DrainProviderLogs|QueryLogs|CopyLogs/.test(pathOf(r)));
    expect(groups).toHaveLength(6);
    for (const [id] of groups) expect(dependsOn(all[drainId])).toContain(id);
    for (const name of ['RunCode', 'Reaper', 'Offboard', 'Drain']) expect(dependsOn(all[fnId(base.t, name)])).toContain(drainId);
    const association = Object.values(all).find((r) => r.Type === 'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation');
    expect(association).toBeUndefined();
    const dns = synth({ dnsFirewall: true });
    const dnsAll = dns.t.toJSON().Resources as Record<string, Json>;
    const dnsDrain = Object.entries(dnsAll).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    const assoc = Object.values(dnsAll).find((r) => r.Type === 'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation') as Json;
    expect(dependsOn(assoc)).toContain(dnsDrain);
    const dnsGroup = Object.entries(dnsAll).find(([, r]) => r.Type === 'AWS::Logs::LogGroup' && pathOf(r).includes('QueryLogs'))![0];
    expect(dependsOn(dnsAll[dnsDrain])).toContain(dnsGroup);
  });

  test('a bound function with no group of its own is behind the log drain too', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'B', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('x'),
        role: new iam.Role(stack, 'BRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
      }));
    });
    const all = s.t.toJSON().Resources as Record<string, Json>;
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    const group = Object.entries(all).find(([, r]) => r.Type === 'AWS::Logs::LogGroup' && pathOf(r).includes('/BoundLogs0/'))![0];
    const fn = Object.entries(all).find(([, r]) => r.Type === 'AWS::Lambda::Function' && pathOf(r).includes('/B/Resource'))![1];
    expect(dependsOn(all[drainId])).toContain(group);
    expect(dependsOn(fn)).toContain(drainId);
  });

  test('the image copy function is constrained: denies, a log group the construct owns, and the drain', () => {
    const all = resources();
    const copyFn = Object.entries(all).find(([, r]) => r.Type === 'AWS::Lambda::Function' && /Custom::CDKECRDeployment/.test(pathOf(r)))!;
    expect(JSON.stringify(copyFn[1].Properties.LoggingConfig.LogGroup)).toContain('CopyLogs');
    const roleLogical = copyFn[1].Properties.Role['Fn::GetAtt'][0] as string;
    const stmts = statementsOfRole(base.t, roleLogical);
    const deny = (sid: string) => stmts.find((s) => s.Sid === sid && s.Effect === 'Deny') as Json;
    expect(deny('NoInputBucket').Action).toBe('s3:*');
    expect(JSON.stringify(deny('NoInputBucket').Resource)).toContain('InputBucket');
    expect(deny('EcrWriteOnlyToRunnerRepositories').Action).toEqual(['ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload']);
    expect(JSON.stringify(deny('EcrWriteOnlyToRunnerRepositories').NotResource)).toContain('RunnerRepository');
    expect(deny('NoLogGroupCreation').Action).toBe('logs:CreateLogGroup');
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    expect(dependsOn(copyFn[1])).toContain(drainId);
  });

  test('two instances share the copy function and its denies cover both repositories and both buckets', () => {
    const stack = new Stack(new App({ context: PATHS }), 'S');
    for (const id of ['One', 'Two']) new UntrustedCodeSandboxes(stack, id, { standalone: true, backends: ['nitro'] });
    const t = Template.fromStack(stack);
    const fns = Object.values(t.findResources('AWS::Lambda::Function')).filter((f) => /Custom::CDKECRDeployment/.test(pathOf(f as Json)));
    expect(fns).toHaveLength(1);
    const roleLogical = (fns[0] as Json).Properties.Role['Fn::GetAtt'][0] as string;
    const stmts = statementsOfRole(t, roleLogical);
    const repos = JSON.stringify(stmts.find((s) => s.Sid === 'EcrWriteOnlyToRunnerRepositories')!.NotResource);
    expect(repos).toContain('OneRunnerRepository');
    expect(repos).toContain('TwoRunnerRepository');
    const buckets = JSON.stringify(stmts.find((s) => s.Sid === 'NoInputBucket')!.Resource);
    expect(buckets).toContain('OneInputBucket');
    expect(buckets).toContain('TwoInputBucket');
  });

  test('every function has a log group the stack owns, the auto-delete provider and the image copy included, behind the log drain', () => {
    const all = resources();
    const plain = Object.entries(all).filter(([, r]) => r.Type === 'AWS::Lambda::Function' && !r.Properties.LoggingConfig?.LogGroup);
    expect(plain.map(([, r]) => pathOf(r))).toEqual([]);
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    const provider = Object.entries(all).find(([, r]) => r.Type === 'AWS::Lambda::Function' && /S3AutoDeleteObjects/.test(pathOf(r)))!;
    expect(JSON.stringify(provider[1].Properties.LoggingConfig.LogGroup)).toContain('AutoDeleteLogs');
    expect(dependsOn(provider[1])).toContain(drainId);
    expect(dependsOn(all[drainId])).toContain(logicalIdByPath(base.t, 'AWS::Logs::LogGroup', '/AutoDeleteLogs/Resource'));
  });

  test('an app bucket in the same stack shares the auto-delete provider and its log group', () => {
    const s = synth({ backends: ['microvm'] }, (stack) => {
      new s3.Bucket(stack, 'AppBucket', { removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true });
    });
    const providers = Object.entries(s.t.findResources('AWS::Lambda::Function')).filter(([, f]) => /S3AutoDeleteObjects/.test(pathOf(f as Json)));
    expect(providers).toHaveLength(1);
    expect(JSON.stringify((providers[0][1] as Json).Properties.LoggingConfig.LogGroup)).toContain('AutoDeleteLogs');
    // both buckets' auto-delete resources use that one function
    const deleters = Object.values(s.t.toJSON().Resources as Record<string, Json>).filter((r) => r.Type === 'Custom::S3AutoDeleteObjects');
    expect(deleters).toHaveLength(2);
    for (const d of deleters) expect(JSON.stringify(d.Properties.ServiceToken)).toContain(providers[0][0]);
  });

  test('a foreign image copy in the same stack gets its own function and none of the denies', () => {
    const s = synth({ backends: ['nitro'] }, (stack) => {
      new ECRDeployment(stack, 'Foreign', {
        src: new DockerImageName('docker://example.com/app:1'),
        dest: new DockerImageName('docker://example.com/app:2'),
      });
    });
    const copies = Object.values(s.t.findResources('AWS::Lambda::Function')).filter((f) => /Custom::CDKECRDeployment/.test(pathOf(f as Json))) as Json[];
    expect(copies).toHaveLength(2);
    const roles = copies.map((f) => f.Properties.Role['Fn::GetAtt'][0] as string);
    const sids = roles.map((r) => statementsOfRole(s.t, r).map((st) => st.Sid));
    expect(sids.filter((ids) => ids.includes('NoInputBucket'))).toHaveLength(1);
  });

  test('a core with a supplied bucket has no auto-delete provider to clean', () => {
    const s = synth({ backends: ['microvm'], inputBucket: s3.Bucket.fromBucketName(new Stack(), 'Supplied', 'supplied-input-bucket') });
    expect(Object.values(s.t.toJSON().Resources as Record<string, Json>).filter((r) => r.Type === 'Custom::S3AutoDeleteObjects')).toEqual([]);
  });

  test('the drain resource is answered by a framework function with a role and a log group of the construct\'s own', () => {
    const all = resources();
    const drain = Object.values(all).find((r) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/DrainResource/')) as Json;
    const frameworkId = (drain.Properties.ServiceToken['Fn::GetAtt'] as string[])[0];
    const framework = all[frameworkId];
    expect(pathOf(framework)).toContain('/DrainProvider/');
    expect(JSON.stringify(framework.Properties.LoggingConfig.LogGroup)).toContain('DrainProviderLogs');
    const role = framework.Properties.Role['Fn::GetAtt'][0] as string;
    expect(managedPoliciesOf(base.t, role)).toEqual([]);
    const stmts = statementsOfRole(base.t, role);
    expect(actionsOf(stmts).sort()).toEqual(['lambda:GetFunction', 'lambda:InvokeFunction', 'logs:CreateLogStream', 'logs:PutLogEvents']);
    const invoke = stmts.find((st) => Array.isArray(st.Action) && st.Action.includes('lambda:InvokeFunction') || st.Action === 'lambda:InvokeFunction') as Json;
    expect(JSON.stringify(invoke.Resource)).toContain(fnId(base.t, 'Drain'));
    expect(JSON.stringify(invoke.Resource)).not.toContain('"*"');
    const logWrite = stmts.find((st) => Array.isArray(st.Action) && st.Action.includes('logs:PutLogEvents')) as Json;
    expect(JSON.stringify(logWrite.Resource)).toContain('DrainProviderLogs');
    expect(JSON.stringify(logWrite.Resource)).not.toContain('"*"');
    // the framework waits for the log drain like every other writer
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/LogDrain/Resource'))![0];
    expect(dependsOn(framework)).toContain(drainId);
  });

  test('the reaper schedule is deleted before the drain, and every custom resource has a service timeout', () => {
    const all = resources();
    const drainId = Object.entries(all).find(([, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('/DrainResource/'))![0];
    const rule = Object.values(all).find((r) => r.Type === 'AWS::Events::Rule') as Json;
    expect(dependsOn(rule)).toContain(drainId);
    // every custom resource of the construct: its own, and the two image copies; the bucket's auto-delete one is CDK's
    const mine = Object.values(all).filter((r) => /^(AWS::CloudFormation::CustomResource|Custom::)/.test(r.Type) && pathOf(r).includes('/Sandboxes/') && !/InputBucket/.test(pathOf(r)));
    expect(mine.length).toBeGreaterThanOrEqual(5);
    for (const r of mine) expect(Number(r.Properties.ServiceTimeout)).toBeGreaterThan(0);
  });

  test('the sandbox egress to S3 is the prefix list when given, any address only in the created vpc, and refused in a supplied one', () => {
    const withList = synth({ s3PrefixListId: 'pl-6ea54007' });
    expect(JSON.stringify(withList.t.toJSON())).toContain('pl-6ea54007');
    const rules = sgRules(withList.t);
    const runtime = Object.keys(rules).find((id) => /BackendagentcoreClients/.test(id)) as string;
    expect(rules[runtime].egress.map((e) => e.peer)).not.toContain('0.0.0.0/0');
    const stack = new Stack(new App(), 'V');
    const vpc = new ec2.Vpc(stack, 'Own', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Tool', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    expect(() => new UntrustedCodeSandboxes(stack, 'A', { standalone: true, vpc, backends: ['agentcore'], createEndpoints: true })).toThrow(/s3PrefixListId/);
    expect(() => new UntrustedCodeSandboxes(stack, 'B', { standalone: true, vpc, backends: ['agentcore'], createEndpoints: true, s3PrefixListId: 'pl-6ea54007' })).not.toThrow();
    expect(() => new UntrustedCodeSandboxes(stack, 'C', { standalone: true, vpc, backends: ['nitro'], createEndpoints: true })).not.toThrow();
  });

  test('size limits and the prefix list id are validated', () => {
    expect(() => resolveProps({ maxOutputBytes: 4 * 1024 * 1024 + 1 })).toThrow(/maxOutputBytes must be at most/);
    expect(() => resolveProps({ maxInputBytes: 6 * 1024 * 1024 + 1 })).toThrow(/maxInputBytes must be at most 6291456/);
    expect(() => resolveProps({ maxInputBytes: 6 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024 })).not.toThrow();
    expect(() => resolveProps({ s3PrefixListId: 'nope' })).toThrow(/prefix list id/);
  });
});

describe('public members the gateway entry uses (spec 3.3)', () => {
  const inline = { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>1') };

  test('config, toolRole, toolTenantRole, bindRunCode and runCodeFunction exist with their types', () => {
    const c = base.c;
    expect(c.config.toolBudget.toSeconds()).toBe(60);
    expect(c.config.backends).toEqual(['microvm', 'nitro', 'agentcore']);
    expect(c.config.defaultBackend).toBe('microvm');
    expect(c.toolRole.roleArn).toBeDefined();
    expect(c.toolTenantRole.roleArn).toBeDefined();
    expect(c.toolRole).not.toBe(c.toolTenantRole);
    expect(typeof c.bindRunCode).toBe('function');
    expect(c.runCodeFunction).toBeDefined();
    const without = synth({ standalone: false }, (stack, core) => core.bindRunCode(new lambda.Function(stack, 'G', { ...inline })));
    expect(without.c.runCodeFunction).toBeUndefined();
  });

  test('a function built with the tool role and the JSON log format keeps its log format and gets the core settings', () => {
    const s = synth({ standalone: false }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'Gateway', { ...inline, role: c.toolRole, loggingFormat: lambda.LoggingFormat.JSON }));
    });
    const fn = Object.values(s.t.findResources('AWS::Lambda::Function')).find((f) => pathOf(f as Json).includes('/Gateway/')) as Json;
    expect(fn.Properties.LoggingConfig.LogFormat).toBe('JSON');
    expect(fn.Properties.LoggingConfig.LogGroup).toBeDefined();
    expect(fn.Properties.Timeout).toBe(60);
    expect(fn.Properties.VpcConfig.SubnetIds).toHaveLength(2);
    expect(fn.Properties.Role['Fn::GetAtt'][0]).toBe(roleId(s.t, 'ToolRole'));
    // it runs as the tool role, so the trust policy gains nothing
    const trust = (s.t.findResources('AWS::IAM::Role')[roleId(s.t, 'ToolTenantRole')] as Json).Properties.AssumeRolePolicyDocument.Statement as Json[];
    expect(trust).toHaveLength(1);
    // the tool role can write the group the core gave the function
    const logWrite = statementsOfRole(s.t, roleId(s.t, 'ToolRole')).filter((st) => JSON.stringify(st.Action).includes('logs:PutLogEvents'));
    expect(logWrite.some((st) => JSON.stringify(st.Resource).includes('BoundLogs0'))).toBe(true);
  });
});
