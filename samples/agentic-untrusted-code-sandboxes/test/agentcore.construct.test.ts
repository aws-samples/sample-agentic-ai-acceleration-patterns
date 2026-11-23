// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The agentcore backend inside the real core construct: what the core builds
 * from `endpoints()`, `endpointClients()`, `drainOrder()`, `logCleanup()`,
 * the statement lists and `environment()`, as one stack.
 */

import { App, Stack, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NAME_PATTERNS } from '../src/names';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

type Json = Record<string, unknown>;

function synth(
  agentcore?: { sessionFiles: boolean },
  backends: Array<'microvm' | 'nitro' | 'agentcore'> = ['agentcore'],
  s3PrefixListId?: string,
) {
  const stack = new Stack(new App(), 'S');
  new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends, agentcore, s3PrefixListId });
  return Template.fromStack(stack);
}

/** Resolved CloudFormation with every intrinsic flattened to text, so a resource compares as a string. */
function text(v: unknown): string {
  if (Array.isArray(v)) return v.map(text).join('|');
  if (v && typeof v === 'object') {
    const o = v as Json;
    if ('Fn::Join' in o) {
      const [sep, parts] = o['Fn::Join'] as [string, unknown[]];
      return parts.map(text).join(sep);
    }
    if (o.Ref === 'AWS::Partition') return 'aws';
    if (typeof o.Ref === 'string') return `<${o.Ref}>`;
    if ('Fn::GetAtt' in o) return `<${(o['Fn::GetAtt'] as string[]).join('.')}>`;
    return JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, x]) => [k, text(x)])));
  }
  return String(v);
}

function resources(t: Template, type: string): Array<[string, Json]> {
  return Object.entries(t.findResources(type)) as Array<[string, Json]>;
}

function statementsOf(t: Template, roleIdPart: string): Json[] {
  return resources(t, 'AWS::IAM::Policy')
    .filter(([, r]) => text((r.Properties as Json).Roles).includes(roleIdPart))
    .flatMap(([, r]) => (((r.Properties as Json).PolicyDocument as Json).Statement as Json[]));
}

const grantsAgentcore = (s: Json) => JSON.stringify(s.Action).includes('bedrock-agentcore:');

describe('the runtime, with the core', () => {
  const t = synth();
  const [[runtimeId, runtime]] = resources(t, 'AWS::BedrockAgentCore::Runtime');

  test('the runtime name comes from the core\'s sanitiser and holds no hyphen', () => {
    const name = (runtime.Properties as Json).AgentRuntimeName as string;
    expect(name).toMatch(NAME_PATTERNS['agentcore-runtime']);
    expect(name).not.toContain('-');
  });

  test('tool role: invoke and stop; reaper and drain roles: stop only; tenant role: nothing for agentcore', () => {
    const tool = statementsOf(t, 'ToolRole').filter(grantsAgentcore);
    expect(tool).toHaveLength(1);
    expect(tool[0].Action).toEqual(['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession']);
    const reaper = statementsOf(t, 'ReaperRole').filter(grantsAgentcore);
    expect(reaper).toHaveLength(1);
    expect(reaper[0].Action).toBe('bedrock-agentcore:StopRuntimeSession');
    expect(statementsOf(t, 'ToolTenantRole').filter(grantsAgentcore)).toEqual([]);
    // The drain role is the reaper role plus the instance actions, so it carries the reaper's statement and no more.
    expect(statementsOf(t, 'DrainRole').filter(grantsAgentcore)).toEqual(reaper);
    for (const s of [...tool, ...reaper]) {
      expect(s.Condition).toBeUndefined();
      expect(text(s.Resource)).toContain(`<${runtimeId}.AgentRuntimeArn>`);
    }
  });

  test('the functions get the runtime ARN in their environment', () => {
    const withArn = resources(t, 'AWS::Lambda::Function')
      .filter(([, r]) => 'AGENTCORE_RUNTIME_ARN' in ((((r.Properties as Json).Environment as Json | undefined)?.Variables as Json | undefined) ?? {}));
    expect(withArn.length).toBeGreaterThanOrEqual(3);
    for (const [, r] of withArn) {
      const vars = ((r.Properties as Json).Environment as Json).Variables as Json;
      expect(text(vars.AGENTCORE_RUNTIME_ARN)).toBe(`<${runtimeId}.AgentRuntimeArn>`);
    }
  });

  test('delete order: the drain goes before the runtime, the log cleanup after it', () => {
    const [[drainId]] = resources(t, 'AWS::CloudFormation::CustomResource').filter(([, r]) => 'Backends' in (r.Properties as Json));
    const drain = t.toJSON().Resources[drainId] as Json;
    expect(drain.DependsOn).toContain(runtimeId);
    expect(runtime.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/LogCleanup/)]));
    const [[, cleanup]] = resources(t, 'AWS::CloudFormation::CustomResource').filter(([, r]) => 'Prefixes' in (r.Properties as Json));
    const name = (runtime.Properties as Json).AgentRuntimeName as string;
    expect((cleanup.Properties as Json).Prefixes).toEqual([`/aws/bedrock-agentcore/runtimes/${name}-`]);
  });

  test('the runtime waits for its role, the role\'s policy, its security group with the rules in it, and the image copy', () => {
    const deps = runtime.DependsOn as string[];
    const has = (re: RegExp) => deps.filter((d) => re.test(d));
    expect(has(/BackendagentcoreRuntimeRole[0-9A-F]{8}$/)).toHaveLength(1);
    expect(has(/RuntimeRoleDefaultPolicy/)).toHaveLength(1);
    expect(has(/BackendagentcoreSecurityGroup[0-9A-F]{8}$/)).toHaveLength(1);
    // The two egress rules the core adds, one to the ECR endpoint group and one to the Logs endpoint group.
    expect(has(/SecurityGrouptoS.*Endpoints(Ecr|Logs)EndpointSecurityGroup/)).toHaveLength(2);
    expect(has(/RunnerImagesCopyarm64/)).toHaveLength(1);
    // The core orders the runtime after the four endpoints (S3, ECR api, ECR dkr, Logs).
    expect(has(/Endpoints(S3|EcrApi|EcrDkr|Logs)[0-9A-F]{8}$/)).toHaveLength(4);
  });

  test('the runtime pulls the tag the core copied', () => {
    const uri = text(((runtime.Properties as Json).AgentRuntimeArtifact as Json));
    const [[, copy]] = resources(t, 'Custom::CDKECRDeployment');
    const tagOf = (v: unknown) => /:(runner-arm64-[0-9a-f]{64})/.exec(text(v))?.[1];
    expect(tagOf(uri)).toBeDefined();
    expect(tagOf(uri)).toBe(tagOf((copy.Properties as Json).DestImage));
  });

  test('the runtime sits in the sandbox subnets with the backend security group', () => {
    const config = ((runtime.Properties as Json).NetworkConfiguration as Json).NetworkModeConfig as Json;
    expect(config.Subnets).toHaveLength(2);
    expect(config.SecurityGroups).toHaveLength(1);
    const sandboxSubnets = resources(t, 'AWS::EC2::Subnet')
      .filter(([id]) => id.includes('SandboxSubnet')).map(([id]) => id);
    expect(sandboxSubnets).toHaveLength(2);
    for (const s of config.Subnets as Json[]) expect(sandboxSubnets).toContain(s.Ref as string);
  });
});

describe('the endpoints the core builds for the backend (spec §3.7)', () => {
  const policyOf = (t: Template, service: string): Json[] => {
    const [[, endpoint]] = resources(t, 'AWS::EC2::VPCEndpoint').filter(([, r]) => text((r.Properties as Json).ServiceName).endsWith(service));
    return ((endpoint.Properties as Json).PolicyDocument as Json).Statement as Json[];
  };

  test('the backend alone gets the S3, ECR api, ECR dkr and Logs endpoints', () => {
    const t = synth();
    expect(resources(t, 'AWS::EC2::VPCEndpoint').map(([, r]) => text((r.Properties as Json).ServiceName).replace('com.amazonaws.<AWS::Region>.', '').split('|')[0].replace(/"/g, '')).sort())
      .toEqual(['ecr.api', 'ecr.dkr', 'logs', 's3']);
  });

  test('S3: the ECR layer bucket only, and the sessions prefix only with sessionFiles', () => {
    const without = policyOf(synth(), '.s3');
    expect(without.map((s) => s.Sid)).toEqual(['EcrLayerBucket']);
    const withFiles = policyOf(synth({ sessionFiles: true }), '.s3');
    expect(withFiles.map((s) => s.Sid)).toEqual(['EcrLayerBucket', 'SessionObjects', 'SessionList']);
  });

  test('ECR: the token on * and the pull on the runner repository only', () => {
    const statements = policyOf(synth(), '.ecr.api');
    expect(statements).toHaveLength(2);
    for (const s of statements) expect(s).toMatchObject({ Effect: 'Allow', Principal: { AWS: '*' } });
    expect(statements[0]).toMatchObject({ Sid: 'AuthorizationToken', Action: 'ecr:GetAuthorizationToken', Resource: '*' });
    expect(statements[1].Action).toEqual(['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']);
    expect(text(statements[1].Resource)).toContain('RunnerRepository');
    expect(text(statements[1].Resource)).not.toContain('*');
  });

  test('Logs: this runtime\'s group prefix only', () => {
    const t = synth();
    const [[, runtime]] = resources(t, 'AWS::BedrockAgentCore::Runtime');
    const name = (runtime.Properties as Json).AgentRuntimeName as string;
    const statements = policyOf(t, '.logs');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
    });
    expect(text(statements[0].Resource)).toBe(`arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/${name}-*`);
  });

  test('the runtime group has no ingress and exactly three egress rules: the ECR and Logs endpoint groups, and S3', () => {
    const t = synth();
    const mine = (r: Json) => text(r.GroupId).includes('Backendagentcore');
    const separate = resources(t, 'AWS::EC2::SecurityGroupEgress').map(([, r]) => r.Properties as Json).filter(mine);
    expect(separate).toHaveLength(2);
    const targets = separate.map((r) => text(r.DestinationSecurityGroupId)).sort();
    expect(targets[0]).toMatch(/EcrEndpointSecurityGroup/);
    expect(targets[1]).toMatch(/LogsEndpointSecurityGroup/);
    for (const r of separate) expect([r.IpProtocol, r.FromPort, r.ToPort]).toEqual(['tcp', 443, 443]);
    const [[, group]] = resources(t, 'AWS::EC2::SecurityGroup').filter(([id]) => id.includes('Backendagentcore'));
    const properties = group.Properties as Json;
    expect(properties.SecurityGroupIngress).toBeUndefined();
    // In the VPC the core creates, any address on 443 stands in for the S3 prefix list (spec 3.7): the sandbox route table has no default route.
    expect(properties.SecurityGroupEgress).toEqual([
      expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
    ]);
    for (const [, r] of resources(t, 'AWS::EC2::SecurityGroupIngress')) {
      expect((r.Properties as Json).FromPort).toBe(443);
    }
  });

  test('with an S3 prefix list id the inline S3 rule goes to the prefix list, not to any address', () => {
    const t = synth(undefined, ['agentcore'], 'pl-0123456789abcdef0');
    const [[, group]] = resources(t, 'AWS::EC2::SecurityGroup').filter(([id]) => id.includes('Backendagentcore'));
    const inline = (group.Properties as Json).SecurityGroupEgress as Json[] | undefined;
    expect(JSON.stringify(inline ?? [])).not.toContain('0.0.0.0/0');
    const prefixed = resources(t, 'AWS::EC2::SecurityGroupEgress').map(([, r]) => r.Properties as Json)
      .filter((r) => text(r.GroupId).includes('Backendagentcore') && r.DestinationPrefixListId === 'pl-0123456789abcdef0');
    expect(prefixed).toHaveLength(1);
    expect([prefixed[0].IpProtocol, prefixed[0].FromPort, prefixed[0].ToPort]).toEqual(['tcp', 443, 443]);
  });
});

describe('with all three backends', () => {
  test('the agentcore resources and the Logs endpoint policy are the same with the other backends enabled', () => {
    const t = synth(undefined, ['microvm', 'nitro', 'agentcore']);
    expect(resources(t, 'AWS::BedrockAgentCore::Runtime')).toHaveLength(1);
    const [[, logs]] = resources(t, 'AWS::EC2::VPCEndpoint').filter(([, r]) => text((r.Properties as Json).ServiceName).endsWith('.logs'));
    expect(text(((logs.Properties as Json).PolicyDocument as Json).Statement)).toContain('/aws/bedrock-agentcore/runtimes/');
  });
});

describe('cdk-nag', () => {
  test.each([false, true])('the backend inside the core leaves no unacknowledged finding (sessionFiles %s)', (sessionFiles) => {
    const app = new App();
    const stack = new Stack(app, 'S');
    new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends: ['agentcore'], agentcore: { sessionFiles } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).not.toThrow();
  });
});
