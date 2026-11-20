// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `UntrustedCodeSandboxes`, the core construct (spec §3.3, ADR-0017).
 *
 * It validates the props, builds the shared network, registry, bucket,
 * roles, functions, observability and teardown (spec §3.6 to §3.9, §4.1,
 * §5.3), and asks each enabled backend, through `BackendConstruct`, for
 * its own resources, statements, endpoints, environment and drain order.
 * It writes no backend-specific action itself (ADR-0025).
 */

import { ArnFormat, type CfnResource, CustomResource, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { BackendName } from './backend';
import type { BackendConstruct, BackendContext, BackendFactory } from './backend-construct';
import { createAgentcoreBackend } from './backends/agentcore.cdk';
import { createMicrovmBackend } from './backends/microvm.cdk';
import { createNitroBackend } from './backends/nitro.cdk';
import { DnsFirewall } from './core/dns-firewall';
import { SandboxEndpoints } from './core/endpoints';
import { LogCleanup } from './core/log-cleanup';
import { LogDrain } from './core/log-drain';
import { acknowledge, acknowledgeGranularFinding, acknowledgeKnownFindings, acknowledgeServiceTimeout, flatten, type KnownContext, nagFindingResource } from './core/nag';
import { InsightRules } from './core/observability';
import { RunnerImages, type RunnerArch } from './core/runner-image';
import { ENV, TENANT_KEY_PREFIX, TENANT_TAG, REGISTRY } from './env';
import { handlerEntry, HANDLERS, runnerPath } from './handler-entry';
import { makeNameFor } from './names';
import { resolveProps, type ResolvedProps, type UntrustedCodeSandboxesProps } from './props';

const FACTORIES: Readonly<Record<BackendName, BackendFactory>> = {
  microvm: createMicrovmBackend,
  nitro: createNitroBackend,
  agentcore: createAgentcoreBackend,
};

/** Subnet group names the construct creates and a supplied VPC must carry (spec §3.7, ADR-0027). */
export const SUBNET_GROUPS = { public: 'Public', tool: 'Tool', sandbox: 'Sandbox' } as const;

/** Tag the construct puts on the subnets it creates (spec §6.1). */
export const TIER_TAG = 'run-code:tier';

const TENANT_VARIABLE = `\${aws:PrincipalTag/${TENANT_TAG}}`;

/**
 * What a function in a VPC needs to manage its network interfaces. The managed policy of the same purpose also holds
 * log writes on every group, which no role here may have (spec 3.6), so the six actions are written out (ADR-0029).
 */
function vpcAccessStatement(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'VpcNetworkInterfaces',
    actions: [
      'ec2:CreateNetworkInterface',
      'ec2:DescribeNetworkInterfaces',
      'ec2:DescribeSubnets',
      'ec2:DeleteNetworkInterface',
      'ec2:AssignPrivateIpAddresses',
      'ec2:UnassignPrivateIpAddresses',
    ],
    // Lambda creates the interfaces with the function's role before any id exists; none of these takes a resource we can name.
    resources: ['*'],
  });
}

/** The log group that holds the stack's auto-delete provider logs, made by the first instance in the stack. */
const autoDeleteGroups = new WeakMap<Stack, logs.LogGroup>();

/** Registry actions: the tool tenant role writes its own rows; the reaper role reads, updates and deletes any row. */
const TENANT_ROW_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'];
const ALL_ROW_ACTIONS = ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'];

export class UntrustedCodeSandboxes extends Construct {
  public readonly config: ResolvedProps;
  public readonly vpc: ec2.IVpc;
  public readonly inputBucket: s3.IBucket;
  /** The construct-owned runner repository (ADR-0024); set when `nitro` or `agentcore` is enabled. */
  public readonly runnerRepository?: ecr.IRepository;
  /** The enabled backends' CDK sides, by name. */
  public readonly backends: Readonly<Partial<Record<BackendName, BackendConstruct>>>;
  /** Per backend values (image ARN, cluster ARN, runtime ARN), from each `BackendConstruct.outputs()`. */
  public readonly backendOutputs: Readonly<Record<string, string>>;
  public readonly registryTable: dynamodb.ITable;
  /** The role of `runCodeFunction`; a bound function holds the same statements on its own role (spec §3.6 "Tool role", ADR-0029). */
  public readonly toolRole: iam.IRole;
  /** The role the tool assumes with a `TenantId` session tag (spec §3.6 "Tool tenant role"). */
  public readonly toolTenantRole: iam.IRole;
  /**
   * Stops one tenant's sandboxes; runs as the reaper role, which holds no instance action (spec §5.2). Like the other
   * core functions it runs on an immutable role reference: a grant made through its own `role` does nothing.
   */
  public readonly offboardFunction: lambda.IFunction;
  /**
   * Only with `standalone: true` (ADR-0017). It runs on an immutable reference to `toolRole`, so a grant made through its
   * own `role` does nothing: add statements to `toolRole` instead.
   */
  public readonly runCodeFunction?: lambda.IFunction;
  /** The shared environment of every function the construct deploys. */
  public readonly environment: Readonly<Record<string, string>>;
  public readonly dnsFirewall?: DnsFirewall;

  private readonly bound: lambda.IFunction[] = [];
  private readonly toolSecurityGroup: ec2.ISecurityGroup;
  private readonly tenantRole: iam.Role;
  private readonly toolStatements: iam.PolicyStatement[];
  private readonly insights: InsightRules;
  private readonly logDrain: LogDrain;
  private readonly drainResource: CustomResource;
  private readonly toolSubnets: ec2.SubnetSelection;
  private nagContext: KnownContext;

  public constructor(scope: Construct, id: string, props: UntrustedCodeSandboxesProps = {}) {
    super(scope, id);
    this.config = resolveProps(props);
    const nameFor = makeNameFor(this.node.path);

    // --- Network (spec §3.7) ---
    const sandboxSubnets: ec2.SubnetSelection = { subnetGroupName: SUBNET_GROUPS.sandbox };
    this.toolSubnets = { subnetGroupName: SUBNET_GROUPS.tool };
    this.vpc = props.vpc ?? this.createVpc();
    for (const [what, selection] of [['tool', this.toolSubnets], ['sandbox', sandboxSubnets]] as const) {
      let found = 0;
      try {
        found = this.vpc.selectSubnets(selection).subnetIds.length;
      } catch {
        found = 0;
      }
      if (found === 0) {
        throw new Error(`UntrustedCodeSandboxes: the vpc has no ${what} subnets; name the subnet group ${selection.subnetGroupName} (ADR-0027)`);
      }
    }
    const toolSecurityGroup = new ec2.SecurityGroup(this, 'ToolSecurityGroup', {
      vpc: this.vpc,
      description: 'run_code tool, reaper, drain and offboard functions (spec 3.7)',
      allowAllOutbound: true,
    });
    this.toolSecurityGroup = toolSecurityGroup;

    // --- Input bucket and runner repository ---
    this.inputBucket = props.inputBucket ?? new s3.Bucket(this, 'InputBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    if (!props.inputBucket) {
      acknowledge(
        this.inputBucket,
        'AwsSolutions-S1',
        'The tool reads inputs with the tool tenant role and writes one structured line per call with tenantId, runId and input size (spec 3.8, ADR-0013); that line is the access record. A vendor who needs object-level records adds S3 data events.',
      );
    }
    this.nagContext = { inputBucket: nagFindingResource(this, this.inputBucket.bucketArn), logGroups: [], logGroupPrefixes: [] };
    const containers = this.config.backends.some((b) => b === 'nitro' || b === 'agentcore');
    if (containers) {
      this.runnerRepository = new ecr.Repository(this, 'RunnerRepository', {
        repositoryName: nameFor('ecr-repository', 'runner'),
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      });
    }

    // --- Registry (spec §4.1, ADR-0005) ---
    const table = new dynamodb.Table(this, 'Registry', {
      partitionKey: { name: REGISTRY.PK, type: dynamodb.AttributeType.STRING },
      sortKey: { name: REGISTRY.SK, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: REGISTRY.TTL_AT,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.registryTable = table;

    // --- Log drain and Contributor Insights rules ---
    this.logDrain = new LogDrain(this, 'LogDrain');
    this.insights = new InsightRules(this, 'Insights', nameFor);

    // --- Backends ---
    // The runner image copy is the core's (ADR-0029): a backend asks for the tag of an architecture, and its
    // resources wait for the copies it asked for.
    const images = this.runnerRepository
      ? new RunnerImages(this, 'RunnerImages', {
        repository: this.runnerRepository,
        inputBucket: this.inputBucket,
        logDrain: this.logDrain,
        runnerDir: runnerPath(),
      })
      : undefined;
    const backends: Partial<Record<BackendName, BackendConstruct>> = {};
    const copiesOf: Partial<Record<BackendName, Set<RunnerArch>>> = {};
    for (const name of this.config.backends) {
      const asked = new Set<RunnerArch>();
      copiesOf[name] = asked;
      const ctx: BackendContext = {
        vpc: this.vpc,
        sandboxSubnets,
        toolSubnets: this.toolSubnets,
        toolSecurityGroup,
        inputBucket: this.inputBucket,
        runnerRepository: this.runnerRepository,
        runnerImageTag: images && ((arch) => {
          asked.add(arch);
          return images.tag(arch);
        }),
        runnerDir: runnerPath(),
        nameFor,
        settings: this.config.settings,
      };
      backends[name] = FACTORIES[name](this, `Backend-${name}`, ctx);
    }
    this.backends = backends;
    const enabled = this.config.backends.map((n) => backends[n] as BackendConstruct);
    this.backendOutputs = Object.assign({}, ...enabled.map((b) => b.outputs())) as Record<string, string>;

    const needsEndpoints = enabled.some((b) => b.endpoints().length > 0);
    if (needsEndpoints && this.config.createEndpoints) {
      new SandboxEndpoints(this, 'Endpoints', {
        vpc: this.vpc,
        sandboxSubnets,
        backends: enabled,
        inputBucket: this.inputBucket,
        runnerRepository: this.runnerRepository,
        sessionFiles: this.config.settings.agentcoreSessionFiles,
        s3PrefixListId: this.config.s3PrefixListId,
        vpcSupplied: props.vpc !== undefined,
      });
    } else if (needsEndpoints && !props.vpc) {
      throw new Error('UntrustedCodeSandboxes: createEndpoints false needs a supplied vpc that already has the spec 3.7 endpoints');
    }

    // --- Roles (spec §3.6) ---
    const toolRole = this.lambdaRole('ToolRole', 'run_code tool functions (spec 3.6 Tool role)');
    this.toolRole = toolRole;
    this.tenantRole = new iam.Role(this, 'ToolTenantRole', {
      description: 'Assumed by the tool with a TenantId session tag; reaches only that tenant (spec 3.6)',
      assumedBy: new iam.PrincipalWithConditions(
        new iam.ArnPrincipal(toolRole.roleArn).withSessionTags(),
        { Null: { [`aws:RequestTag/${TENANT_TAG}`]: 'false' } },
      ),
      maxSessionDuration: Duration.hours(1),
    });
    this.toolTenantRole = this.tenantRole;
    this.addTenantStatements(table, enabled);

    this.toolStatements = [
      new iam.PolicyStatement({
        sid: 'AssumeToolTenantRole',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.tenantRole.roleArn],
      }),
      ...enabled.flatMap((b) => b.toolStatements()),
    ];
    this.toolStatements.forEach((s) => toolRole.addToPrincipalPolicy(s));

    const registryAll = new iam.PolicyStatement({
      sid: 'RegistryRows',
      actions: ALL_ROW_ACTIONS,
      resources: [table.tableArn],
    });
    const reaperRole = this.lambdaRole('ReaperRole', 'reaper and offboard functions: stop actions only (spec 3.6 Reaper role)');
    [registryAll, ...enabled.flatMap((b) => b.reaperStatements())].forEach((s) => reaperRole.addToPrincipalPolicy(s));
    const drainRole = this.lambdaRole('DrainRole', 'drain custom resource: the reaper role plus the instance actions (spec 3.6 Drain role)');
    [registryAll, ...enabled.flatMap((b) => b.reaperStatements()), ...enabled.flatMap((b) => b.drainStatements())]
      .forEach((s) => drainRole.addToPrincipalPolicy(s));

    // --- Environment shared by every function ---
    const e = this.config.settings;
    this.environment = {
      [ENV.REGISTRY_TABLE]: table.tableName,
      [ENV.INPUT_BUCKET]: this.inputBucket.bucketName,
      [ENV.BACKENDS]: this.config.backends.join(','),
      [ENV.DEFAULT_BACKEND]: this.config.defaultBackend,
      [ENV.TOOL_TENANT_ROLE_ARN]: this.tenantRole.roleArn,
      [ENV.RUN_TIMEOUT_MS]: String(e.runTimeout.toMilliseconds()),
      [ENV.START_WAIT_MS]: String(e.startWait.toMilliseconds()),
      [ENV.MAX_OUTPUT_BYTES]: String(e.maxOutputBytes),
      [ENV.MAX_INPUT_BYTES]: String(this.config.maxInputBytes),
      [ENV.SANDBOX_IDLE_MS]: String(e.sandboxIdle.toMilliseconds()),
      [ENV.SANDBOX_MAX_LIFE_MS]: String(e.sandboxMaxLife.toMilliseconds()),
      [ENV.PER_TENANT_METRICS]: String(this.config.perTenantMetrics),
      ...Object.assign({}, ...enabled.map((b) => b.environment())),
    };

    // --- Functions (spec §3.1, §3.7) ---
    const reaper = this.lambdaFunction('Reaper', HANDLERS.reaper, reaperRole, Duration.minutes(4), 'Stops idle and over-age sandboxes and sweeps orphans (spec 4.1)');
    this.insights.addStopLogGroup(reaper.logGroup.logGroupName);
    const schedule = new events.Rule(this, 'ReaperSchedule', {
      description: 'Runs the sandbox reaper every 5 minutes (spec 4.1)',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(reaper.fn, { retryAttempts: 0 })],
    });
    const offboard = this.lambdaFunction('Offboard', HANDLERS.offboard, reaperRole, Duration.minutes(2), 'Stops one tenant\'s sandboxes and deletes its rows (spec 5.2)');
    this.insights.addStopLogGroup(offboard.logGroup.logGroupName);
    this.offboardFunction = offboard.fn;

    const drain = this.lambdaFunction('Drain', HANDLERS.drain, drainRole, Duration.minutes(15), 'Stops every sandbox before the stack deletes its resources (spec 5.3)');
    this.insights.addStopLogGroup(drain.logGroup.logGroupName);
    this.drainResource = new CustomResource(this, 'DrainResource', {
      serviceToken: drain.fn.functionArn,
      serviceTimeout: Duration.minutes(15),
      properties: { Backends: this.config.backends },
    });
    acknowledgeServiceTimeout(this.drainResource);

    // Delete order: tool functions, then the drain, then the backends' resources, then the log cleanup.
    const logCleanups = enabled.map((b) => b.logCleanup());
    const prefixes = logCleanups.flatMap((c) => c.prefixes);
    const names = logCleanups.flatMap((c) => c.names);
    const cleanup = prefixes.length + names.length > 0 ? new LogCleanup(this, 'LogCleanup', { prefixes, names }) : undefined;
    this.nagContext = { ...this.nagContext, logGroups: names.map((g) => nagFindingResource(this, g)), logGroupPrefixes: prefixes.map((g) => nagFindingResource(this, g)) };
    if (!props.inputBucket) this.ownAutoDeleteLogGroup();
    for (const b of enabled) {
      for (const resource of b.drainOrder()) {
        // The resource that runs the image waits for the copy of every architecture its backend asked for (ADR-0029).
        for (const arch of copiesOf[b.name] ?? []) resource.node.addDependency((images as RunnerImages).copy(arch));
        this.drainResource.node.addDependency(resource);
        if (cleanup) resource.node.addDependency(cleanup.resource);
      }
    }
    // The drain itself must be deleted before the registry and the roles it reads, and the reaper schedule before the drain
    // so the two never sweep at once.
    this.drainResource.node.addDependency(table);
    schedule.node.addDependency(this.drainResource);
    this.logDrain.writer(this.drainResource);

    if (this.config.standalone) {
      const run = this.lambdaFunction('RunCode', HANDLERS.runCode, toolRole, this.config.toolBudget, 'run_code for the vendor\'s own API (spec 3.2, ADR-0017)', 512);
      this.insights.addToolLogGroup(run.logGroup.logGroupName);
      (run.fn.node.defaultChild as lambda.CfnFunction).addResourceDependency(this.drainResource.node.defaultChild as CfnResource);
      this.runCodeFunction = run.fn;
    }

    // --- DNS Firewall (spec §3.9, ADR-0016) ---
    if (this.config.dnsFirewall) {
      this.dnsFirewall = new DnsFirewall(this, 'DnsFirewall', {
        vpc: this.vpc,
        allowDomains: this.config.dnsFirewall.allowDomains,
        nameFor,
      });
      this.insights.addDnsBlocked(this.dnsFirewall.queryLogGroup.logGroupName);
      this.logDrain.protect(this.dnsFirewall.queryLogGroup);
      this.logDrain.writer(this.dnsFirewall.queryLogAssociation);
    }

    acknowledgeKnownFindings(this, this.nagContext);

    this.node.addValidation({
      validate: () => (this.config.standalone || this.bound.length > 0
        ? []
        : ['UntrustedCodeSandboxes has no entry: set standalone: true or bind a RunCodeToolTarget (ADR-0017)']),
    });
  }

  /**
   * Give a function everything the core run function has (spec §3.3): the
   * tool subnets and security group, the environment, the timeout from the
   * budget, a place in the tool tenant role's trust policy, the tool role's
   * statements, an owned log group and the Contributor Insights rules. The
   * function must be a `lambda.Function` (a `NodejsFunction` is one) with
   * a role created in this app; the subnets, the timeout and the environment
   * are set through the underlying `CfnFunction`. The role loses the managed
   * execution policies of the Lambda event sources (basic, VPC access, SQS,
   * Kinesis, DynamoDB, MSK), which allow log writes on every group, and
   * gets the exact statements instead (ADR-0029): attach any other managed
   * policy before binding, and give the function a role of its own, because
   * a role shared with another function loses those policies for both.
   */
  public bindRunCode(fn: lambda.IFunction): void {
    if (!(fn instanceof lambda.Function)) {
      throw new Error('UntrustedCodeSandboxes.bindRunCode takes a lambda.Function (ADR-0029)');
    }
    const cfn = fn.node.defaultChild as lambda.CfnFunction;
    const subnetIds = this.vpc.selectSubnets(this.toolSubnets).subnetIds;
    cfn.vpcConfig = { subnetIds, securityGroupIds: [this.toolSecurityGroup.securityGroupId] };
    cfn.timeout = this.config.toolBudget.toSeconds();
    for (const [key, value] of Object.entries(this.environment)) fn.addEnvironment(key, value);
    const role = fn.role;
    if (!(role instanceof iam.Role)) {
      throw new Error('UntrustedCodeSandboxes.bindRunCode needs a function built with a role created in this app, not an imported one (ADR-0029)');
    }
    if (role !== this.toolRole) {
      // The two managed policies a default function role carries allow log writes on every group; the statements
      // below replace them (ADR-0029).
      const cfnRole = role.node.defaultChild as iam.CfnRole;
      const managed = (Stack.of(role).resolve(cfnRole.managedPolicyArns) as unknown[] | undefined) ?? [];
      const keep = managed.filter((m) => !/:iam::aws:policy\/service-role\/AWSLambda(Basic|VPCAccess|SQSQueue|Kinesis|DynamoDB|MSK)ExecutionRole$/.test(flatten(m)));
      // The property itself, not an override, so cdk-nag sees the role as it is.
      if (keep.length !== managed.length) cfnRole.managedPolicyArns = keep.length > 0 ? (keep as string[]) : undefined;
      role.addToPrincipalPolicy(vpcAccessStatement());
      this.toolStatements.forEach((s) => role.addToPrincipalPolicy(s));
      this.tenantRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(role.roleArn)],
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        conditions: { Null: { [`aws:RequestTag/${TENANT_TAG}`]: 'false' } },
      }));
    }
    // The function's own log group when it was built with `logGroup`. Otherwise a group the construct owns and
    // sets on the function, behind the log drain like the core's own (ADR-0029).
    const config = cfn.loggingConfig as { logGroup?: string } | undefined;
    let groupName: string;
    if (config?.logGroup) {
      groupName = config.logGroup;
      const ownGroupArn = Stack.of(this).formatArn({ service: 'logs', resource: 'log-group', resourceName: `${groupName}:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'WriteOwnLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [ownGroupArn],
      }));
      acknowledgeGranularFinding(
        role,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, ownGroupArn)}]`,
        'The wildcard is the log stream part of the function\'s own log group, which it was built with; no other group is named (ADR-0029).',
      );
    } else {
      const group = new logs.LogGroup(this, `BoundLogs${this.bound.length}`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      cfn.loggingConfig = { ...(config ?? {}), logGroup: group.logGroupName };
      group.grantWrite(role);
      this.logDrain.protect(group);
      this.logDrain.writer(cfn);
      groupName = group.logGroupName;
    }
    // Only the function resource waits for the drain, not its role, which the tenant role's trust names.
    cfn.addResourceDependency(this.drainResource.node.defaultChild as CfnResource);
    this.insights.addToolLogGroup(groupName);
    acknowledgeKnownFindings(role, this.nagContext);
    this.bound.push(fn);
  }

  /** Lets a principal in the app invoke `runCodeFunction` (spec §3.6 "Standalone invokers"). */
  public grantInvokeRunCode(grantee: iam.IGrantable): iam.Grant {
    if (!this.runCodeFunction) {
      throw new Error('UntrustedCodeSandboxes: runCodeFunction exists only with standalone: true (ADR-0017)');
    }
    return this.runCodeFunction.grantInvoke(grantee);
  }

  private createVpc(): ec2.Vpc {
    const vpc = new ec2.Vpc(this, 'Vpc', {
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
    for (const subnet of vpc.selectSubnets({ subnetGroupName: SUBNET_GROUPS.tool }).subnets) Tags.of(subnet).add(TIER_TAG, 'tool');
    for (const subnet of vpc.selectSubnets({ subnetGroupName: SUBNET_GROUPS.sandbox }).subnets) Tags.of(subnet).add(TIER_TAG, 'sandbox');
    return vpc;
  }

  /**
   * The bucket's auto-delete provider is a function CDK adds to the stack, shared by every bucket in it, with no log
   * group of its own: Lambda would make one that a destroy leaves behind. Point it at a group the construct owns,
   * behind the log drain (spec 6.2 C-6).
   */
  private ownAutoDeleteLogGroup(): void {
    const stack = Stack.of(this);
    const handler = stack.node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider')?.node.tryFindChild('Handler') as CfnResource | undefined;
    if (!handler) return;
    let group = autoDeleteGroups.get(stack);
    if (!group) {
      group = new logs.LogGroup(this, 'AutoDeleteLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
      autoDeleteGroups.set(stack, group);
      handler.addPropertyOverride('LoggingConfig', { LogGroup: group.logGroupName });
      this.logDrain.protect(group);
    }
    this.logDrain.writer(handler);
  }

  /** An execution role for the functions in the tool subnets. */
  private lambdaRole(id: string, description: string): iam.Role {
    const role = new iam.Role(this, id, {
      description,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPrincipalPolicy(vpcAccessStatement());
    return role;
  }

  private addTenantStatements(table: dynamodb.ITable, enabled: readonly BackendConstruct[]): void {
    const inputs = this.inputBucket.arnForObjects(`inputs/${TENANT_VARIABLE}/*`);
    const outputs = this.inputBucket.arnForObjects(`outputs/${TENANT_VARIABLE}/*`);
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadOwnInputs',
      actions: ['s3:GetObject'],
      resources: [inputs],
    }));
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteOwnOutputs',
      actions: ['s3:PutObject'],
      resources: [outputs],
    }));
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OwnRegistryRows',
      actions: TENANT_ROW_ACTIONS,
      resources: [table.tableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`${TENANT_KEY_PREFIX}${TENANT_VARIABLE}`] },
      },
    }));
    enabled.flatMap((b) => b.tenantStatements()).forEach((s) => this.tenantRole.addToPolicy(s));
  }

  /** One function, with an owned log group, the shared environment and the tool subnets. */
  private lambdaFunction(
    id: string,
    entry: string,
    role: iam.Role,
    timeout: Duration,
    description: string,
    memorySize = 256,
  ): { fn: NodejsFunction; logGroup: logs.LogGroup } {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.logDrain.protect(logGroup);
    logGroup.grantWrite(role);
    // An immutable reference, so the L2 adds no managed policy to the role: the role holds what is written here.
    const fn = new NodejsFunction(this, id, {
      entry: handlerEntry(entry),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      timeout,
      role: iam.Role.fromRoleArn(this, `${id}RoleRef`, role.roleArn, { mutable: false }),
      description,
      environment: { ...this.environment },
      vpc: this.vpc,
      vpcSubnets: this.toolSubnets,
      securityGroups: [this.toolSecurityGroup],
      logGroup,
      // JSON format, so a line written with process.stdout.write keeps its top-level fields (spec 3.8).
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    // The function waits for the role and its policy.
    fn.node.addDependency(role);
    this.logDrain.writer(fn);
    return { fn, logGroup };
  }
}
