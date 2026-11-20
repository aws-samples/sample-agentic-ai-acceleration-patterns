// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { BackendContext, BackendSettings, NameFor } from '../src/backend-construct';
import { AgentcoreBackendResources, RUNTIME_LOG_PREFIX, SID } from '../src/backends/agentcore.cdk';
import { runnerPath } from '../src/handler-entry';

const RUNTIME_NAME = 'StubRuntime_0a1b2c3d';

// A stand-in for the core's sanitiser (spec §5.3): same charsets, no hashing.
const nameFor: NameFor = (service, suffix) => {
  if (service === 'agentcore-runtime') return RUNTIME_NAME;
  if (service === 'log-group') return `/stub/${suffix}`;
  return `${service}-${suffix}`;
};

const settings = (patch: Partial<BackendSettings> = {}): BackendSettings => ({
  runTimeout: Duration.seconds(30),
  startWait: Duration.seconds(15),
  maxOutputBytes: 262144,
  sandboxIdle: Duration.minutes(15),
  sandboxMaxLife: Duration.hours(8),
  microvmMemoryMiB: 1024,
  nitroCpu: 512,
  nitroMemoryMiB: 1024,
  nitroInstanceTypes: ['m7i.xlarge'],
  agentcoreSessionFiles: false,
  ...patch,
});

interface Harness {
  readonly stack: Stack;
  readonly backend: AgentcoreBackendResources;
  readonly vpc: ec2.Vpc;
  readonly repository: ecr.Repository;
  readonly bucket: s3.Bucket;
  template(): Template;
  resolve(statements: iam.PolicyStatement[]): unknown[];
}

function build(opts: { sessionFiles?: boolean; imageTag?: boolean; noRepository?: boolean; patch?: Partial<BackendSettings> } = {}): Harness {
  const stack = new Stack(new App(), 'S');
  const vpc = new ec2.Vpc(stack, 'Vpc', {
    maxAzs: 2,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'Tool', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      { name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
    ],
  });
  const repository = new ecr.Repository(stack, 'RunnerRepository');
  const bucket = new s3.Bucket(stack, 'InputBucket');
  const ctx: BackendContext = {
    vpc,
    sandboxSubnets: { subnetGroupName: 'Sandbox' },
    toolSubnets: { subnetGroupName: 'Tool' },
    toolSecurityGroup: new ec2.SecurityGroup(stack, 'Tool', { vpc }),
    inputBucket: bucket,
    runnerRepository: opts.noRepository ? undefined : repository,
    runnerImageTag: opts.imageTag ? (arch) => `core-copy-${arch}` : undefined,
    runnerDir: runnerPath(),
    nameFor,
    settings: settings({ agentcoreSessionFiles: opts.sessionFiles ?? false, ...opts.patch }),
  };
  const backend = new AgentcoreBackendResources(stack, 'Backend-agentcore', ctx);
  return {
    stack,
    backend,
    vpc,
    repository,
    bucket,
    template: () => Template.fromStack(stack),
    resolve: (statements) => statements.map((s) => render(stack.resolve(s.toStatementJson()))),
  };
}

/** Every statement of every policy that is attached to the runtime role, resolved. */
function roleStatements(t: Template): Array<Record<string, unknown>> {
  const policies = t.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('RuntimeRole') })]) },
  });
  return Object.values(policies).flatMap((p) => {
    const doc = (p as { Properties: { PolicyDocument: { Statement: unknown } } }).Properties.PolicyDocument;
    return render(doc.Statement) as Array<Record<string, unknown>>;
  });
}

const sidOf = (s: Record<string, unknown>) => s.Sid as string;
const flat = (v: unknown): string => JSON.stringify(v);

/** Resolves partition, Region and account tokens and joins Fn::Join, so an ARN compares as text; other references stay as <Ref:...>. */
function render(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(render);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('Fn::Join' in o) {
      const [sep, parts] = o['Fn::Join'] as [string, unknown[]];
      return parts.map(render).join(sep);
    }
    if (o.Ref === 'AWS::Partition') return 'aws';
    if (o.Ref === 'AWS::Region') return 'REGION';
    if (o.Ref === 'AWS::AccountId') return 'ACCOUNT';
    if (typeof o.Ref === 'string') return `<Ref:${o.Ref}>`;
    if ('Fn::GetAtt' in o) return `<GetAtt:${(o['Fn::GetAtt'] as string[]).join('.')}>`;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, render(x)]));
  }
  return v;
}

describe('the runtime (spec §3.3, §3.4, ADR-0015)', () => {
  const h = build();
  const t = h.template();

  test('one V2 container runtime in VPC mode, with the lifecycle from the props', () => {
    t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: RUNTIME_NAME,
      PlatformVersion: 'V2',
      ProtocolConfiguration: 'HTTP',
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 900, MaxLifetime: 28800 },
      NetworkConfiguration: Match.objectLike({ NetworkMode: 'VPC' }),
    });
  });

  test('the artifact is a container image, never a code zip (S-9)', () => {
    const [runtime] = Object.values(t.findResources('AWS::BedrockAgentCore::Runtime'));
    const artifact = (runtime as { Properties: { AgentRuntimeArtifact: Record<string, unknown> } }).Properties.AgentRuntimeArtifact;
    expect(Object.keys(artifact)).toEqual(['ContainerConfiguration']);
    expect(flat(artifact)).toContain(`:runner-arm64-${h.backend.imageTag.replace('runner-arm64-', '')}`);
    expect(h.backend.imageTag).toMatch(/^runner-arm64-[0-9a-f]{64}$/);
  });

  test('the runtime sits in the sandbox subnets only, with the backend security group', () => {
    const [runtime] = Object.values(t.findResources('AWS::BedrockAgentCore::Runtime'));
    type Net = { Subnets: unknown[]; SecurityGroups: unknown[] };
    const net = (runtime as { Properties: { NetworkConfiguration: { NetworkModeConfig: Net } } }).Properties.NetworkConfiguration.NetworkModeConfig;
    const sandbox = h.vpc.selectSubnets({ subnetGroupName: 'Sandbox' }).subnets;
    expect(net.Subnets).toHaveLength(2);
    expect(flat(net.Subnets)).toContain(h.stack.resolve(sandbox[0].subnetId).Ref);
    expect(flat(net.Subnets)).toContain(h.stack.resolve(sandbox[1].subnetId).Ref);
    expect(net.SecurityGroups).toHaveLength(1);
  });

  test('idle and max life follow sandboxIdle and sandboxMaxLife', () => {
    const custom = build({ patch: { sandboxIdle: Duration.minutes(5), sandboxMaxLife: Duration.hours(2) } }).template();
    custom.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 7200 },
    });
  });

  test('the runtime waits for its role, its policy and the image copy', () => {
    const [runtime] = Object.values(t.findResources('AWS::BedrockAgentCore::Runtime'));
    const deps = (runtime as { DependsOn: string[] }).DependsOn.join(' ');
    expect(deps).toMatch(/RuntimeRole[0-9A-F]{8}\b/);
    expect(deps).toContain('RuntimeRoleDefaultPolicy');
    expect(deps).toContain('RunnerImageCopy');
  });

  test('a runtime name the service refuses fails synth, so the log patterns cannot match another runtime', () => {
    for (const bad of ['has-hyphen', '1starts_with_digit', 'a'.repeat(49), '']) {
      const stack = new Stack(new App(), 'S');
      const vpc = new ec2.Vpc(stack, 'Vpc', { subnetConfiguration: [{ name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }] });
      expect(() => new AgentcoreBackendResources(stack, 'B', {
        vpc,
        sandboxSubnets: { subnetGroupName: 'Sandbox' },
        toolSubnets: { subnetGroupName: 'Sandbox' },
        toolSecurityGroup: new ec2.SecurityGroup(stack, 'T', { vpc }),
        inputBucket: new s3.Bucket(stack, 'Bk'),
        runnerRepository: new ecr.Repository(stack, 'R'),
        runnerDir: runnerPath(),
        nameFor: () => bad,
        settings: settings(),
      })).toThrow(/runtime name must match/);
    }
  });

  test('two instances in one stack share no name and no construct id', () => {
    const stack = new Stack(new App(), 'S');
    const vpc = new ec2.Vpc(stack, 'Vpc', { subnetConfiguration: [{ name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }] });
    const repository = new ecr.Repository(stack, 'R');
    const bucket = new s3.Bucket(stack, 'Bk');
    const make = (id: string) => new AgentcoreBackendResources(stack, id, {
      vpc,
      sandboxSubnets: { subnetGroupName: 'Sandbox' },
      toolSubnets: { subnetGroupName: 'Sandbox' },
      toolSecurityGroup: new ec2.SecurityGroup(stack, `T${id}`, { vpc }),
      inputBucket: bucket,
      runnerRepository: repository,
      runnerDir: runnerPath(),
      nameFor: (service, suffix) => (service === 'agentcore-runtime' ? `Rt_${id}` : `${service}-${suffix}-${id}`.replace(/^log-group/, '/lg')),
      settings: settings(),
    });
    const a = make('a1');
    const b = make('b2');
    expect(a.runtimeName).not.toBe(b.runtimeName);
    const both = Template.fromStack(stack);
    const nameOf = (type: string, key: string) => Object.values(both.findResources(type))
      .map((r) => (r as { Properties: Record<string, string> }).Properties[key]);
    for (const [type, key] of [
      ['AWS::Logs::DeliverySource', 'Name'], ['AWS::Logs::DeliveryDestination', 'Name'],
      ['AWS::Logs::LogGroup', 'LogGroupName'], ['AWS::Logs::ResourcePolicy', 'PolicyName'],
    ]) {
      const names = nameOf(type, key);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
    }
  });

  test('a core-made image copy is used as is, and this backend makes none', () => {
    const own = build({ imageTag: true });
    expect(own.backend.imageTag).toBe('core-copy-arm64');
    const tpl = own.template();
    expect(flat(tpl.toJSON())).toContain(':core-copy-arm64');
    expect(Object.keys(tpl.findResources('Custom::CDKECRDeployment'))).toHaveLength(0);
  });

  test('this backend copies the arm64 image into the runner repository when the core does not', () => {
    t.hasResourceProperties('Custom::CDKECRDeployment', { ImageArch: 'arm64' });
    const [copy] = Object.values(t.findResources('Custom::CDKECRDeployment'));
    const props = (copy as { Properties: { SrcImage: unknown; DestImage: unknown } }).Properties;
    expect(render(props.SrcImage)).toMatch(/^docker:\/\//);
    expect(flat(props.DestImage)).toContain(h.backend.imageTag);
  });

  test('it refuses to build with no runner repository', () => {
    expect(() => build({ noRepository: true })).toThrow(/runner repository/);
  });
});

describe('the runtime role (spec §3.6)', () => {
  test('trust: the AgentCore service for this runtime only', () => {
    const t = build().template();
    const roles = t.findResources('AWS::IAM::Role', { Properties: { AssumeRolePolicyDocument: Match.anyValue() } });
    const role = Object.entries(roles).find(([id]) => id.includes('RuntimeRole'))![1] as { Properties: { AssumeRolePolicyDocument: { Statement: unknown[] } } };
    expect(render(role.Properties.AssumeRolePolicyDocument.Statement)).toEqual([{
      Action: 'sts:AssumeRole',
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Condition: {
        StringEquals: { 'aws:SourceAccount': 'ACCOUNT' },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:REGION:ACCOUNT:runtime/${RUNTIME_NAME}-*` },
      },
    }]);
  });

  test('it holds the image pull and its own logs, and nothing else', () => {
    const statements = roleStatements(build().template());
    expect(statements.map(sidOf).sort()).toEqual([SID.roleEcrToken, SID.roleEcrPull, SID.roleLogs, SID.roleLogStreams].sort());
    const byId = Object.fromEntries(statements.map((s) => [sidOf(s), s]));
    expect(byId[SID.roleEcrToken]).toMatchObject({ Action: 'ecr:GetAuthorizationToken', Resource: '*' });
    expect(byId[SID.roleEcrPull]).toMatchObject({ Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'] });
    expect(flat(byId[SID.roleEcrPull].Resource)).toContain('RunnerRepository');
    const group = `arn:aws:logs:REGION:ACCOUNT:log-group:${RUNTIME_LOG_PREFIX}${RUNTIME_NAME}-*`;
    expect(byId[SID.roleLogs]).toMatchObject({ Action: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'], Resource: group });
    expect(byId[SID.roleLogStreams]).toMatchObject({ Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `${group}:log-stream:*` });
  });

  test('the L2\'s own grants (X-Ray, metrics, workload identity, DescribeLogGroups on *) are not on the role (ADR-0050)', () => {
    const text = flat(roleStatements(build().template()));
    for (const banned of ['xray:', 'cloudwatch:', 'GetWorkloadAccessToken', 'logs:DescribeLogGroups', 'log-group:*"']) {
      expect(text).not.toContain(banned);
    }
  });

  test('every resource is named; the one wildcard is the ECR token action, which takes no resource', () => {
    const wild = roleStatements(build({ sessionFiles: true }).template()).filter((s) => flat(s.Resource).includes('"*"') || s.Resource === '*');
    expect(wild.map(sidOf)).toEqual([SID.roleEcrToken]);
  });

  test('without sessionFiles the role holds no S3 access', () => {
    expect(flat(roleStatements(build().template()))).not.toContain('s3:');
  });

  test('with sessionFiles the role gets the per-session prefix and a prefix-conditioned list (ADR-0007)', () => {
    const h = build({ sessionFiles: true });
    const statements = roleStatements(h.template());
    expect(statements.map(sidOf).sort()).toEqual(
      [SID.roleEcrToken, SID.roleEcrPull, SID.roleLogs, SID.roleLogStreams, SID.roleSessionObjects, SID.roleSessionList].sort(),
    );
    const byId = Object.fromEntries(statements.map((s) => [sidOf(s), s]));
    expect(byId[SID.roleSessionObjects]).toMatchObject({ Action: ['s3:GetObject', 's3:PutObject'] });
    expect(flat(byId[SID.roleSessionObjects].Resource)).toContain('sessions/${aws:AgentCoreRuntimeSourceSid}/*');
    expect(byId[SID.roleSessionList]).toMatchObject({
      Action: 's3:ListBucket',
      Condition: { StringLike: { 's3:prefix': ['sessions/${aws:AgentCoreRuntimeSourceSid}/*'] } },
    });
    expect(flat(byId[SID.roleSessionList].Resource)).not.toContain('/*');
  });

  test('the runtime is given an immutable reference, so the L2 adds nothing to the role', () => {
    const t = build().template();
    const policies = Object.keys(t.findResources('AWS::IAM::Policy')).filter((id) => id.includes('RuntimeRole'));
    expect(policies).toHaveLength(1);
  });
});

describe('the security group (spec §3.7)', () => {
  const h = build();
  const t = h.template();

  test('the backend adds no ingress and no egress of its own; the core adds the endpoint egress (ADR-0051)', () => {
    const [group] = Object.values(t.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: Match.stringLikeRegexp('^agentcore runtime') },
    })) as Array<{ Properties: { SecurityGroupIngress?: unknown[]; SecurityGroupEgress?: unknown[] } }>;
    expect(group.Properties.SecurityGroupIngress ?? []).toEqual([]);
    // CDK's placeholder rule for a group with no egress: a rule that matches no traffic.
    expect(flat(group.Properties.SecurityGroupEgress)).not.toContain('"0.0.0.0/0"');
    expect(Object.keys(t.findResources('AWS::EC2::SecurityGroupIngress'))).toHaveLength(0);
    expect(Object.keys(t.findResources('AWS::EC2::SecurityGroupEgress'))).toHaveLength(0);
  });

  test('it is the client group of the endpoints, and the backend names the four endpoints', () => {
    expect(h.backend.endpointClients()).toEqual([h.backend.securityGroup]);
    expect(h.backend.endpoints()).toEqual(['s3-gateway', 'ecr-api', 'ecr-dkr', 'logs']);
  });
});

describe('policy statements (spec §3.6, S-8)', () => {
  const h = build();

  test('tool: invoke and stop on the runtime and its endpoints, no session condition (S-8)', () => {
    const [statement] = h.resolve(h.backend.toolStatements()) as Array<Record<string, unknown>>;
    expect(statement).toMatchObject({
      Sid: SID.toolInvoke,
      Effect: 'Allow',
      Action: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
    });
    expect(statement.Condition).toBeUndefined();
    const resources = statement.Resource as unknown[];
    expect(resources).toHaveLength(2);
    expect(flat(resources[0])).toContain('AgentRuntimeArn');
    expect(flat(resources[1])).toContain('/runtime-endpoint/*');
  });

  test('reaper: stop only, on the same resources', () => {
    const [statement] = h.resolve(h.backend.reaperStatements()) as Array<Record<string, unknown>>;
    expect(statement).toMatchObject({ Sid: SID.reaperStop, Effect: 'Allow', Action: 'bedrock-agentcore:StopRuntimeSession' });
    expect(h.resolve(h.backend.toolStatements())).not.toEqual(h.resolve(h.backend.reaperStatements()));
    expect((statement.Resource as unknown[])).toHaveLength(2);
  });

  test('tenant and drain: none (the tenant role is for nitro; the drain stops sessions with the reaper\'s grant)', () => {
    expect(h.backend.tenantStatements()).toEqual([]);
    expect(h.backend.drainStatements()).toEqual([]);
  });

  test('no statement grants a runtime-administration or ECR-push action', () => {
    const all = flat(h.resolve([
      ...h.backend.toolStatements(), ...h.backend.reaperStatements(), ...h.backend.drainStatements(), ...h.backend.tenantStatements(),
    ]));
    for (const banned of ['CreateAgentRuntime', 'UpdateAgentRuntime', 'DeleteAgentRuntime', 'ecr:Put', 'iam:']) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('what the core consumes', () => {
  const h = build();

  test('environment names the runtime ARN for the run-time class', () => {
    const env = h.backend.environment();
    expect(Object.keys(env)).toEqual(['AGENTCORE_RUNTIME_ARN']);
    expect(flat(h.stack.resolve(env.AGENTCORE_RUNTIME_ARN))).toContain('AgentRuntimeArn');
  });

  test('drain order is the runtime, and the log cleanup takes this runtime\'s prefix', () => {
    expect(h.backend.drainOrder()).toEqual([h.backend.runtime]);
    expect(h.backend.logCleanup()).toEqual({ prefixes: [`${RUNTIME_LOG_PREFIX}${RUNTIME_NAME}-`], names: [] });
    expect(RUNTIME_NAME).not.toContain('-');
  });

  test('outputs: the runtime ARN', () => {
    expect(Object.keys(h.backend.outputs())).toEqual(['runtimeArn']);
  });

  test('the backend is named agentcore', () => {
    expect(h.backend.name).toBe('agentcore');
  });
});

describe('usage logs (spec §3.8, §5.3)', () => {
  const t = build().template();

  test('a delivery of the runtime\'s USAGE_LOGS to a log group the construct owns', () => {
    t.hasResourceProperties('AWS::Logs::DeliverySource', {
      Name: 'log-delivery-agentcore-usage-source',
      LogType: 'USAGE_LOGS',
      ResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('Runtime'), 'AgentRuntimeArn'] },
    });
    t.hasResourceProperties('AWS::Logs::DeliveryDestination', {
      Name: 'log-delivery-agentcore-usage-destination',
      DeliveryDestinationType: 'CWL',
      DestinationResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('UsageLogs'), 'Arn'] },
    });
    t.resourceCountIs('AWS::Logs::Delivery', 1);
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stub/agentcore-usage', RetentionInDays: 30 });
    const [group] = Object.values(t.findResources('AWS::Logs::LogGroup', { Properties: { LogGroupName: '/stub/agentcore-usage' } }));
    expect((group as { DeletionPolicy: string }).DeletionPolicy).toBe('Delete');
  });

  test('the resource policy is this instance\'s own, under the sanitiser\'s name, and the destination waits for it', () => {
    t.hasResourceProperties('AWS::Logs::ResourcePolicy', { PolicyName: 'logs-resource-policy-agentcore-usage' });
    const [policy] = Object.values(t.findResources('AWS::Logs::ResourcePolicy'));
    const text = render((policy as { Properties: { PolicyDocument: unknown } }).Properties.PolicyDocument) as string;
    const [statement] = (JSON.parse(text) as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Principal: { Service: 'delivery.logs.amazonaws.com' },
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Condition: {
        StringEquals: { 'aws:SourceAccount': 'ACCOUNT' },
        ArnLike: { 'aws:SourceArn': 'arn:aws:logs:REGION:ACCOUNT:*' },
      },
    });
    // The stream ARN of the usage group: `<group>:log-stream:*`, never `<group-arn-with-:*>:log-stream:*`.
    expect(statement.Resource).toMatch(/^arn:aws:logs:REGION:ACCOUNT:log-group:<Ref:[A-Za-z0-9]*UsageLogs[A-Za-z0-9]*>:log-stream:\*$/);
    const [destination] = Object.values(t.findResources('AWS::Logs::DeliveryDestination'));
    expect(flat((destination as { DependsOn: string[] }).DependsOn)).toContain('UsageLogsPolicy');
  });

  test('the delivery waits for its source and destination', () => {
    const [delivery] = Object.values(t.findResources('AWS::Logs::Delivery'));
    expect((delivery as { DependsOn: string[] }).DependsOn.join(' ')).toMatch(/UsageDeliverySource[\s\S]*UsageDeliveryDestination|UsageDeliveryDestination[\s\S]*UsageDeliverySource/);
  });

  test('the L2\'s shared delivery resource policy is not created', () => {
    expect(flat(t.toJSON())).not.toContain('CdkLogGroupLogsDeliveryPolicy');
  });
});
