// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `UntrustedCodeSandboxes`, the core construct (spec §3.3, ADR-0017).
 *
 * Scaffold shell (ADR-0025): it validates the props, builds the shared
 * network, bucket and runner repository far enough to hand each enabled
 * backend a `BackendContext`, and calls each backend's factory. The core
 * worker fills the registry, roles, functions, endpoints, drain and
 * observability here; backend workers fill only src/backends/<name>.cdk.ts.
 */

import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { BackendName } from './backend';
import type { BackendConstruct, BackendContext, BackendFactory, NameFor } from './backend-construct';
import { createAgentcoreBackend } from './backends/agentcore.cdk';
import { createMicrovmBackend } from './backends/microvm.cdk';
import { createNitroBackend } from './backends/nitro.cdk';
import { runnerPath } from './handler-entry';
import { resolveProps, type ResolvedProps, type UntrustedCodeSandboxesProps } from './props';

const FACTORIES: Readonly<Record<BackendName, BackendFactory>> = {
  microvm: createMicrovmBackend,
  nitro: createNitroBackend,
  agentcore: createAgentcoreBackend,
};

/** Subnet group names the construct creates and a supplied VPC must carry (spec §3.7). */
export const SUBNET_GROUPS = { public: 'Public', tool: 'Tool', sandbox: 'Sandbox' } as const;

export class UntrustedCodeSandboxes extends Construct {
  public readonly config: ResolvedProps;
  public readonly vpc: ec2.IVpc;
  public readonly inputBucket: s3.IBucket;
  /** The construct-owned runner repository (ADR-0024); set when `nitro` or `agentcore` is enabled. */
  public readonly runnerRepository?: ecr.IRepository;
  /** The enabled backends' CDK sides, by name. */
  public readonly backends: Readonly<Partial<Record<BackendName, BackendConstruct>>>;
  /** Functions bound with `bindRunCode`; the gateway entry adds one. */
  private readonly bound: lambda.IFunction[] = [];

  public constructor(scope: Construct, id: string, props: UntrustedCodeSandboxesProps = {}) {
    super(scope, id);
    this.config = resolveProps(props);

    this.vpc = props.vpc ?? new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: SUBNET_GROUPS.public, subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: SUBNET_GROUPS.tool, subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: SUBNET_GROUPS.sandbox, subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(new logs.LogGroup(this, 'FlowLogs', {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
          })),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });
    const toolSecurityGroup = new ec2.SecurityGroup(this, 'ToolSecurityGroup', {
      vpc: this.vpc,
      description: 'run_code tool, reaper, drain and offboard functions (spec 3.7)',
      allowAllOutbound: true,
    });

    this.inputBucket = props.inputBucket ?? new s3.Bucket(this, 'InputBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    if (!props.inputBucket) {
      Validations.of(this.inputBucket).acknowledge({
        id: 'AwsSolutions::AwsSolutions-S1',
        reason: 'The tool reads inputs with the tool tenant role and writes one structured line per call with tenantId, runId and input size (spec 3.8, ADR-0013); that line is the access record. A vendor who needs object-level records adds S3 data events.',
      });
    }

    const containers = this.config.backends.some((b) => b === 'nitro' || b === 'agentcore');
    if (containers) {
      this.runnerRepository = new ecr.Repository(this, 'RunnerRepository', {
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      });
    }

    const nameFor: NameFor = (service) => {
      // shortcut: the per-service sanitiser of spec §5.3 is the core worker's; the stubs never call it.
      throw new Error(`UntrustedCodeSandboxes: nameFor(${service}) is not built yet`);
    };
    const ctx: BackendContext = {
      vpc: this.vpc,
      sandboxSubnets: { subnetGroupName: SUBNET_GROUPS.sandbox },
      toolSubnets: { subnetGroupName: SUBNET_GROUPS.tool },
      toolSecurityGroup,
      inputBucket: this.inputBucket,
      runnerRepository: this.runnerRepository,
      runnerDir: runnerPath(),
      nameFor,
      settings: this.config.settings,
    };
    const backends: Partial<Record<BackendName, BackendConstruct>> = {};
    for (const name of this.config.backends) {
      backends[name] = FACTORIES[name](this, `Backend-${name}`, ctx);
    }
    this.backends = backends;

    this.node.addValidation({
      validate: () => (this.config.standalone || this.bound.length > 0
        ? []
        : ['UntrustedCodeSandboxes has no entry: set standalone: true or bind a RunCodeToolTarget (ADR-0017)']),
    });
  }

  /**
   * Give a function everything the core run function has (spec §3.3). The
   * scaffold only records it; the core worker adds subnets, environment,
   * timeout, trust, actions, log group and Contributor Insights.
   */
  public bindRunCode(fn: lambda.IFunction): void {
    this.bound.push(fn);
  }
}
