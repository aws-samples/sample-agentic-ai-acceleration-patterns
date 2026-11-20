// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CDK side of the `agentcore` backend (spec §3.3, §3.4, §3.6, §3.7, §5.3):
 * one AgentCore Runtime V2 container runtime in VPC mode, in the dead-end
 * sandbox subnets, with a logs-only role and its own security group, plus
 * the usage-log delivery that §3.8 joins to tenants. Decisions are in
 * ADR-0050 to ADR-0054.
 */

import { Aws, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Construct, type IConstruct } from 'constructs';
import type { BackendConstruct, BackendContext, SandboxEndpoint } from '../backend-construct';
import { AGENTCORE_RUNTIME_ARN_ENV } from './agentcore';

/** Prefix of every log group AgentCore creates for a runtime (spec §5.3). */
export const RUNTIME_LOG_PREFIX = '/aws/bedrock-agentcore/runtimes/';

/** Statement ids: stable, so a synth test and a reviewer find each grant by name. */
export const SID = {
  toolInvoke: 'InvokeAndStopRuntimeSessions',
  reaperStop: 'StopRuntimeSessions',
  roleEcrToken: 'EcrAuthorizationToken',
  roleEcrPull: 'EcrPullRunnerImage',
  roleLogs: 'LogsOfThisRuntime',
  roleLogStreams: 'LogStreamsOfThisRuntime',
  roleSessionObjects: 'SessionFilesOwnPrefix',
  roleSessionList: 'SessionFilesList',
} as const;

export class AgentcoreBackendResources extends Construct implements BackendConstruct {
  public readonly name = 'agentcore' as const;
  /** Runtime name, known at synth: `[a-zA-Z][a-zA-Z0-9_]{0,47}`, so it holds no `-` (spec §5.3). */
  public readonly runtimeName: string;
  public readonly runtime: bedrockagentcore.Runtime;
  /** The runtime role the code in a session holds (spec §3.6). */
  public readonly runtimeRole: iam.Role;
  public readonly securityGroup: ec2.SecurityGroup;
  /** Owned by the construct: deleted with the stack (spec §3.8, §5.3). */
  public readonly usageLogGroup: logs.LogGroup;
  /** Tag of the runner image in the runner repository. */
  public readonly imageTag: string;

  public constructor(scope: Construct, id: string, public readonly ctx: BackendContext) {
    super(scope, id);
    const stack = Stack.of(this);
    const repository = ctx.runnerRepository;
    if (!repository) {
      throw new Error('agentcore backend: the core did not create the runner repository (ADR-0024)');
    }
    const { settings } = ctx;
    this.runtimeName = ctx.nameFor('agentcore-runtime', 'agentcore');

    // Image: the runner repository holds an arm64 copy under runner-arm64-<hash> (ADR-0024).
    // The core may do the copy for every container backend (ctx.runnerImageTag); otherwise this backend does.
    let copy: ECRDeployment | undefined;
    if (ctx.runnerImageTag) {
      this.imageTag = ctx.runnerImageTag('arm64');
    } else {
      const asset = new ecrAssets.DockerImageAsset(this, 'RunnerImage', {
        directory: ctx.runnerDir,
        platform: ecrAssets.Platform.LINUX_ARM64,
      });
      this.imageTag = `runner-arm64-${asset.assetHash}`;
      copy = new ECRDeployment(this, 'RunnerImageCopy', {
        src: new DockerImageName(asset.imageUri),
        dest: new DockerImageName(`${repository.repositoryUri}:${this.imageTag}`),
        imageArch: ['arm64'],
      });
    }

    // Security group: no ingress and no egress of its own. The core adds the egress for each endpoint this
    // backend asks for in endpoints(), and the ingress on the endpoints' groups for endpointClients() (ADR-0051).
    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: ctx.vpc,
      description: 'agentcore runtime in the sandbox subnets: no ingress, egress only to the sandbox endpoints (spec 3.7)',
      allowAllOutbound: false,
    });

    // Role: logs and the runner image, nothing else (spec §3.6).
    this.runtimeRole = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'bedrock-agentcore', resource: 'runtime', resourceName: `${this.runtimeName}-*` }) },
        },
      }),
      description: 'AgentCore runtime role: runner image pull and own logs (spec 3.6)',
    });
    for (const statement of this.roleStatements(repository.repositoryArn)) {
      this.runtimeRole.addToPolicy(statement);
    }

    // The L2 adds log, X-Ray, metric and identity grants to any role it is given (ADR-0050).
    // An immutable reference takes none of them, so the role stays as written above.
    const roleRef = iam.Role.fromRoleArn(this, 'RuntimeRoleRef', this.runtimeRole.roleArn, { mutable: false });

    this.runtime = new bedrockagentcore.Runtime(this, 'Runtime', {
      runtimeName: this.runtimeName,
      agentRuntimeArtifact: bedrockagentcore.AgentRuntimeArtifact.fromImageUri(repository.repositoryUriForTag(this.imageTag)),
      executionRole: roleRef,
      networkConfiguration: bedrockagentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc: ctx.vpc,
        vpcSubnets: ctx.sandboxSubnets,
        securityGroups: [this.securityGroup],
      }),
      protocolConfiguration: bedrockagentcore.ProtocolType.HTTP,
      platformVersion: bedrockagentcore.PlatformVersion.V2,
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: settings.sandboxIdle,
        maxLifetime: settings.sandboxMaxLife,
      },
    });
    this.runtime.node.addDependency(this.runtimeRole);
    if (copy) this.runtime.node.addDependency(copy);

    // Usage logs: the source of per-tenant AgentCore cost (spec §3.8). Built from the L1 resources so every
    // name comes from the sanitiser and the resource policy is this instance's own (the L2's is shared by id).
    this.usageLogGroup = new logs.LogGroup(this, 'UsageLogs', {
      logGroupName: ctx.nameFor('log-group', 'agentcore-usage'),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const deliveryPolicy = new logs.ResourcePolicy(this, 'UsageLogsPolicy', {
      resourcePolicyName: ctx.nameFor('logs-resource-policy', 'agentcore-usage'),
      policyStatements: [new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${this.usageLogGroup.logGroupArn}:log-stream:*`],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'logs', resource: '*' }) },
        },
      })],
    });
    const source = new logs.CfnDeliverySource(this, 'UsageDeliverySource', {
      name: ctx.nameFor('log-delivery', 'agentcore-usage-source'),
      logType: 'USAGE_LOGS',
      resourceArn: this.runtime.agentRuntimeArn,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'UsageDeliveryDestination', {
      name: ctx.nameFor('log-delivery', 'agentcore-usage-destination'),
      deliveryDestinationType: 'CWL',
      destinationResourceArn: this.usageLogGroup.logGroupArn,
    });
    destination.node.addDependency(deliveryPolicy);
    const delivery = new logs.CfnDelivery(this, 'UsageDelivery', {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
    });
    delivery.node.addDependency(source);
    delivery.node.addDependency(destination);
  }

  /** Log groups AgentCore makes for this runtime: `<prefix><runtimeName>-<id>-DEFAULT`. `-` cannot occur in a runtime name. */
  private runtimeLogGroupArn(): string {
    return `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${RUNTIME_LOG_PREFIX}${this.runtimeName}-*`;
  }

  private runtimeArns(): string[] {
    const arn = this.runtime.agentRuntimeArn;
    return [arn, `${arn}/runtime-endpoint/*`];
  }

  /** The runtime role's whole policy (spec §3.6 "AgentCore runtime role"). */
  private roleStatements(repositoryArn: string): iam.PolicyStatement[] {
    const statements = [
      new iam.PolicyStatement({ sid: SID.roleEcrToken, actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
      new iam.PolicyStatement({
        sid: SID.roleEcrPull,
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [repositoryArn],
      }),
      new iam.PolicyStatement({
        sid: SID.roleLogs,
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [this.runtimeLogGroupArn()],
      }),
      new iam.PolicyStatement({
        sid: SID.roleLogStreams,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${this.runtimeLogGroupArn()}:log-stream:*`],
      }),
    ];
    if (this.ctx.settings.agentcoreSessionFiles) {
      // ADR-0007: one prefix per session, chosen by the platform's session key, so no role per session.
      const own = 'sessions/${aws:AgentCoreRuntimeSourceSid}/*';
      statements.push(
        new iam.PolicyStatement({
          sid: SID.roleSessionObjects,
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [this.ctx.inputBucket.arnForObjects(own)],
        }),
        new iam.PolicyStatement({
          sid: SID.roleSessionList,
          actions: ['s3:ListBucket'],
          resources: [this.ctx.inputBucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': [own] } },
        }),
      );
    }
    return statements;
  }

  /**
   * The tool role may invoke and stop any session of the runtime. IAM has no session-id condition for either
   * action (S-8), so the tenant-to-session mapping is code: `sessionIdFor(tenantId)` in the run-time class,
   * which refuses a handle that names another session (ADR-0050). The endpoint-qualified ARN is listed too,
   * because both actions authorize against it as well as the runtime.
   */
  public toolStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({
      sid: SID.toolInvoke,
      actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
      resources: this.runtimeArns(),
    })];
  }

  /** None: the tenant role carries the `nitro` start and stop grants only (spec §3.6). */
  public tenantStatements(): iam.PolicyStatement[] {
    return [];
  }

  /** Stop sessions that have a row; `offboardTenant` runs as this role. Nothing lists sessions, so nothing lists them here. */
  public reaperStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({
      sid: SID.reaperStop,
      actions: ['bedrock-agentcore:StopRuntimeSession'],
      resources: this.runtimeArns(),
    })];
  }

  /** None on top of the reaper's: the drain stops sessions with `StopRuntimeSession` and holds no instance action here. */
  public drainStatements(): iam.PolicyStatement[] {
    return [];
  }

  public endpoints(): SandboxEndpoint[] {
    return ['s3-gateway', 'ecr-api', 'ecr-dkr', 'logs'];
  }

  public endpointClients(): ec2.ISecurityGroup[] {
    return [this.securityGroup];
  }

  public environment(): Record<string, string> {
    return { [AGENTCORE_RUNTIME_ARN_ENV]: this.runtime.agentRuntimeArn };
  }

  /** The runtime goes after the drain, which stops every session that has a row (spec §5.3). */
  public drainOrder(): IConstruct[] {
    return [this.runtime];
  }

  /** AgentCore creates these groups itself, after deploy, so the cleanup resource deletes them by prefix. */
  public logCleanup(): { prefixes: string[]; names: string[] } {
    return { prefixes: [`${RUNTIME_LOG_PREFIX}${this.runtimeName}-`], names: [] };
  }

  public outputs(): Record<string, string> {
    return { runtimeArn: this.runtime.agentRuntimeArn };
  }
}

export function createAgentcoreBackend(scope: Construct, id: string, ctx: BackendContext): BackendConstruct {
  return new AgentcoreBackendResources(scope, id, ctx);
}
