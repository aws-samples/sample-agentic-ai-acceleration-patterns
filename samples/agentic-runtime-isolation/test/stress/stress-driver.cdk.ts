// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The StressDriver stack (stress-test plan §8.1, §8.3 row 3): the k6 host.
 * One AZ, one NAT gateway in a public subnet, the host in a private subnet
 * with no public IP and no inbound rule, reached through SSM Session Manager.
 * Every call leaves through the NAT gateway to the public AWS endpoints, as a
 * tenant's client would; the only VPC endpoint is the free S3 gateway one.
 * The k6 summaries go to a results bucket before the host is destroyed.
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { StressTier } from './tiers';
import { acknowledgeGranularFinding, nagFindingResource } from '../../src/shared/nag';

/** Where the host installs the scripts and writes its output. */
export const STRESS_HOME = '/opt/stress';

export interface StressDriverStackProps extends StackProps {
  readonly tier: StressTier;
  /** The stress ingress stack's registry prefix (§8.3); the host may read the parameters under it. */
  readonly registryPrefix: string;
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
      reason: 'Stress-test driver VPC, destroyed after each run: no flow log, for cost (stress-test plan §8.1). Nothing listens in it; the host has no inbound rule.',
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
      description: 'Stress driver host: SSM Session Manager, execute-api:Invoke, the identity and stress registry parameters, the results bucket',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const invokeResource = `arn:${this.partition}:execute-api:${this.region}:${this.account}:*/*/*/*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeApis',
        actions: ['execute-api:Invoke'],
        resources: [invokeResource],
      }),
    );
    const parameterArn = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;
    const identityParameters = parameterArn('/application-plane/shared/identity/*');
    const registryParameters = parameterArn(`${props.registryPrefix}*`);
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadIdentityAndRegistryParameters',
        actions: ['ssm:GetParameter'],
        resources: [identityParameters, registryParameters],
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
      instanceType: new ec2.InstanceType(props.tier.driverInstanceType),
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
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]',
      'AmazonSSMManagedInstanceCore is the managed policy Session Manager needs; the host has no key pair and no inbound rule (stress-test plan §8.1).',
    );
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, invokeResource)}]`,
      'The Entitlements API and the platform API have ids this stack does not know (stress-test plan §8.3); both also authorise every call themselves.',
    );
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, identityParameters)}]`,
      "tenant-identity's published parameters, read-only (stress-test plan §8.3).",
    );
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, registryParameters)}]`,
      "The stress ingress stack's published parameters, read-only (stress-test plan §8.3).",
    );
    acknowledgeGranularFinding(
      this.role,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, this.bucket.arnForObjects('*'))}]`,
      'The objects of the results bucket only (stress-test plan §8.1).',
    );

    new CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new CfnOutput(this, 'ResultsBucketName', { value: this.bucket.bucketName });
  }
}
