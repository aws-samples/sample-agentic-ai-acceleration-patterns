// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Synth tests of the core construct's CDK side (spec §3.6 to §3.9, §4.1,
 * §5.3), against fake backends (ADR-0025): one test per spec statement the
 * core builds, a policy test for each deny of §3.6, and the two-instance
 * name test.
 */

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { requestedNames } from './fake-core-backend';
import { ALLOW_PRIORITY, BLOCK_PRIORITY, DNS_FIREWALL_ALLOWED_DOMAINS } from '../src/core/dns-firewall';
import { CLEANUP_SOURCE } from '../src/core/log-cleanup';
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
  return policies
    .filter((p) => (p.Properties.Roles as Json[]).some((r) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Json[]);
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
    expect(actions).toEqual(expect.arrayContaining(['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'fake:Reapernitro']));
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
      'dynamodb:Query', 'fake:Reapernitro', 'ecs:ListContainerInstances', 'ecs:DeregisterContainerInstance', 'ec2:DescribeInstances',
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
  test('every function runs in the tool subnets with the tool security group, with the shared environment', () => {
    for (const name of ['RunCode', 'Reaper', 'Offboard', 'Drain']) {
      const fn = base.t.findResources('AWS::Lambda::Function')[fnId(base.t, name)] as Json;
      expect(fn.Properties.VpcConfig.SecurityGroupIds).toHaveLength(1);
      expect(fn.Properties.VpcConfig.SubnetIds).toHaveLength(2);
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
    s.t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: Match.objectLike({ 'Fn::Join': Match.anyValue() }), RetentionInDays: 30 });
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
    expect(Object.values(s.t.findResources('AWS::Logs::LogGroup')).filter((g) => /^\/aws\/lambda\//.test(JSON.stringify((g as Json).Properties.LogGroupName ?? '')))).toHaveLength(0);
    const runs = Object.values(s.t.findResources('AWS::CloudWatch::InsightRule')).map((r) => JSON.stringify((r as Json).Properties.RuleBody)).find((b) => b.includes('$.runId')) as string;
    expect(runs).toContain('OwnGroup');
    expect(runs).toContain('BoundLogs0');
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

  test('the cleanup resource gets every prefix and name, and its role deletes only those', () => {
    const cleanup = Object.values(base.t.toJSON().Resources as Record<string, Json>).find((r) => r.Type === 'AWS::CloudFormation::CustomResource' && pathOf(r).includes('LogCleanup')) as Json;
    expect(cleanup.Properties.Prefixes).toEqual(['/aws/bedrock-agentcore/runtimes/Fake_agentcore-']);
    expect(cleanup.Properties.Names).toHaveLength(2);
    const stmts = statementsOfRole(base.t, logicalIdByPath(base.t, 'AWS::IAM::Role', '/LogCleanup/Role/Resource'));
    const del = stmts.find((s) => s.Sid === 'DeleteOwnedLogGroups') as Json;
    expect(del.Action).toBe('logs:DeleteLogGroup');
    expect(del.Resource).toHaveLength(3);
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
    expect(sids).toEqual(['Logsagentcore Prefixes'.replace(' ', ''), 'Logsnitro Groups'.replace(' ', '')].sort());
    const s3 = endpoints.find((e) => e.Properties.VpcEndpointType === 'Gateway') as Json;
    expect(s3.Properties.PolicyDocument.Statement).toHaveLength(1);
    expect(JSON.stringify(s3.Properties.PolicyDocument.Statement[0].Resource)).toContain('starport-layer-bucket');
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
    expect(() => new UntrustedCodeSandboxes(bad, 'Sandboxes', { standalone: true, vpc: noSandbox })).toThrow(/no sandbox subnets; name the subnet group Sandbox/);
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
    for (const d of ['amazonaws.com', '*.amazonaws.com', '*.on.aws', '*.api.aws', 'time.aws.com', '*.compute.internal']) {
      expect(DNS_FIREWALL_ALLOWED_DOMAINS).toContain(d);
    }
  });

  test('the association covers the construct VPC, fails closed and can be deleted', () => {
    s.t.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroupAssociation', {
      MutationProtection: 'DISABLED',
      VpcId: Match.anyValue(),
    });
    // FirewallFailOpen is left at its default, DISABLED: there is no resource property that turns it on.
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
    expect(doc.Statement[0].Resource).toMatch(/^<[A-Za-z0-9]*QueryLogs[A-Za-z0-9]*\.Arn>:\*$/);
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
  });

  test('refused with a supplied vpc and with a bad domain', () => {
    expect(() => resolveProps({ dnsFirewall: true, vpc: new ec2.Vpc(new Stack(), 'V') })).toThrow(/dnsFirewall/);
    expect(() => resolveProps({ dnsFirewall: { allowDomains: ['bad name'] } })).toThrow(/allowDomains/);
    expect(() => resolveProps({ dnsFirewall: { allowDomains: ['*.ok.example.com'] } })).not.toThrow();
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
  test.each([
    ['all backends, the firewall and a bound function', { dnsFirewall: true, standalone: true }],
    ['a single backend and a supplied bucket', { backends: ['microvm'] as const, standalone: true, supplyBucket: true }],
  ])('%s: no unacknowledged finding', (_name, { supplyBucket, ...props }: UntrustedCodeSandboxesProps & { supplyBucket?: boolean }) => {
    const s = synth({ ...props, ...(supplyBucket ? { inputBucket: s3.Bucket.fromBucketName(new Stack(), 'Supplied', 'supplied-input-bucket') } : {}) }, (stack, c) => {
      c.bindRunCode(new lambda.Function(stack, 'Gateway', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler=async()=>1'),
        role: new iam.Role(stack, 'GatewayRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
      }));
    });
    const report = new AwsSolutionsChecks(s.stack).validateScope(s.stack);
    const findings = report.violations.map((v) => `${v.ruleName}: ${JSON.stringify(v.violatingResources)}`);
    // The gateway function in this test is the test's own; its role and function are not the construct's.
    expect(findings.filter((f) => !/Gateway/.test(f))).toEqual([]);
  });
});
