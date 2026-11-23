// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The StressDriver stack (docs/stress-test.spec.md §3.1; stress ADR-0007): the k6 host every
 * slice runs its load from. One AZ, one NAT gateway in a public subnet, the host in a private
 * subnet with no public IP and no inbound rule, reached through SSM Session Manager.
 * Every call leaves through the NAT gateway to the public AWS endpoints, as a
 * tenant's client would; the only VPC endpoint is the free S3 gateway one.
 * The k6 summaries and result records go to a results bucket before the host is destroyed.
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { acknowledgeGranularFinding, nagFindingResource } from './nag';

/** Where the host installs the scripts and writes its output. */
export const STRESS_HOME = '/opt/stress';

/**
 * The CDK feature flag that names the host's IMDSv2 launch template after its stack. The app
 * must set it, or two driver stacks in one account clash on the name `HostLaunchTemplate`.
 */
export const UNIQUE_LAUNCH_TEMPLATE_FLAG = '@aws-cdk/aws-ec2:uniqueImdsv2TemplateName';

/** A parameter name or path prefix the host may read: starts with `/`, then letters, digits and `_.-/`. */
const PARAMETER_PATH = /^\/[A-Za-z0-9_.\-/]+$/;

/** The stress identity's one parameter, `/<STRESS_PREFIX>/identity` (stress ADR-0002, tenant-identity ADR-0042). */
export function stressIdentityParameter(stressPrefix: string): string {
  return `/${stressPrefix}/identity`;
}

/**
 * The actions the SSM Agent needs for Run Command and Session Manager. They replace the AWS
 * managed `AmazonSSMManagedInstanceCore`, which also allows `ssm:GetParameter(s)` on every
 * parameter in the account (stress ADR-0009).
 */
export const SSM_AGENT_MESSAGE_ACTIONS = [
  'ec2messages:AcknowledgeMessage',
  'ec2messages:DeleteMessage',
  'ec2messages:FailMessage',
  'ec2messages:GetEndpoint',
  'ec2messages:GetMessages',
  'ec2messages:SendReply',
  'ssmmessages:CreateControlChannel',
  'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenControlChannel',
  'ssmmessages:OpenDataChannel',
] as const;

export interface StressDriverStackProps extends StackProps {
  /** An EC2 instance type: the tier's `driverInstanceType` (stress/src/tiers.ts). */
  readonly instanceType: string;
  /**
   * The stress identity's parameter, read for the tenants' tokens: `stressIdentityParameter(prefix)`.
   * The host gets `ssm:GetParameter` on this one name.
   */
  readonly identityParameterName: string;
  /**
   * Further SSM parameter path prefixes the host may read, each starting with `/` (a slice's
   * registry prefix). The host gets `ssm:GetParameter` on `<prefix>*`.
   */
  readonly parameterPrefixes?: readonly string[];
}

export class StressDriverStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly instance: ec2.Instance;
  readonly securityGroup: ec2.SecurityGroup;
  readonly bucket: s3.Bucket;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: StressDriverStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
      // S3 only, and free. No execute-api interface endpoint: it would turn on
      // private DNS for every *.execute-api name in the VPC (§8.1).
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });
    Validations.of(this.vpc).acknowledge({
      id: 'AwsSolutions-VPC7',
      reason: 'Stress-test driver VPC, destroyed after each run: no flow log, for cost (spec §3.1). Nothing listens in it; the host has no inbound rule.',
    });

    this.bucket = new s3.Bucket(this, 'Results', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, // test stack
      autoDeleteObjects: true,
    });
    Validations.of(this.bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Stress-test results bucket: the host is its only writer and the run its only reader; objects expire after 30 days and the bucket is deleted with the stack. Access logs would add a second bucket for no reader.',
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'HostSecurityGroup', {
      vpc: this.vpc,
      description: 'Stress driver host: no inbound rule; outbound HTTPS only',
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to the public AWS endpoints through the NAT gateway');

    this.role = new iam.Role(this, 'HostRole', {
      description: 'Stress driver host: the SSM Agent, execute-api:Invoke, the identity and slice registry parameters, the results bucket',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    const instanceResource = `arn:${this.partition}:ec2:${this.region}:${this.account}:instance/*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmAgentRegister',
        actions: ['ssm:UpdateInstanceInformation'],
        resources: [instanceResource],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmAgentMessages',
        actions: [...SSM_AGENT_MESSAGE_ACTIONS],
        resources: ['*'],
      }),
    );
    // The host relay publishes each minute of a k6 scenario to the `StressRun` namespace (stress
    // ADR-0022). The action has no resource type; the namespace condition is the limit.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishRunMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'StressRun' } },
      }),
    );
    const invokeResource = `arn:${this.partition}:execute-api:${this.region}:${this.account}:*/*/*/*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeApis',
        actions: ['execute-api:Invoke'],
        resources: [invokeResource],
      }),
    );
    const parameterArn = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;
    if (!PARAMETER_PATH.test(props.identityParameterName) || props.identityParameterName.endsWith('/')) {
      throw new Error(`the identity parameter must be a name starting with /, letters, digits and _.-/ only: ${props.identityParameterName}`);
    }
    const parameterPrefixes = [...new Set(props.parameterPrefixes ?? [])];
    for (const prefix of parameterPrefixes) {
      if (!PARAMETER_PATH.test(prefix)) {
        throw new Error(`a parameter prefix must start with / and hold letters, digits and _.-/ only: ${prefix}`);
      }
    }
    const prefixParameters = parameterPrefixes.map((prefix) => parameterArn(`${prefix}*`));
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadPublishedParameters',
        actions: ['ssm:GetParameter'],
        resources: [parameterArn(props.identityParameterName), ...prefixParameters],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadWriteResults',
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListResults',
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      // The AWS CLI v2 is preinstalled on Amazon Linux 2023. At first boot
      // another dnf (the image's own update) may hold the rpm lock, and the
      // k6 GPG key import then fails with "can't create transaction lock"
      // (seen 2026-11-09); each install retries until the lock is free.
      'retry() { for i in $(seq 1 30); do "$@" && return 0; sleep 10; done; return 1; }',
      'retry dnf install -y jq',
      'retry dnf install -y https://dl.k6.io/rpm/repo.rpm',
      'retry rpm --import https://dl.k6.io/key.gpg',
      'retry dnf install -y k6',
      'k6 version',
      `mkdir -p ${STRESS_HOME}`,
    );

    this.instance = new ec2.Instance(this, 'Host', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: this.securityGroup,
      role: this.role,
      requireImdsv2: true,
      associatePublicIpAddress: false,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }),
        },
      ],
    });
    Validations.of(this.instance).acknowledge({
      id: 'AwsSolutions-EC28',
      reason: 'Stress-test driver host, alive for one run: basic monitoring is enough; the run measures the ingress, not the host.',
    });
    Validations.of(this.instance).acknowledge({
      id: 'AwsSolutions-EC29',
      reason: 'Stress-test driver host, destroyed after each run: termination protection would block the teardown.',
    });

    // Granular IAM findings on the host role (cdk-nag renders them from the policy resources).
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, instanceResource)}]`,
      'The SSM Agent registers the instance it runs on; the instance id is not known before the role exists (stress ADR-0009).',
    );
    acknowledgeGranularFinding(
      this.role,
      'AwsSolutions-IAM5[Resource::*]',
      'The ec2messages and ssmmessages actions the SSM Agent needs (stress ADR-0009) and cloudwatch:PutMetricData for the run dashboard (stress ADR-0022) have no resource type, so IAM takes only *; PutMetricData is limited to the StressRun namespace by condition.',
    );
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, invokeResource)}]`,
      'The Entitlements API and the platform API have ids this stack does not know (spec §3.3); both also authorise every call themselves.',
    );
    for (const parameter of prefixParameters) {
      acknowledgeGranularFinding(
        this.role,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, parameter)}]`,
        "tenant-identity's or a slice's published parameters, read-only (spec §3.3).",
      );
    }
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, this.bucket.arnForObjects('*'))}]`,
      'The objects of the results bucket only (spec §3.1).',
    );

    new CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new CfnOutput(this, 'ResultsBucketName', { value: this.bucket.bucketName });
  }
}
