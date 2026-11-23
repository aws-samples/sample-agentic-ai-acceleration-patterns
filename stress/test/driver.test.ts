// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SSM_AGENT_MESSAGE_ACTIONS, StressDriverStack, UNIQUE_LAUNCH_TEMPLATE_FLAG, stressIdentityParameter } from '../driver/stress-driver.cdk';
import { TIERS } from '../src/tiers';

const MAX_RESOURCES = 450;
const IDENTITY = stressIdentityParameter('StressTest');

function stackOf(props: { instanceType: string; identityParameterName?: string; parameterPrefixes?: string[] }): StressDriverStack {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [], [UNIQUE_LAUNCH_TEMPLATE_FLAG]: true } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return new StressDriverStack(app, 'StressTest-driver', { identityParameterName: IDENTITY, ...props });
}

describe('StressDriverStack at small (spec §3.1)', () => {
  const stack = stackOf({ instanceType: TIERS.small.driverInstanceType, parameterPrefixes: ['/slice/registry/'] });
  const template = Template.fromStack(stack);
  const json = template.toJSON();

  it('passes cdk-nag, stays under the ceiling, has the outputs', () => {
    expect(() => template.toJSON()).not.toThrow();
    expect(Object.keys(json.Resources)).not.toHaveLength(0);
    expect(Object.keys(json.Resources).length).toBeLessThan(MAX_RESOURCES);
    expect(Object.keys(json.Outputs)).toEqual(expect.arrayContaining(['InstanceId', 'ResultsBucketName']));
  });

  it('has no inbound rule and outbound 443 only', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    const groups = template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: Match.stringLikeRegexp('Stress driver host') } });
    expect(Object.keys(groups)).toHaveLength(1);
    const sg = Object.values(groups)[0] as any;
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    expect(sg.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })]);
  });

  it('runs the host with no public IP, IMDSv2 required, a 30 GB encrypted gp3 root and no key pair', () => {
    const instance = Object.values(template.findResources('AWS::EC2::Instance'))[0] as any;
    expect(instance.Properties.KeyName).toBeUndefined();
    expect(instance.Properties.InstanceType).toBe(TIERS.small.driverInstanceType);
    // No public IP: the one interface says so explicitly (not by omission), and the subnet it is
    // placed in does not hand one out at launch either.
    const nics = instance.Properties.NetworkInterfaces;
    expect(nics).toHaveLength(1);
    expect(nics[0].AssociatePublicIpAddress).toBe(false);
    const subnetId = nics[0].SubnetId?.Ref;
    expect(typeof subnetId).toBe('string');
    expect(json.Resources[subnetId].Type).toBe('AWS::EC2::Subnet');
    expect(json.Resources[subnetId].Properties.MapPublicIpOnLaunch).toBe(false);
    expect(instance.Properties.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/xvda', Ebs: { VolumeSize: 30, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } },
    ]);
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } } });
  });

  it('names the launch template after the stack, so two drivers can share an account', () => {
    const lt = Object.values(template.findResources('AWS::EC2::LaunchTemplate'))[0] as any;
    expect(lt.Properties.LaunchTemplateName).not.toBe('HostLaunchTemplate');
    expect(String(lt.Properties.LaunchTemplateName)).toContain('StressTest');
  });

  it('has one NAT gateway, the S3 gateway endpoint only, and a private results bucket', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' })] },
    });
  });

  function hostPolicies(): any[] {
    return Object.values(json.Resources).filter(
      (r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('HostRole'),
    ) as any[];
  }

  function statement(sid: string): any {
    return hostPolicies()
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find((s: any) => s.Sid === sid);
  }

  it('grants the host exactly the stress-test and SSM Agent actions, and no managed policy', () => {
    const actions = hostPolicies().flatMap((p) => p.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat()));
    expect(new Set(actions)).toEqual(
      new Set([
        'execute-api:Invoke',
        'ssm:GetParameter',
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
        'ssm:UpdateInstanceInformation',
        'cloudwatch:PutMetricData',
        ...SSM_AGENT_MESSAGE_ACTIONS,
      ]),
    );
    const role = Object.values(template.findResources('AWS::IAM::Role', { Properties: { Description: Match.stringLikeRegexp('Stress driver host') } }))[0] as any;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('allows ssm:GetParameter on no resource but its own parameters', () => {
    const wildcards = hostPolicies()
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => [s.Resource].flat().includes('*'));
    expect(wildcards.map((s: any) => s.Sid)).toEqual(['SsmAgentMessages', 'PublishRunMetrics']);
    expect([statement('SsmAgentMessages').Action].flat().every((a: string) => a.startsWith('ec2messages:') || a.startsWith('ssmmessages:'))).toBe(true);
  });

  it('may publish metrics to the StressRun namespace only', () => {
    expect(statement('PublishRunMetrics')).toMatchObject({
      Action: 'cloudwatch:PutMetricData',
      Effect: 'Allow',
      Resource: '*',
      Condition: { StringEquals: { 'cloudwatch:namespace': 'StressRun' } },
    });
  });

  it('keeps the instance registration on the instance', () => {
    expect(JSON.stringify(statement('SsmAgentRegister').Resource)).toContain(':instance/*');
  });

  it('reads the stress identity parameter and the slice prefixes only', () => {
    const paths = (statement('ReadPublishedParameters').Resource as unknown[]).map((r) => JSON.stringify(r));
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes(`parameter${IDENTITY}"`))).toBe(true);
    expect(paths.some((p) => p.includes('parameter/slice/registry/*'))).toBe(true);
    expect(paths.some((p) => p.includes('/application-plane/'))).toBe(false);
  });
});

describe('StressDriverStack inputs', () => {
  it('takes the instance type of the tier', () => {
    const template = Template.fromStack(stackOf({ instanceType: TIERS.large.driverInstanceType }));
    template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: TIERS.large.driverInstanceType });
  });

  it('reads only the stress identity parameter without a slice prefix', () => {
    const template = Template.fromStack(stackOf({ instanceType: 't3.large' }));
    const resources = JSON.stringify(template.toJSON().Resources);
    expect(resources).toContain(`parameter${IDENTITY}"`);
    expect(resources).not.toContain(`parameter${IDENTITY}*`);
  });

  it('reads the parameters a slice passes, such as the integration identity, only when it passes them', () => {
    const template = Template.fromStack(stackOf({ instanceType: 't3.large', parameterPrefixes: ['/application-plane/shared/identity/'] }));
    expect(JSON.stringify(template.toJSON().Resources)).toContain('parameter/application-plane/shared/identity/*');
  });

  it.each(['no-slash', '/with space/', '/a;b/', ''])('refuses the parameter prefix %p', (prefix) => {
    expect(() => stackOf({ instanceType: 't3.large', parameterPrefixes: [prefix] })).toThrow(/parameter prefix/);
  });

  it.each(['identity', '/x/identity/', '/a b', ''])('refuses the identity parameter %p', (name) => {
    expect(() => stackOf({ instanceType: 't3.large', identityParameterName: name })).toThrow(/identity parameter/);
  });
});

describe('driver/app.ts, as deploy.sh synthesises it', () => {
  it('sets the launch-template flag and grants the stress identity of its prefix', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-app-'));
    try {
      execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'driver/app.ts'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, STRESS_PREFIX: 'AppTest', STRESS_TIER: 'small', CDK_OUTDIR: out, CDK_DEFAULT_REGION: 'eu-central-1', CDK_DEFAULT_ACCOUNT: '111111111111' },
        stdio: 'pipe',
      });
      const template = fs.readFileSync(path.join(out, 'AppTest-driver.template.json'), 'utf8');
      expect(template).toMatch(/"LaunchTemplateName": "AppTestdriverHostLaunchTemplate[0-9A-F]+"/);
      expect(template).toContain(':parameter/AppTest/identity"');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
