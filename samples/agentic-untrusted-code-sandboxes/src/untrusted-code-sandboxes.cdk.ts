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

import { type CfnResource, CustomResource, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
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
import { acknowledge, acknowledgeGranularFinding, nagFindingResource } from './core/nag';
import { InsightRules } from './core/observability';
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

const VPC_ACCESS_POLICY = 'service-role/AWSLambdaVPCAccessExecutionRole';
const TENANT_VARIABLE = `\${aws:PrincipalTag/${TENANT_TAG}}`;

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
  /** The one role every tool function runs as (spec §3.6 "Tool role"). */
  public readonly toolRole: iam.IRole;
  /** The role the tool assumes with a `TenantId` session tag (spec §3.6 "Tool tenant role"). */
  public readonly toolTenantRole: iam.IRole;
  /** Stops one tenant's sandboxes; runs as the reaper role, which holds no instance action (spec §5.2). */
  public readonly offboardFunction: lambda.IFunction;
  /** Only with `standalone: true` (ADR-0017). */
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

    // --- Backends ---
    const ctx: BackendContext = {
      vpc: this.vpc,
      sandboxSubnets,
      toolSubnets: this.toolSubnets,
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
      });
    } else if (needsEndpoints && !props.vpc) {
      throw new Error('UntrustedCodeSandboxes: createEndpoints false needs a supplied vpc that already has the spec 3.7 endpoints');
    }

    // --- Logs, drain and observability scaffolding ---
    this.logDrain = new LogDrain(this, 'LogDrain');
    this.insights = new InsightRules(this, 'Insights', nameFor);

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
    acknowledgeGranularFinding(
      reaperRole,
      'AwsSolutions-IAM5[Resource::*]',
      'The only resource-less actions are lambda:ListMicrovms (it takes no resource; the call filters by image); each other statement names its table, cluster or image (spec 3.6 Reaper role, ADR-0011).',
    );
    const drainRole = this.lambdaRole('DrainRole', 'drain custom resource: the reaper role plus the instance actions (spec 3.6 Drain role)');
    [registryAll, ...enabled.flatMap((b) => b.reaperStatements()), ...enabled.flatMap((b) => b.drainStatements())]
      .forEach((s) => drainRole.addToPrincipalPolicy(s));

    acknowledgeGranularFinding(
      drainRole,
      'AwsSolutions-IAM5[Resource::*]',
      'The only resource-less actions are lambda:ListMicrovms and ec2:DescribeInstances, which take no resource; the forced deregister is limited to the cluster (spec 3.6 Drain role, ADR-0011).',
    );

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
    new events.Rule(this, 'ReaperSchedule', {
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
    acknowledge(
      this.drainResource,
      'CloudFormation-Validate::W9003',
      'CloudFormation takes ServiceTimeout as a number of seconds; CDK writes it as a string and CloudFormation coerces it. 900 s matches the drain function timeout, so a function that dies never holds the delete for the default hour (spec 5.3).',
    );

    // Delete order: tool functions, then the drain, then the backends' resources, then the log cleanup.
    const logCleanups = enabled.map((b) => b.logCleanup());
    const prefixes = logCleanups.flatMap((c) => c.prefixes);
    const names = logCleanups.flatMap((c) => c.names);
    const cleanup = prefixes.length + names.length > 0 ? new LogCleanup(this, 'LogCleanup', { prefixes, names }) : undefined;
    for (const b of enabled) {
      for (const resource of b.drainOrder()) {
        this.drainResource.node.addDependency(resource);
        if (cleanup) resource.node.addDependency(cleanup.resource);
      }
    }
    // The drain itself must be deleted before the registry and the roles it reads.
    this.drainResource.node.addDependency(table);
    this.logDrain.writer(this.drainResource);

    if (this.config.standalone) {
      const run = this.lambdaFunction('RunCode', HANDLERS.runCode, toolRole, this.config.toolBudget, 'run_code for the vendor\'s own API (spec 3.2, ADR-0017)', 512);
      this.insights.addToolLogGroup(run.logGroup.logGroupName);
      (run.fn.node.defaultChild as lambda.CfnFunction).addDependency(this.drainResource.node.defaultChild as CfnResource);
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
   * a role the construct may add statements to; the subnets, the timeout
   * and the environment are set through the underlying `CfnFunction`.
   */
  public bindRunCode(fn: lambda.IFunction): void {
    if (!(fn instanceof lambda.Function)) {
      throw new Error('UntrustedCodeSandboxes.bindRunCode takes a lambda.Function (ADR-0029)');
    }
    if (!fn.role) throw new Error('UntrustedCodeSandboxes.bindRunCode needs a function with a role');
    const cfn = fn.node.defaultChild as lambda.CfnFunction;
    const subnetIds = this.vpc.selectSubnets(this.toolSubnets).subnetIds;
    cfn.vpcConfig = { subnetIds, securityGroupIds: [this.toolSecurityGroup.securityGroupId] };
    cfn.timeout = this.config.toolBudget.toSeconds();
    for (const [key, value] of Object.entries(this.environment)) fn.addEnvironment(key, value);
    if (fn.role !== this.toolRole) {
      fn.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(VPC_ACCESS_POLICY));
      acknowledgeGranularFinding(
        fn.role,
        `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${VPC_ACCESS_POLICY}]`,
        'bindRunCode puts the function in the tool subnets; AWSLambdaVPCAccessExecutionRole holds only the network interface actions that needs (ADR-0029).',
      );
      this.toolStatements.forEach((s) => (fn.role as iam.IRole).addToPrincipalPolicy(s));
      this.tenantRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(fn.role.roleArn)],
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        conditions: { Null: { [`aws:RequestTag/${TENANT_TAG}`]: 'false' } },
      }));
    }
    // The function's own log group when it has one (it was built with `logGroup`); otherwise a group the
    // construct owns, named as Lambda names it. The owned group is deleted before the function (it names the
    // function) and is not behind the log drain: a drain would close a dependency cycle (ADR-0029).
    const own = (cfn.loggingConfig as { logGroup?: string } | undefined)?.logGroup;
    let groupName: string;
    if (own) {
      groupName = own;
    } else {
      groupName = new logs.LogGroup(this, `BoundLogs${this.bound.length}`, {
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }).logGroupName;
    }
    // Only the function resource waits for the drain, not its role, which the tenant role's trust names.
    cfn.addDependency(this.drainResource.node.defaultChild as CfnResource);
    this.insights.addToolLogGroup(groupName);
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

  /** An execution role for the functions in the tool subnets. */
  private lambdaRole(id: string, description: string): iam.Role {
    const role = new iam.Role(this, id, {
      description,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(VPC_ACCESS_POLICY)],
    });
    acknowledgeGranularFinding(
      role,
      `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${VPC_ACCESS_POLICY}]`,
      'AWSLambdaVPCAccessExecutionRole holds only the network interface actions a function in a VPC needs, and they take no resource; a copy would add nothing (ADR-0029).',
    );
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
    for (const [what, resource] of [['inputs', inputs], ['outputs', outputs]] as const) {
      acknowledgeGranularFinding(
        this.tenantRole,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, resource)}]`,
        `The wildcard is the object name under the caller's own ${what}/<TenantId>/ prefix, resolved from the session tag; the role reaches no other prefix (spec 3.6, C-5).`,
      );
    }
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
    const fn = new NodejsFunction(this, id, {
      entry: handlerEntry(entry),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      timeout,
      role,
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
    this.logDrain.writer(fn);
    return { fn, logGroup };
  }
}
