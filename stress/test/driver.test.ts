// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { IDENTITY_PARAMETER_PREFIX, StressDriverStack } from '../driver/stress-driver.cdk';
import { TIERS } from '../src/tiers';

const MAX_RESOURCES = 450;

function stackOf(props: { instanceType: string; parameterPrefixes?: string[] }): StressDriverStack {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return new StressDriverStack(app, 'StressTest-driver', props);
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
    expect(instance.Properties.NetworkInterfaces?.[0]?.AssociatePublicIpAddress ?? false).toBe(false);
    expect(instance.Properties.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/xvda', Ebs: { VolumeSize: 30, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } },
    ]);
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', { LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } } });
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

  it('grants the host exactly the stress-test actions', () => {
    const actions = hostPolicies().flatMap((p) => p.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat()));
    expect(new Set(actions)).toEqual(new Set(['execute-api:Invoke', 'ssm:GetParameter', 's3:GetObject', 's3:PutObject', 's3:ListBucket']));
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']] }],
    });
  });

  it('reads parameters under tenant-identity and the slice prefixes only', () => {
    const statement = hostPolicies()
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find((s: any) => s.Sid === 'ReadPublishedParameters');
    const paths = (statement.Resource as unknown[]).map((r) => JSON.stringify(r));
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes(`parameter${IDENTITY_PARAMETER_PREFIX}*`))).toBe(true);
    expect(paths.some((p) => p.includes('parameter/slice/registry/*'))).toBe(true);
  });
});

describe('StressDriverStack inputs', () => {
  it('takes the instance type of the tier', () => {
    const template = Template.fromStack(stackOf({ instanceType: TIERS.large.driverInstanceType }));
    template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: TIERS.large.driverInstanceType });
  });

  it('reads only tenant-identity parameters without a slice prefix', () => {
    const template = Template.fromStack(stackOf({ instanceType: 't3.large' }));
    const statement = JSON.stringify(template.toJSON().Resources);
    expect(statement).toContain(`parameter${IDENTITY_PARAMETER_PREFIX}*`);
  });

  it.each(['no-slash', '/with space/', '/a;b/', ''])('refuses the parameter prefix %p', (prefix) => {
    expect(() => stackOf({ instanceType: 't3.large', parameterPrefixes: [prefix] })).toThrow(/parameter prefix/);
  });
});
