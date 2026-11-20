// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, CfnResource, Stack, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { BackendContext, NamedService } from '../src/backend-construct';
import { MICROVM_BASE_IMAGE_VERSION, MicrovmBackendResources, createMicrovmBackend } from '../src/backends/microvm.cdk';
import { BACKEND_ENV } from '../src/env';
import { runnerPath } from '../src/handler-entry';
import { resolveProps } from '../src/props';

const ACCOUNT = '1'.repeat(12);
const REGION = 'eu-central-1';
/** An ARN in the stack's partition, as CloudFormation renders it. */
const arn = (tail: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:${tail}`]] });
const INGRESS = arn(`lambda:${REGION}:aws:network-connector:aws-network-connector:HTTP_INGRESS`);
const INTERNET = arn(`lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`);

interface Fixture {
  readonly app: App;
  readonly stack: Stack;
  readonly backend: MicrovmBackendResources;
  readonly names: { service: NamedService; suffix: string }[];
}

function fixture(
  props: { microvm?: { memoryMiB?: number } } = {},
  envAgnostic = false,
  extra: { runnerDir?: string; context?: Record<string, unknown> } = {},
): Fixture {
  const app = new App({ context: extra.context });
  const stack = new Stack(app, 'S', envAgnostic ? {} : { env: { account: ACCOUNT, region: REGION } });
  // The same three subnet groups the core builds (spec §3.7).
  const vpc = new ec2.Vpc(stack, 'Vpc', {
    maxAzs: 2,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'Tool', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      { name: 'Sandbox', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
    ],
  });
  const names: { service: NamedService; suffix: string }[] = [];
  const ctx: BackendContext = {
    vpc,
    sandboxSubnets: { subnetGroupName: 'Sandbox' },
    toolSubnets: { subnetGroupName: 'Tool' },
    toolSecurityGroup: new ec2.SecurityGroup(stack, 'ToolSg', { vpc }),
    inputBucket: new s3.Bucket(stack, 'Bucket'),
    runnerDir: extra.runnerDir ?? runnerPath(),
    // A stand-in for the core's per-service sanitiser (spec §5.3); it keeps the charset the service allows.
    nameFor: (service, suffix) => {
      names.push({ service, suffix });
      return `${service}-${suffix}-0a1b2c3d`;
    },
    settings: resolveProps(props).settings,
  };
  const backend = createMicrovmBackend(stack, 'Backend-microvm', ctx) as MicrovmBackendResources;
  return { app, stack, backend, names };
}

/** Statements as the policy document renders them. */
function render(stack: Stack, statements: iam.PolicyStatement[]): Record<string, any>[] {
  return statements.map((s) => stack.resolve(s.toStatementJson()));
}

const actionsOf = (st: Record<string, any>[]) => st.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])).sort();

describe('microvm resources', () => {
  const f = fixture();
  const template = Template.fromStack(f.stack);

  test('one image, built from the artifact, on the pinned base, ARM_64, sized from the props', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Name: 'microvm-image-image-0a1b2c3d',
      BaseImageArn: arn(`lambda:${REGION}:aws:microvm-image:al2023-1`),
      BaseImageVersion: MICROVM_BASE_IMAGE_VERSION,
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Resources: [{ MinimumMemoryInMiB: 1024 }],
      AdditionalOsCapabilities: [],
      EnvironmentVariables: [],
      EgressNetworkConnectors: [INTERNET],
      BuildRoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^BackendmicrovmImageBuildRole'), 'Arn'] },
      CodeArtifact: { Uri: Match.anyValue() },
    });
  });

  test('hooks: the platform port, and the run, resume, suspend and ready hooks, with timeouts', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Hooks: {
        Port: 9000,
        MicrovmImageHooks: { Ready: 'ENABLED', ReadyTimeoutInSeconds: 120 },
        MicrovmHooks: {
          Run: 'ENABLED', RunTimeoutInSeconds: 10, Resume: 'ENABLED', ResumeTimeoutInSeconds: 10, Suspend: 'ENABLED', SuspendTimeoutInSeconds: 10,
        },
      },
    });
  });

  test('the build log goes to the group the cleanup resource deletes', () => {
    const logging = Object.values(template.findResources('AWS::Lambda::MicrovmImage'))[0].Properties.Logging;
    expect(logging).toEqual({ CloudWatch: { LogGroup: '/aws/lambda-microvms/microvm-image-image-0a1b2c3d' } });
    expect(f.backend.logCleanup()).toEqual({ prefixes: [], names: ['/aws/lambda-microvms/microvm-image-image-0a1b2c3d'] });
  });

  test('one connector, in the sandbox subnets only, protocol IPv4, for MicroVms', () => {
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 1);
    const connector = Object.values(template.findResources('AWS::Lambda::NetworkConnector'))[0];
    const cfg = connector.Properties.Configuration.VpcEgressConfiguration;
    expect(connector.Properties.Name).toBe('network-connector-connector-0a1b2c3d');
    expect(cfg.AssociatedComputeResourceTypes).toEqual(['MicroVm']);
    expect(cfg.NetworkProtocol).toBe('IPv4');
    expect(cfg.SubnetIds).toHaveLength(2);
    for (const s of cfg.SubnetIds) expect(s.Ref).toMatch(/^Vpc.*SandboxSubnet/);
    expect(cfg.SecurityGroupIds).toEqual([{ 'Fn::GetAtt': [expect.stringMatching(/ConnectorSecurityGroup/), 'GroupId'] }]);
    expect(connector.Properties.OperatorRole).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/ConnectorOperatorRole/), 'Arn'] });
  });

  test('the connector\'s security group has no ingress and no egress', () => {
    const groups = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
      .filter(([id]) => id.includes('ConnectorSecurityGroup'));
    expect(groups).toHaveLength(1);
    const props = groups[0][1].Properties;
    expect(props.SecurityGroupIngress).toBeUndefined();
    // The placeholder rule CloudFormation needs so that no default allow-all egress is added (S-1): it matches no real address.
    expect(props.SecurityGroupEgress).toEqual([expect.objectContaining({ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic' })]);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('the build role: Lambda trust, one object read, the one build log group', () => {
    const role = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.includes('ImageBuildRole'))![1];
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' },
    })]);
    const policy = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.includes('ImageBuildRole'))![1];
    const st = policy.Properties.PolicyDocument.Statement as Record<string, any>[];
    expect(st.map((s) => s.Sid)).toEqual(['ReadRunnerArtifact', 'WriteImageBuildLog']);
    expect(st[0].Action).toBe('s3:GetObject');
    expect(JSON.stringify(st[0].Resource)).toMatch(/\.zip|asset|[0-9a-f]{64}/);
    expect(st[1].Action).toEqual(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(JSON.stringify(st[1].Resource)).toContain('log-group:/aws/lambda-microvms/microvm-image-image-0a1b2c3d');
  });

  test('the connector operator role: Lambda trust, interface creation in the sandbox subnets, tags only on managed interfaces', () => {
    const operator = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.includes('ConnectorOperatorRole'))![1];
    expect(operator.Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' },
    })]);
    const policy = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.includes('ConnectorOperatorRole'))![1];
    const st = policy.Properties.PolicyDocument.Statement as Record<string, any>[];
    expect(st.map((s) => s.Sid)).toEqual(['CreateConnectorInterfaces', 'TagConnectorInterfaces']);
    expect(st[0].Action).toBe('ec2:CreateNetworkInterface');
    const resources = JSON.stringify(st[0].Resource);
    expect(resources).toContain('network-interface/*');
    expect(resources.match(/subnet\//g)).toHaveLength(2);
    expect(resources).toContain('security-group/');
    expect(resources).not.toMatch(/PrivateSubnet|PublicSubnet/); // only the Sandbox group's subnets
    expect(st[1]).toEqual(expect.objectContaining({
      Action: 'ec2:CreateTags',
      Condition: { StringEquals: { 'ec2:ManagedResourceOperator': 'network-connectors.lambda.amazonaws.com' } },
    }));
  });

  test('the image and the connector wait for their roles\' policies', () => {
    const image = Object.values(template.findResources('AWS::Lambda::MicrovmImage'))[0];
    const connector = Object.values(template.findResources('AWS::Lambda::NetworkConnector'))[0];
    expect(image.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/ImageBuildRoleDefaultPolicy/)]));
    expect(connector.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/ConnectorOperatorRoleDefaultPolicy/)]));
  });

  test('asks the core for exactly the two names, per service', () => {
    expect(f.names).toEqual([
      { service: 'microvm-image', suffix: 'image' },
      { service: 'network-connector', suffix: 'connector' },
    ]);
  });
});

describe('microvm artifact', () => {
  const f = fixture();
  const dir = path.join(f.app.outdir, f.backend.artifact.assetPath);
  const files = (d: string, prefix = ''): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));

  const dirs = (d: string, prefix = ''): string[] => fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => [`${prefix}${e.name}`, ...dirs(path.join(d, e.name), `${prefix}${e.name}/`)]);

  test('has the MicroVM Dockerfile at the root and the runner sources under runner/', () => {
    const all = files(dir);
    expect(all).toContain('Dockerfile');
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8')).toBe(fs.readFileSync(path.join(runnerPath(), 'microvm', 'Dockerfile'), 'utf8'));
    expect(all).toContain('runner/runner.py');
    expect(all).toContain('runner/protocol/vectors.json');
  });

  test('leaves out tests, the generator, bytecode and the container Dockerfile', () => {
    const all = files(dir);
    expect(all.filter((p) => /(^|\/)tests\//.test(p))).toEqual([]);
    expect(all.filter((p) => p.endsWith('.pyc'))).toEqual([]);
    expect(dirs(dir).filter((p) => p.includes('__pycache__'))).toEqual([]);
    expect(all).not.toContain('runner/protocol/make_vectors.py');
    expect(all).not.toContain('runner/Dockerfile');
    expect(all.filter((p) => p.startsWith('runner/microvm/'))).toEqual([]);
  });
});

describe('microvm policy statements', () => {
  const f = fixture();

  test('tool role: run, call and stop on the image; pass only the HTTP ingress and the sample connector', () => {
    const st = render(f.stack, f.backend.toolStatements());
    expect(st).toHaveLength(2);
    expect(st[0]).toEqual({
      Sid: 'MicrovmRunCallAndStop',
      Effect: 'Allow',
      Action: ['lambda:RunMicrovm', 'lambda:GetMicrovm', 'lambda:TerminateMicrovm', 'lambda:CreateMicrovmAuthToken'],
      Resource: { 'Fn::GetAtt': [expect.stringMatching(/Image/), 'ImageArn'] },
    });
    expect(st[1]).toEqual({
      Sid: 'MicrovmPassOnlyTheSampleConnectors',
      Effect: 'Allow',
      Action: 'lambda:PassNetworkConnector',
      Resource: [INGRESS, { 'Fn::GetAtt': [expect.stringMatching(/Connector/), 'Arn'] }],
    });
    // A start without the connector would get the managed internet egress; it is not passable (S-2, S-3).
    expect(JSON.stringify(st)).not.toContain('INTERNET_EGRESS');
    expect(JSON.stringify(st)).not.toContain('"*"');
  });

  test('reaper role: list on *, read and end on the image, nothing that starts or calls a MicroVM', () => {
    const st = render(f.stack, f.backend.reaperStatements());
    expect(st).toEqual([
      { Sid: 'MicrovmList', Effect: 'Allow', Action: 'lambda:ListMicrovms', Resource: '*' },
      {
        Sid: 'MicrovmReadAndStop',
        Effect: 'Allow',
        Action: ['lambda:GetMicrovm', 'lambda:TerminateMicrovm'],
        Resource: { 'Fn::GetAtt': [expect.stringMatching(/Image/), 'ImageArn'] },
      },
    ]);
    const actions = actionsOf(st);
    for (const forbidden of ['lambda:RunMicrovm', 'lambda:CreateMicrovmAuthToken', 'lambda:PassNetworkConnector']) {
      expect(actions).not.toContain(forbidden);
    }
  });

  test('tenant and drain roles add nothing on microvm; the drain takes the reaper\'s grants', () => {
    expect(f.backend.tenantStatements()).toEqual([]);
    expect(f.backend.drainStatements()).toEqual([]);
  });

  test('statement ids are unique across the sets, so the core can merge them with other backends\'', () => {
    const all = [...f.backend.toolStatements(), ...f.backend.reaperStatements()].map((s) => s.sid);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((sid) => sid?.startsWith('Microvm'))).toBe(true);
  });
});

describe('microvm seam with the core', () => {
  const f = fixture();

  test('environment holds the image and the connector, which MicrovmBackend reads', () => {
    const env = f.backend.environment();
    expect(Object.keys(env).sort()).toEqual([BACKEND_ENV.MICROVM_IMAGE_ARN, BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN].sort());
    expect(f.stack.resolve(env[BACKEND_ENV.MICROVM_IMAGE_ARN])).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/Image/), 'ImageArn'] });
    expect(f.stack.resolve(env[BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN])).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/Connector/), 'Arn'] });
  });

  test('the drain waits for the image and the connector', () => {
    const order = f.backend.drainOrder();
    expect(order).toEqual([f.backend.image, f.backend.connector]);
    for (const c of order) expect(c).toBeInstanceOf(CfnResource);
  });

  test('needs no endpoint and no endpoint client', () => {
    expect(f.backend.endpoints()).toEqual([]);
    expect(f.backend.endpointClients()).toEqual([]);
  });

  test('publishes the image ARN', () => {
    expect(Object.keys(f.backend.outputs())).toEqual(['imageArn']);
    expect(f.stack.resolve(f.backend.outputs().imageArn)).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/Image/), 'ImageArn'] });
  });

  test('the factory returns the microvm backend', () => {
    expect(f.backend.name).toBe('microvm');
  });
});

describe('memory sizing', () => {
  test('the image takes microvm.memoryMiB and warns about a size the spikes did not run', () => {
    const measured = fixture({ microvm: { memoryMiB: 2048 } });
    Template.fromStack(measured.stack).hasResourceProperties('AWS::Lambda::MicrovmImage', { Resources: [{ MinimumMemoryInMiB: 2048 }] });
    Annotations.fromStack(measured.stack).hasNoWarning('*', Match.stringLikeRegexp('not measured'));

    const other = fixture({ microvm: { memoryMiB: 4096 } });
    Template.fromStack(other.stack).hasResourceProperties('AWS::Lambda::MicrovmImage', { Resources: [{ MinimumMemoryInMiB: 4096 }] });
    Annotations.fromStack(other.stack).hasWarning('*', Match.stringLikeRegexp('4096 was not measured'));
  });
});

describe('cdk-nag', () => {
  /** An environment-agnostic stack, as the demo app's is (the acknowledgement ids carry the pseudo parameters), with the fixture's own findings acknowledged. */
  function checked(): Fixture {
    const f = fixture({}, true);
    // The reaper role is the core's; it acknowledges the one `*` of lambda:ListMicrovms, which takes no resource.
    const probe = new iam.Role(f.stack, 'ReaperProbe', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    for (const st of f.backend.reaperStatements()) probe.addToPolicy(st);
    Validations.of(probe).acknowledge({ id: 'AwsSolutions::AwsSolutions-IAM5[Resource::*]', reason: 'lambda:ListMicrovms takes no resource.' });
    // The VPC and the bucket are the fixture's, not the backend's.
    Validations.of(f.stack.node.findChild('Vpc')).acknowledge({ id: 'AwsSolutions::AwsSolutions-VPC7', reason: 'Test fixture.' });
    for (const id of ['S1', 'S10']) {
      Validations.of(f.stack.node.findChild('Bucket')).acknowledge({ id: `AwsSolutions::AwsSolutions-${id}`, reason: 'Test fixture.' });
    }
    Validations.of(f.stack).addPlugins(new AwsSolutionsChecks(f.stack, { verbose: false }));
    return f;
  }

  test('the microvm resources raise no AwsSolutions finding once their wildcards are acknowledged', () => {
    expect(() => checked().app.synth()).not.toThrow();
  });

  test('the same check fails on an unacknowledged wildcard under the backend, so it can fail', () => {
    const f = checked();
    const extra = new iam.Role(f.backend, 'Wildcard', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    extra.addToPolicy(new iam.PolicyStatement({ actions: ['s3:*'], resources: ['*'] }));
    expect(() => f.app.synth()).toThrow(/S\/Backend-microvm\/Wildcard\/DefaultPolicy/);
  });
});

describe('artifact staging', () => {
  test('leaves out a nested __pycache__ and its bytecode', () => {
    const runner = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-copy-'));
    try {
      fs.cpSync(runnerPath(), runner, { recursive: true });
      fs.mkdirSync(path.join(runner, 'protocol', '__pycache__'), { recursive: true });
      fs.writeFileSync(path.join(runner, 'protocol', '__pycache__', 'x.cpython-313.pyc'), 'x');
      fs.writeFileSync(path.join(runner, 'keep.py'), 'x = 1\n');
      const f = fixture({}, false, { runnerDir: runner });
      const staged = path.join(f.app.outdir, f.backend.artifact.assetPath);
      const all = fs.readdirSync(staged, { recursive: true }).map(String);
      expect(all).toContain(path.join('runner', 'keep.py'));
      expect(all.filter((p) => p.includes('__pycache__') || p.endsWith('.pyc'))).toEqual([]);
    } finally {
      fs.rmSync(runner, { recursive: true, force: true });
    }
  });

  test('refuses to run with asset staging disabled, because the artifact is staged in a temporary directory', () => {
    expect(() => fixture({}, false, { context: { [cxapi.DISABLE_ASSET_STAGING_CONTEXT]: true } })).toThrow(/asset staging must stay on/);
  });
});
