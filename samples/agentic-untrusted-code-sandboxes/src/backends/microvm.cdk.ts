// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CDK side of the `microvm` backend (spec §3.3 to §3.7, §5.3, ADR-0040 to ADR-0044): the MicroVM image
 * (L1: the CDK has no L2), the VPC egress connector into the dead-end sandbox subnets, the image build
 * role, the connector operator role and the policy statements for the tool, reaper and drain roles.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, ArnFormat, FileSystem, Stack, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Construct, type IConstruct } from 'constructs';
import type { BackendConstruct, BackendContext, SandboxEndpoint } from '../backend-construct';
import { BACKEND_ENV } from '../env';
import { RUNNER_PORTS } from '../protocol';

/**
 * Version of the platform base image `al2023-1` the image builds on (spec §3.5). `3` is the input the spike
 * stack deployed (S-1, S-4); the platform resolved it to 3.1. It pins the major version, not the minor one:
 * `3.1` as an input is untested, so the pin stays at what ran. A change goes with a passing integration run.
 */
export const MICROVM_BASE_IMAGE_VERSION = '3';

/** MicroVM sizes the spikes measured (S-15: 1024 gives 3998 MiB and 2 vCPUs, 2048 gives 8016 MiB and 4). */
const MEASURED_MEMORY_MIB: readonly number[] = [1024, 2048];

const HOOK_RUN_TIMEOUT_SECONDS = 10;
const HOOK_RESUME_TIMEOUT_SECONDS = 10;
const HOOK_SUSPEND_TIMEOUT_SECONDS = 10;
const HOOK_READY_TIMEOUT_SECONDS = 120;

/** Temporary artifact directories, removed once when the process exits. */
const stagedDirs: string[] = [];
process.once('exit', () => {
  for (const dir of stagedDirs) fs.rmSync(dir, { recursive: true, force: true });
});

export class MicrovmBackendResources extends Construct implements BackendConstruct {
  public readonly name = 'microvm' as const;
  public readonly image: lambda.CfnMicrovmImage;
  public readonly connector: lambda.CfnNetworkConnector;
  public readonly connectorSecurityGroup: ec2.SecurityGroup;
  public readonly buildRole: iam.Role;
  public readonly operatorRole: iam.Role;
  public readonly artifact: s3assets.Asset;
  private readonly imageName: string;
  private readonly connectorName: string;

  public constructor(scope: Construct, id: string, public readonly ctx: BackendContext) {
    super(scope, id);
    const stack = Stack.of(this);
    this.imageName = ctx.nameFor('microvm-image', 'image');
    this.connectorName = ctx.nameFor('network-connector', 'connector');
    const memoryMiB = ctx.settings.microvmMemoryMiB;
    if (!MEASURED_MEMORY_MIB.includes(memoryMiB)) {
      Annotations.of(this).addWarningV2(
        'microvm-memory-not-measured',
        `microvm.memoryMiB ${memoryMiB} was not measured; the spikes ran 1024 and 2048 (spec §3.3, S-15). The runner sizes its memory limits from what the guest reports, but the quota (L-CD1C0CC4) is charged ${memoryMiB} MiB per tenant.`,
      );
    }

    // Connector: no ingress, no egress at all, in the dead-end sandbox subnets (spec §3.7).
    this.connectorSecurityGroup = new ec2.SecurityGroup(this, 'ConnectorSecurityGroup', {
      vpc: ctx.vpc,
      description: 'microvm egress connector: no ingress, no egress (spec 3.7)',
      allowAllOutbound: false,
    });
    const sandboxSubnets = ctx.vpc.selectSubnets(ctx.sandboxSubnets);
    this.operatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lets Lambda manage the network interfaces of the microvm egress connector',
    });
    this.operatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CreateConnectorInterfaces',
      actions: ['ec2:CreateNetworkInterface'],
      resources: [
        stack.formatArn({ service: 'ec2', resource: 'network-interface', resourceName: '*' }),
        ...sandboxSubnets.subnetIds.map((subnetId) => stack.formatArn({ service: 'ec2', resource: 'subnet', resourceName: subnetId })),
        stack.formatArn({ service: 'ec2', resource: 'security-group', resourceName: this.connectorSecurityGroup.securityGroupId }),
      ],
    }));
    this.operatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TagConnectorInterfaces',
      actions: ['ec2:CreateTags'],
      resources: [stack.formatArn({ service: 'ec2', resource: 'network-interface', resourceName: '*' })],
      // Only interfaces the connector service manages: the condition the spike's operator role ran with (S-1).
      conditions: { StringEquals: { 'ec2:ManagedResourceOperator': 'network-connectors.lambda.amazonaws.com' } },
    }));
    Validations.of(this.operatorRole).acknowledge({
      id: 'AwsSolutions::AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ec2:<AWS::Region>:<AWS::AccountId>:network-interface/*]',
      reason: 'EC2 authorizes CreateNetworkInterface on the new interface, whose id is not known before the call, so its ARN is a wildcard; the subnets and the security group are named. CreateTags is limited to interfaces the connector service manages (ec2:ManagedResourceOperator).',
    });

    this.connector = new lambda.CfnNetworkConnector(this, 'Connector', {
      name: this.connectorName,
      operatorRole: this.operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          networkProtocol: 'IPv4',
          securityGroupIds: [this.connectorSecurityGroup.securityGroupId],
          subnetIds: sandboxSubnets.subnetIds,
        },
      },
    });
    // The role's policy must exist before the service assumes the role.
    this.connector.node.addDependency(this.operatorRole);

    // Image: build role, code artifact, the image itself.
    const buildLogGroup = this.buildLogGroupName();
    this.artifact = this.stageArtifact();
    this.buildRole = new iam.Role(this, 'ImageBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lets Lambda read the runner artifact and write the image build log',
    });
    this.buildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadRunnerArtifact',
      actions: ['s3:GetObject'],
      resources: [this.artifact.bucket.arnForObjects(this.artifact.s3ObjectKey)],
    }));
    const logGroupArn = stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: buildLogGroup, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    this.buildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteImageBuildLog',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroupArn, `${logGroupArn}:*`],
    }));
    Validations.of(this.buildRole).acknowledge({
      id: `AwsSolutions::AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${buildLogGroup}:*]`,
      reason: 'The wildcard covers the log streams of the one build log group the service creates; the artifact read names one object.',
    });

    this.image = new lambda.CfnMicrovmImage(this, 'Image', {
      name: this.imageName,
      description: 'Runner for the untrusted-code sandboxes sample (spec 3.5)',
      baseImageArn: stack.formatArn({
        service: 'lambda', account: 'aws', resource: 'microvm-image', resourceName: 'al2023-1', arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
      baseImageVersion: MICROVM_BASE_IMAGE_VERSION,
      buildRoleArn: this.buildRole.roleArn,
      codeArtifact: { uri: this.artifact.s3ObjectUrl },
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      resources: [{ minimumMemoryInMiB: memoryMiB }],
      // The build pulls the base layer and packages with the Lambda-managed internet egress (spec §3.5). Runtime egress is the VPC connector only.
      egressNetworkConnectors: [this.managedConnectorArn('INTERNET_EGRESS')],
      // None: a MicroVM has no way to add a capability (ADR-0019); the runner needs no more than root.
      additionalOsCapabilities: [],
      environmentVariables: [],
      hooks: {
        port: RUNNER_PORTS.hooks,
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: HOOK_READY_TIMEOUT_SECONDS },
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: HOOK_RUN_TIMEOUT_SECONDS,
          resume: 'ENABLED',
          resumeTimeoutInSeconds: HOOK_RESUME_TIMEOUT_SECONDS,
          suspend: 'ENABLED',
          suspendTimeoutInSeconds: HOOK_SUSPEND_TIMEOUT_SECONDS,
        },
      },
      logging: { cloudWatch: { logGroup: buildLogGroup } },
    });
    this.image.node.addDependency(this.buildRole);
  }

  /** The platform-managed connectors, `aws-network-connector:<NAME>` under the account `aws`. */
  private managedConnectorArn(name: 'HTTP_INGRESS' | 'INTERNET_EGRESS'): string {
    return Stack.of(this).formatArn({
      service: 'lambda',
      account: 'aws',
      resource: 'network-connector',
      resourceName: `aws-network-connector:${name}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
  }

  /** The log group the image build writes to; the service creates it, the log cleanup resource deletes it (spec §5.3). */
  private buildLogGroupName(): string {
    return `/aws/lambda-microvms/${this.imageName}`;
  }

  /**
   * Stage the code artifact: `runner/microvm/Dockerfile` at the root and the runner sources under
   * `runner/`, as the Dockerfile's `COPY runner/...` lines expect (ADR-0024). No Docker is needed;
   * the platform builds it. Tests, bytecode, the generator and the container Dockerfile stay out.
   */
  private stageArtifact(): s3assets.Asset {
    const runnerDir = this.ctx.runnerDir;
    // The artifact is staged in a temporary directory that goes when the process exits; with asset staging disabled the asset would point at it.
    if (this.node.tryGetContext(cxapi.DISABLE_ASSET_STAGING_CONTEXT)) {
      throw new Error('microvm backend: the runner artifact is staged in a temporary directory, so asset staging must stay on; do not use --no-staging');
    }
    const stage = FileSystem.mkdtemp('microvm-artifact-');
    stagedDirs.push(stage);
    fs.cpSync(runnerDir, path.join(stage, 'runner'), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(runnerDir, src);
        const parts = rel.split(path.sep);
        return !(['tests', 'microvm'].includes(parts[0]) || parts.includes('__pycache__')
          || rel === 'Dockerfile'
          || rel === path.join('protocol', 'make_vectors.py')
          || src.endsWith('.pyc'));
      },
    });
    fs.copyFileSync(path.join(runnerDir, 'microvm', 'Dockerfile'), path.join(stage, 'Dockerfile'));
    return new s3assets.Asset(this, 'Artifact', { path: stage });
  }

  /**
   * Every MicroVM action authorizes against the image ARN; there is no MicroVM ARN and no tenant key
   * (S-3), so these grants are the image's and the tenant filter is code (ADR-0040). The connector
   * grant is the second layer of ADR-0041: a start that omits the connector would get the
   * Lambda-managed internet egress, and that connector is not passable.
   */
  public toolStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: 'MicrovmRunCallAndStop',
        actions: ['lambda:RunMicrovm', 'lambda:GetMicrovm', 'lambda:TerminateMicrovm', 'lambda:CreateMicrovmAuthToken'],
        resources: [this.image.attrImageArn],
      }),
      new iam.PolicyStatement({
        sid: 'MicrovmPassOnlyTheSampleConnectors',
        actions: ['lambda:PassNetworkConnector'],
        resources: [this.managedConnectorArn('HTTP_INGRESS'), this.connector.attrArn],
      }),
    ];
  }

  public tenantStatements(): iam.PolicyStatement[] {
    return [];
  }

  /** The reaper and the offboard function list, read and end MicroVMs; they never start or call one. */
  public reaperStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: 'MicrovmList',
        actions: ['lambda:ListMicrovms'],
        resources: ['*'], // The action takes no resource; the backend filters by image.
      }),
      new iam.PolicyStatement({
        sid: 'MicrovmReadAndStop',
        actions: ['lambda:GetMicrovm', 'lambda:TerminateMicrovm'],
        resources: [this.image.attrImageArn],
      }),
    ];
  }

  /** The drain holds the reaper's grants; it needs nothing more on `microvm`. */
  public drainStatements(): iam.PolicyStatement[] {
    return [];
  }

  /** The connector's security group has no egress, so no endpoint serves it (spec §3.7). */
  public endpoints(): SandboxEndpoint[] {
    return [];
  }

  public endpointClients(): ec2.ISecurityGroup[] {
    return [];
  }

  public environment(): Record<string, string> {
    return {
      [BACKEND_ENV.MICROVM_IMAGE_ARN]: this.image.attrImageArn,
      [BACKEND_ENV.MICROVM_NETWORK_CONNECTOR_ARN]: this.connector.attrArn,
    };
  }

  /** An image cannot be deleted while a MicroVM of it is live, and a connector should not be deleted under one (S-1, spec §5.3). */
  public drainOrder(): IConstruct[] {
    return [this.image, this.connector];
  }

  public logCleanup(): { prefixes: string[]; names: string[] } {
    return { prefixes: [], names: [this.buildLogGroupName()] };
  }

  public outputs(): Record<string, string> {
    return { imageArn: this.image.attrImageArn };
  }
}

export function createMicrovmBackend(scope: Construct, id: string, ctx: BackendContext): BackendConstruct {
  return new MicrovmBackendResources(scope, id, ctx);
}
