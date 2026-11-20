// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CDK side of the `nitro` backend (spec §3.3, §3.4, §3.6, §3.7, §5.3, ADR-0004,
 * ADR-0014, ADR-0045 to ADR-0049): an ECS cluster on a Managed Instances
 * capacity provider, a task definition that asks for an `ISOLATED_SANDBOX`
 * Nitro Sandbox per task, the roles and security groups around it, and the
 * statements the core's roles hold for it.
 *
 * Nothing here starts a task. The tool starts and stops them at run time with
 * the tool tenant role (src/backends/nitro.ts).
 */

import { RemovalPolicy, Size, Stack, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct, type IConstruct } from 'constructs';
import type { BackendConstruct, BackendContext, SandboxEndpoint } from '../backend-construct';
import { NITRO_ENV, RUNNER_CONTAINER_NAME, TENANT_TAG } from './nitro';
import { checkInstanceTypes } from './nitro-instance-types';
import { acknowledge } from '../core/nag';
import { RUNNER_PORTS } from '../protocol';

/**
 * `ScaleInAfter` of the capacity provider, in seconds (S-7, S-16): instances
 * go about two minutes after the last task. The capacity provider has no
 * minimum-instances setting, so the sample keeps no warm instance (ADR-0020).
 */
export const SCALE_IN_AFTER_SECONDS = 120;

/** The tag value every condition compares the request or resource tag with (ADR-0014). */
const PRINCIPAL_TENANT = `\${aws:PrincipalTag/${TENANT_TAG}}`;

export class NitroBackendResources extends Construct implements BackendConstruct {
  public readonly name = 'nitro' as const;

  public readonly cluster: ecs.Cluster;
  public readonly capacityProvider: ecs.ManagedInstancesCapacityProvider;
  /** L1, because the isolation mode is in neither the L1 nor the L2 types at the pin (ADR-0023). */
  public readonly taskDefinition: ecs.CfnTaskDefinition;
  public readonly executionRole: iam.Role;
  public readonly taskLogGroup: logs.LogGroup;
  /** The task log group's literal name, known at synth; the core's log cleanup and the Logs endpoint policy use it. */
  public readonly logGroupName: string;
  public readonly taskSecurityGroup: ec2.SecurityGroup;
  public readonly instanceSecurityGroup: ec2.SecurityGroup;
  /** `arm64` or `x86_64`, the architecture of every instance type and of the runner image. */
  public readonly architecture: 'x86_64' | 'arm64';

  private readonly taskArn: string;
  private readonly containerInstanceArn: string;

  public constructor(scope: Construct, id: string, public readonly ctx: BackendContext) {
    super(scope, id);
    const { settings, vpc } = ctx;
    const stack = Stack.of(this);

    try {
      this.architecture = checkInstanceTypes(settings.nitroInstanceTypes);
    } catch (err) {
      throw new Error(`UntrustedCodeSandboxes: ${(err as Error).message}`);
    }
    if (ctx.runnerRepository === undefined || ctx.runnerImageTag === undefined) {
      throw new Error('UntrustedCodeSandboxes: the nitro backend needs the runner repository and its image tag from the core (ADR-0024)');
    }
    const repository = ctx.runnerRepository;
    const imageTag = ctx.runnerImageTag(this.architecture === 'arm64' ? 'arm64' : 'amd64');

    // ---- security groups (spec §3.7) -------------------------------------------------------------
    this.instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'ECS Managed Instances of the nitro backend (spec 3.7)',
      allowAllOutbound: false,
    });
    this.instanceSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ECS, ECR and Logs through the NAT and the endpoints');

    // Egress stays closed. The core's Logs endpoint group admits this group through
    // `endpointClients()`, which adds the egress rule to the Logs endpoint group only.
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      description: 'nitro task ENIs (spec 3.7): 8443 from the tool, egress to the Logs endpoint only',
      allowAllOutbound: false,
    });
    this.taskSecurityGroup.connections.allowFrom(ctx.toolSecurityGroup, ec2.Port.tcp(RUNNER_PORTS.tls), 'the tool: /hello and /run');

    // ---- logs (spec §5.3) ----------------------------------------------------------------------------
    // The task execution role cannot create log groups, so a deleted group is not recreated by late
    // lines; the core's log cleanup resource still removes it by name after the cluster (logCleanup()).
    this.logGroupName = ctx.nameFor('log-group', 'nitro-task');
    this.taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: this.logGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- cluster and capacity provider (spec §3.4, §5.3) -----------------------------------------
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: ctx.nameFor('ecs-cluster', 'nitro'),
    });
    this.capacityProvider = new ecs.ManagedInstancesCapacityProvider(this, 'CapacityProvider', {
      capacityProviderName: ctx.nameFor('ecs-capacity-provider', 'nitro'),
      // The instances' primary ENIs sit in the tool subnets, routed through the NAT (spec §3.7);
      // the task ENIs go to the sandbox subnets at RunTask.
      subnets: vpc.selectSubnets(ctx.toolSubnets).subnets,
      securityGroups: [this.instanceSecurityGroup],
      instanceRequirements: {
        allowedInstanceTypes: [...settings.nitroInstanceTypes],
        vCpuCountMin: 1,
        memoryMin: Size.mebibytes(settings.nitroMemoryMiB),
      },
    });
    this.cluster.addManagedInstancesCapacityProvider(this.capacityProvider);
    this.cluster.addDefaultCapacityProviderStrategy([{ capacityProvider: this.capacityProvider.capacityProviderName, weight: 1 }]);
    const cfnProvider = this.capacityProvider.node.findAll().find((c): c is ecs.CfnCapacityProvider => c instanceof ecs.CfnCapacityProvider);
    if (cfnProvider === undefined) throw new Error('nitro: the capacity provider has no L1 resource to configure');
    cfnProvider.addPropertyOverride('ManagedInstancesProvider.InfrastructureOptimization.ScaleInAfter', SCALE_IN_AFTER_SECONDS);

    // ---- task execution role (spec §3.6) -----------------------------------------------------------
    this.executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls the runner image and writes the task log group; never reachable by sandboxed code (S-5)',
    });
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrAuthorization',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PullRunnerImage',
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resources: [repository.repositoryArn],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteTaskLogs',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.taskLogGroup.logGroupArn],
    }));
    acknowledge(
      this.executionRole,
      'AwsSolutions-IAM5',
      'ecr:GetAuthorizationToken takes no resource, and the log group ARN ends in :* because streams are named at run time. ECR pull and Logs write are scoped to the runner repository and the task log group (spec 3.6).',
    );

    // ---- task definition (spec §3.4, ADR-0023) ------------------------------------------------------
    this.taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDefinition', {
      cpu: String(settings.nitroCpu),
      memory: String(settings.nitroMemoryMiB),
      networkMode: 'awsvpc',
      requiresCompatibilities: ['MANAGED_INSTANCES'],
      executionRoleArn: this.executionRole.roleArn,
      // No taskRoleArn: sandboxed code holds no credentials (spec §3.4 "Code holds", C-2, S-5).
      runtimePlatform: {
        cpuArchitecture: this.architecture === 'arm64' ? 'ARM64' : 'X86_64',
        operatingSystemFamily: 'LINUX',
      },
      containerDefinitions: [{
        name: RUNNER_CONTAINER_NAME,
        image: repository.repositoryUriForTag(imageTag),
        essential: true,
        portMappings: [{ containerPort: RUNNER_PORTS.tls, protocol: 'tcp' }],
        // The runner serves three backends from one image and exits at start without this (ADR-0037).
        // The nonce hash is not here: it is set per start by the container override (ADR-0018).
        environment: [{ name: 'RUNNER_BACKEND', value: 'nitro' }],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': this.taskLogGroup.logGroupName,
            'awslogs-region': stack.region,
            'awslogs-stream-prefix': 'runner',
          },
        },
        // No added capabilities: the platform's task limit already holds the memory cap (spec §3.5).
      }],
    });
    // Neither the L1 nor the L2 types carry the isolation mode at the pin (ADR-0023).
    this.taskDefinition.addPropertyOverride('TrustedExecutionConfiguration', { IsolationMode: 'ISOLATED_SANDBOX' });
    acknowledge(
      this.taskDefinition,
      'AwsSolutions-ECS2',
      'RUNNER_BACKEND is a fixed, non-secret selector (the value nitro) that the runner needs at start (ADR-0037). The per-start nonce hash is not here: the tool sets it in the RunTask container override (ADR-0018).',
    );
    Validations.of(this.taskDefinition).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason: 'The CloudFormation schema that aws-cdk-lib 2.274.0 validates against predates TrustedExecutionConfiguration. The spikes deployed this property in raw CloudFormation (S-6, S-14, S-19, S-20); the synth test asserts it (ADR-0023, ADR-0046).',
    });

    this.taskArn = this.cluster.arnForTasks('*');
    this.containerInstanceArn = stack.formatArn({
      service: 'ecs',
      resource: 'container-instance',
      resourceName: `${this.cluster.clusterName}/*`,
    });
  }

  public toolStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({
      sid: 'DescribeNitroTasks',
      actions: ['ecs:DescribeTasks'],
      resources: [this.taskArn],
    })];
  }

  /**
   * `RunTask` and `StopTask` of the tool tenant role (ADR-0014). The tenant tag is enforced:
   * a task starts only with a `TenantId` tag equal to the caller's session tag, and stops
   * only when its tag equals it. `ecs:TagResource` is what ECS checks for the tags passed
   * to `RunTask`; the action has no `ecs:cluster` key.
   */
  public tenantStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: 'RunNitroTask',
        actions: ['ecs:RunTask'],
        resources: [this.taskDefinition.ref],
        conditions: {
          ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
          StringEquals: { [`aws:RequestTag/${TENANT_TAG}`]: PRINCIPAL_TENANT },
        },
      }),
      new iam.PolicyStatement({
        sid: 'TagNitroTaskAtRunTask',
        actions: ['ecs:TagResource'],
        resources: [this.taskArn],
        conditions: {
          StringEquals: {
            [`aws:RequestTag/${TENANT_TAG}`]: PRINCIPAL_TENANT,
            'ecs:CreateAction': 'RunTask',
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'StopOwnNitroTask',
        actions: ['ecs:StopTask'],
        resources: [this.taskArn],
        conditions: {
          ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
          StringEquals: { [`aws:ResourceTag/${TENANT_TAG}`]: PRINCIPAL_TENANT },
        },
      }),
      new iam.PolicyStatement({
        sid: 'PassNitroExecutionRole',
        actions: ['iam:PassRole'],
        resources: [this.executionRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    ];
  }

  /** The reaper lists, describes and stops any task of the cluster (spec §3.6); it holds no instance action. */
  public reaperStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: 'ListNitroTasks',
        actions: ['ecs:ListTasks'],
        // ListTasks authorises on a container-instance or on no resource; the cluster key scopes it.
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
      }),
      new iam.PolicyStatement({
        sid: 'DescribeAndStopNitroTasks',
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: [this.taskArn],
      }),
    ];
  }

  /** On top of the reaper's: the instance drain of spec §5.3, which the reaper and offboard roles must not hold. */
  public drainStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: 'DrainNitroInstances',
        actions: ['ecs:ListContainerInstances', 'ecs:DeregisterContainerInstance'],
        resources: [this.cluster.clusterArn],
      }),
      new iam.PolicyStatement({
        sid: 'DescribeNitroInstances',
        actions: ['ecs:DescribeContainerInstances'],
        resources: [this.containerInstanceArn],
      }),
      new iam.PolicyStatement({
        sid: 'WaitForInstanceTermination',
        actions: ['ec2:DescribeInstances'],
        // The action takes no resource.
        resources: ['*'],
      }),
    ];
  }

  public endpoints(): SandboxEndpoint[] {
    return ['logs'];
  }

  /** The Logs endpoint admits writes to the task log group only (spec §3.7 "Policy allows"). */
  public endpointStatements(endpoint: SandboxEndpoint): iam.PolicyStatement[] {
    if (endpoint !== 'logs') return [];
    return [new iam.PolicyStatement({
      sid: 'LogsNitroTaskGroup',
      principals: [new iam.AnyPrincipal()],
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.taskLogGroup.logGroupArn],
    })];
  }

  public endpointClients(): ec2.ISecurityGroup[] {
    return [this.taskSecurityGroup, this.instanceSecurityGroup];
  }

  public environment(): Record<string, string> {
    return {
      [NITRO_ENV.CLUSTER_ARN]: this.cluster.clusterArn,
      [NITRO_ENV.TASK_DEFINITION_ARN]: this.taskDefinition.ref,
      [NITRO_ENV.CONTAINER_NAME]: RUNNER_CONTAINER_NAME,
      [NITRO_ENV.SUBNET_IDS]: this.ctx.vpc.selectSubnets(this.ctx.sandboxSubnets).subnetIds.join(','),
      [NITRO_ENV.SECURITY_GROUP_ID]: this.taskSecurityGroup.securityGroupId,
    };
  }

  /**
   * What the drain must outlive (spec §5.3): the cluster and capacity provider cannot be deleted
   * while a task or an instance runs, and the security groups cannot be deleted while a task ENI
   * holds them.
   */
  public drainOrder(): IConstruct[] {
    return [this.cluster, this.capacityProvider, this.taskDefinition, this.taskSecurityGroup, this.instanceSecurityGroup];
  }

  public logCleanup(): { prefixes: string[]; names: string[] } {
    return { prefixes: [], names: [this.logGroupName] };
  }

  public outputs(): Record<string, string> {
    return { clusterArn: this.cluster.clusterArn, taskDefinitionArn: this.taskDefinition.ref };
  }
}

export function createNitroBackend(scope: Construct, id: string, ctx: BackendContext): BackendConstruct {
  return new NitroBackendResources(scope, id, ctx);
}
