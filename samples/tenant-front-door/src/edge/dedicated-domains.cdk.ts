// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The main stack's dedicated-domain parts (spec §3.1, §3.4 step 5, §6.2,
 * ADR-0018, ADR-0020, ADR-0022):
 *
 * - `registrarDedicatedDomainsPolicy`: the registrar role's CloudFront and
 *   ACM actions, only while `dedicatedDomains` is on;
 * - `Sweeper`: the sweeper function, its role, log group, table, on-failure
 *   queue, the two schedules, the alarms and the starter, only while on;
 * - `DedicatedDomainsGuard`: refuses the on-to-off update while anything
 *   dedicated is left, in both states;
 * - `DedicatedDomainsTeardown`: removes the dedicated distribution tenants
 *   and the registrar's certificates on stack delete, in both states.
 *
 * Where IAM cannot narrow a CloudFront or ACM action to this
 * distribution's resources, the code checks a resource's distribution and
 * tags before it changes it (§3.4). The writes that can carry a tag
 * condition carry one.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy, Stack, TimeZone } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct, IConstruct } from 'constructs';
import { acknowledge, BASIC_EXECUTION_ROLE_FINDING, nagFindingResource } from './nag';
import {
  SWEEPER_ENV,
  SWEEPER_METRIC_NAMESPACE,
  SWEEPER_METRICS,
  SWEEPER_RECHECK_INPUT,
  SWEEPER_REMOVE_INPUT,
  SWEEPER_TABLE,
  SweeperStarterProperties,
  TAG_DISTRIBUTION_ID,
  TAG_TENANT_ID,
} from '../shared/contracts';

/** The Region of every registrar certificate: CloudFront takes certificates from `us-east-1` only. */
export const CERTIFICATE_REGION = 'us-east-1';

/** The sweeper function's timeout (§3.1): a page's 842 s fits in it (§3.4 step 5). */
export const SWEEPER_TIMEOUT = Duration.minutes(15);

/** The sweeper log group's retention (§3.4 step 5). */
export const SWEEPER_LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

/** The removal job's rate (§3.4 step 5). */
export const REMOVE_RATE = Duration.minutes(15);

/** The daily re-check: 02:00 UTC, at most 2 retries, 1 hour maximum event age (§3.4 step 5). */
export const RECHECK_SCHEDULE = { hour: '2', minute: '0', retryAttempts: 2, maxEventAge: Duration.hours(1) } as const;

/** The sweeper's asynchronous invocation configuration: 3 hours, two retries (§3.4 step 5). */
export const SWEEPER_ASYNC = { maxEventAge: Duration.hours(3), retryAttempts: 2 } as const;

/** The guard function's timeout: the 40 s wait and its reads (§3.4). */
export const GUARD_TIMEOUT = Duration.minutes(2);

/** How often the teardown's provider polls, and for how long (§6.2). */
export const TEARDOWN_POLL = { queryInterval: Duration.seconds(30), totalTimeout: Duration.hours(1) } as const;

const L1_REASON = 'Node.js 24, the runtime the demo cell API uses too, so the sample runs on one runtime; move both when Node.js 26 is GA.';
const BASIC_REASON = 'Logs-only managed policy NodejsFunction attaches; a scoped copy changes no access (M-36).';

/** The ARNs that cdk-nag reports as wildcards, built once per stack. */
function arns(scope: IConstruct) {
  const stack = Stack.of(scope);
  return {
    distributionTenants: stack.formatArn({ service: 'cloudfront', region: '', resource: 'distribution-tenant', resourceName: '*' }),
    certificates: stack.formatArn({ service: 'acm', region: CERTIFICATE_REGION, resource: 'certificate', resourceName: '*' }),
  };
}

/** `aws:RequestTag` / `aws:ResourceTag` condition on the registrar's distribution tag. */
function distributionTag(kind: 'RequestTag' | 'ResourceTag', distributionId: string): Record<string, Record<string, unknown>> {
  return { StringEquals: { [`aws:${kind}/${TAG_DISTRIBUTION_ID}`]: distributionId } };
}

/** On create: the distribution tag holds this distribution, and only the registrar's two tags are set. */
function registrarTagsOnCreate(distributionId: string, alsoEquals: Record<string, string> = {}): Record<string, Record<string, unknown>> {
  return {
    'StringEquals': { [`aws:RequestTag/${TAG_DISTRIBUTION_ID}`]: distributionId, ...alsoEquals },
    'ForAllValues:StringEquals': { 'aws:TagKeys': [TAG_TENANT_ID, TAG_DISTRIBUTION_ID] },
  };
}

const IN_CERTIFICATE_REGION = { StringEquals: { 'aws:RequestedRegion': CERTIFICATE_REGION } };

/** The removal actions the sweeper and the teardown share (§3.4 step 5, §6.2). */
function removalStatements(scope: IConstruct, distributionId: string): iam.PolicyStatement[] {
  const a = arns(scope);
  return [
    new iam.PolicyStatement({ sid: 'DistributionTenantList', actions: ['cloudfront:ListDistributionTenants'], resources: ['*'] }),
    // Get and List return no tags; ListTagsForResource does (design/spikes.md, Smoke run).
    new iam.PolicyStatement({
      sid: 'DistributionTenantRead',
      actions: ['cloudfront:GetDistributionTenant', 'cloudfront:ListTagsForResource'],
      resources: [a.distributionTenants],
    }),
    new iam.PolicyStatement({
      sid: 'DistributionTenantRemove',
      actions: ['cloudfront:UpdateDistributionTenant', 'cloudfront:DeleteDistributionTenant'],
      resources: [a.distributionTenants],
      conditions: distributionTag('ResourceTag', distributionId),
    }),
    new iam.PolicyStatement({
      sid: 'CertificateList',
      actions: ['acm:ListCertificates'],
      resources: ['*'],
      conditions: IN_CERTIFICATE_REGION,
    }),
    new iam.PolicyStatement({
      sid: 'CertificateDelete',
      actions: ['acm:DeleteCertificate'],
      resources: [a.certificates],
      conditions: distributionTag('ResourceTag', distributionId),
    }),
  ];
}

/** The cdk-nag acknowledgements for the wildcards `removalStatements` and the guard use. */
function acknowledgeDedicatedWildcards(scope: IConstruct, who: string): void {
  const a = arns(scope);
  acknowledge(
    scope,
    'AwsSolutions-IAM5[Resource::*]',
    `${who}: cloudfront:ListDistributionTenants and acm:ListCertificates take no resource ARN; ListCertificates is held to us-east-1 `
    + 'by aws:RequestedRegion, and the code keeps only this distribution\'s tenants and the certificates tagged with it (spec §3.4).',
  );
  acknowledge(
    scope,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, a.distributionTenants)}]`,
    `${who}: distribution tenant ids are made by CloudFront at create, outside the stack, so no ARN is known; the writes carry `
    + `the aws:ResourceTag/${TAG_DISTRIBUTION_ID} condition and the code checks the tenant's distribution and tags first (spec §3.4).`,
  );
  acknowledge(
    scope,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, a.certificates)}]`,
    `${who}: the registrar requests certificates outside the stack, so no ARN is known; tags are read on every certificate to find `
    + `the registrar's, and the delete carries the aws:ResourceTag/${TAG_DISTRIBUTION_ID} condition (spec §3.4, §6.2).`,
  );
}

interface FunctionOptions {
  readonly entry: string;
  readonly handler: string;
  readonly timeout: Duration;
  readonly description: string;
  readonly retention: logs.RetentionDays;
  readonly memorySize?: number;
  readonly environment?: Record<string, string>;
}

/** A Node.js 24 ARM function with its own log group and JSON logs, like the stack's others. */
function nodeFunction(scope: Construct, id: string, o: FunctionOptions): NodejsFunction {
  const fn = new NodejsFunction(scope, id, {
    entry: o.entry,
    handler: o.handler,
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: o.memorySize ?? 256,
    timeout: o.timeout,
    environment: o.environment,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      retention: o.retention,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    }),
    loggingFormat: lambda.LoggingFormat.JSON,
    description: o.description,
    bundling: { minify: true, sourceMap: false, externalModules: [] },
  });
  acknowledge(fn, BASIC_EXECUTION_ROLE_FINDING, BASIC_REASON);
  acknowledge(fn, 'AwsSolutions-L1', L1_REASON);
  return fn;
}

const CUSTOM_RESOURCES = path.join(__dirname, '..', 'custom-resources');

/**
 * An SQS on-failure destination that grants the function `sqs:SendMessage`
 * alone, the one action §3.4 step 5 names. CDK's `SqsDestination` also
 * grants `GetQueueAttributes` and `GetQueueUrl`.
 */
class SendOnlyQueueDestination implements lambda.IDestination {
  constructor(private readonly queue: sqs.IQueue) {}

  public bind(_scope: Construct, fn: lambda.IFunction): lambda.DestinationConfig {
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'OnFailure', actions: ['sqs:SendMessage'], resources: [this.queue.queueArn] }));
    return { destination: this.queue.queueArn };
  }
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

/**
 * The registrar role's dedicated-domain actions (§3.4, the paragraph after
 * the hook's backfill): a policy of its own, so turning `dedicatedDomains`
 * off removes it in the update's cleanup, after the guard has passed.
 */
export function registrarDedicatedDomainsPolicy(scope: Construct, id: string, role: iam.IRole, distributionId: string): iam.Policy {
  const a = arns(scope);
  const policy = new iam.Policy(scope, id, {
    roles: [role],
    statements: [
      // Reads any distribution tenant: one for the domain on another
      // distribution, or tagged with another tenant, answers 409 (§3.4 step 5).
      new iam.PolicyStatement({
        sid: 'DistributionTenantRead',
        actions: ['cloudfront:GetDistributionTenantByDomain', 'cloudfront:ListTagsForResource'],
        resources: [a.distributionTenants],
      }),
      new iam.PolicyStatement({
        sid: 'DistributionTenantCreate',
        actions: ['cloudfront:CreateDistributionTenant'],
        resources: ['*'],
        conditions: registrarTagsOnCreate(distributionId),
      }),
      // Tagging on create (§3.4).
      new iam.PolicyStatement({
        sid: 'DistributionTenantTagOnCreate',
        actions: ['cloudfront:TagResource'],
        resources: [a.distributionTenants],
        conditions: registrarTagsOnCreate(distributionId),
      }),
      new iam.PolicyStatement({
        sid: 'DistributionTenantUpdate',
        actions: ['cloudfront:UpdateDistributionTenant'],
        resources: [a.distributionTenants],
        conditions: distributionTag('ResourceTag', distributionId),
      }),
      new iam.PolicyStatement({
        sid: 'CertificateList',
        actions: ['acm:ListCertificates'],
        resources: ['*'],
        conditions: IN_CERTIFICATE_REGION,
      }),
      // The ACM writes conditioned on the registrar's tag (§3.4).
      new iam.PolicyStatement({
        sid: 'CertificateRequest',
        actions: ['acm:RequestCertificate'],
        resources: ['*'],
        conditions: registrarTagsOnCreate(distributionId, IN_CERTIFICATE_REGION.StringEquals),
      }),
      new iam.PolicyStatement({
        sid: 'CertificateTagOnRequest',
        actions: ['acm:AddTagsToCertificate'],
        resources: [a.certificates],
        conditions: registrarTagsOnCreate(distributionId),
      }),
      // Reads any certificate's tags: one tagged for another tenant or
      // distribution answers 409 (§3.4 step 4).
      new iam.PolicyStatement({
        sid: 'CertificateRead',
        actions: ['acm:DescribeCertificate', 'acm:ListTagsForCertificate'],
        resources: [a.certificates],
      }),
    ],
  });
  acknowledge(
    policy,
    'AwsSolutions-IAM5[Resource::*]',
    'cloudfront:CreateDistributionTenant, acm:RequestCertificate and acm:ListCertificates take no resource ARN (Service Authorization '
    + `Reference). The creates carry aws:RequestTag/${TAG_DISTRIBUTION_ID} with this distribution and aws:TagKeys with the registrar's `
    + 'two tags; the ACM calls are held to us-east-1 by aws:RequestedRegion (spec §3.4).',
  );
  acknowledge(
    policy,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, a.distributionTenants)}]`,
    'Distribution tenant ids are made by CloudFront at create, outside the stack, so no ARN is known. Reads cover any tenant, because '
    + 'a domain another tenant or distribution holds answers 409; tagging carries the aws:RequestTag and updates the aws:ResourceTag '
    + `condition on ${TAG_DISTRIBUTION_ID} (spec §3.4 step 5).`,
  );
  acknowledge(
    policy,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, a.certificates)}]`,
    'The registrar requests certificates outside the stack, so no ARN is known. Tag reads cover any certificate, because one tagged for '
    + `another tenant answers 409; tagging carries the aws:RequestTag condition on ${TAG_DISTRIBUTION_ID} (spec §3.4 step 4).`,
  );
  return policy;
}

// ---------------------------------------------------------------------------
// Sweeper (§3.1, §3.4 step 5, ADR-0020, ADR-0022)
// ---------------------------------------------------------------------------

export interface SweeperProps {
  readonly routeTableArn: string;
  readonly distributionId: string;
  /** The ALARM action of every alarm, when the deployer gives one (§3.6 `alarmTopicArn`). */
  readonly alarmAction?: cloudwatch.IAlarmAction;
}

export class Sweeper extends Construct {
  public readonly function: NodejsFunction;
  public readonly table: dynamodb.Table;
  public readonly queue: sqs.Queue;
  public readonly schedules: scheduler.Schedule[];
  public readonly alarms: cloudwatch.Alarm[];
  public readonly starter: CustomResource;

  constructor(scope: Construct, id: string, props: SweeperProps) {
    super(scope, id);
    const a = arns(this);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: SWEEPER_TABLE.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SWEEPER_TABLE.sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: SWEEPER_TABLE.timeToLiveAttribute,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });

    // The function's on-failure destination: a page or a removal that
    // failed after Lambda's two retries (§3.4 step 5).
    this.queue = new sqs.Queue(this, 'OnFailure', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    acknowledge(
      this.queue,
      'AwsSolutions-SQS3',
      'This queue is the sweeper\'s on-failure destination; its depth alarm tells the operator, who redrives it by hand (spec §3.4 step 5).',
    );

    const environment: Record<keyof typeof SWEEPER_ENV, string> = {
      routeTableArn: props.routeTableArn,
      distributionId: props.distributionId,
      tableName: this.table.tableName,
    };
    this.function = nodeFunction(this, 'Function', {
      entry: path.join(__dirname, '..', 'sweeper', 'sweeper.function.ts'),
      handler: 'handler',
      timeout: SWEEPER_TIMEOUT,
      retention: SWEEPER_LOG_RETENTION,
      description: 'Tenant front door sweeper: dedicated-domain removal and daily challenge re-check (spec §3.4 step 5)',
      environment: Object.fromEntries(Object.entries(environment).map(([k, v]) => [SWEEPER_ENV[k as keyof typeof SWEEPER_ENV], v])),
    });
    this.function.configureAsyncInvoke({
      maxEventAge: SWEEPER_ASYNC.maxEventAge,
      retryAttempts: SWEEPER_ASYNC.retryAttempts,
      onFailure: new SendOnlyQueueDestination(this.queue),
    });

    // The route table read: ListKeys for the lister, GetKey for a page's
    // and the removal's per-entry reads (ADR-0022).
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RouteTableRead',
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:ListKeys',
        'cloudfront-keyvaluestore:GetKey',
      ],
      resources: [props.routeTableArn],
    }));
    for (const s of removalStatements(this, props.distributionId)) this.function.addToRolePolicy(s);
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CertificateRead',
      actions: ['acm:ListTagsForCertificate', 'acm:DescribeCertificate'],
      resources: [a.certificates],
    }));
    // BatchWriteItem for the lister's batch delete (ADR-0022). The table
    // has no index, so no index ARN.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: 'Table',
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
      resources: [this.table.tableArn],
    }));
    // The lister's fan-out, one asynchronous invocation per page. A policy
    // of its own: in the default policy, which the function depends on,
    // the function's own ARN would be a cycle.
    new iam.Policy(this, 'FanOut', {
      roles: [this.function.role!],
      statements: [new iam.PolicyStatement({ sid: 'FanOut', actions: ['lambda:InvokeFunction'], resources: [this.function.functionArn] })],
    });
    acknowledgeDedicatedWildcards(this.function, 'Sweeper');

    // Both schedules send a delivery they could not make to the same queue,
    // so its depth alarm covers them too. Spec §3.4 step 5 names no
    // dead-letter queue for the schedules; this is the conservative choice.
    const removeTarget = new schedulerTargets.LambdaInvoke(this.function, {
      input: scheduler.ScheduleTargetInput.fromText(SWEEPER_REMOVE_INPUT),
      // The next run 15 minutes later redoes the work, so an older
      // delivery is dropped. Spec §3.4 step 5 sets no policy for it.
      maxEventAge: REMOVE_RATE,
      retryAttempts: 2,
      deadLetterQueue: this.queue,
    });
    const recheckTarget = new schedulerTargets.LambdaInvoke(this.function, {
      input: scheduler.ScheduleTargetInput.fromText(SWEEPER_RECHECK_INPUT),
      maxEventAge: RECHECK_SCHEDULE.maxEventAge,
      retryAttempts: RECHECK_SCHEDULE.retryAttempts,
      deadLetterQueue: this.queue,
    });
    this.schedules = [
      new scheduler.Schedule(this, 'RemoveSchedule', {
        description: 'Tenant front door sweeper: remove (spec §3.4 step 5)',
        schedule: scheduler.ScheduleExpression.rate(REMOVE_RATE),
        target: removeTarget,
      }),
      new scheduler.Schedule(this, 'RecheckSchedule', {
        description: 'Tenant front door sweeper: daily challenge re-check (spec §3.4 step 5)',
        schedule: scheduler.ScheduleExpression.cron({
          minute: RECHECK_SCHEDULE.minute,
          hour: RECHECK_SCHEDULE.hour,
          timeZone: TimeZone.ETC_UTC,
        }),
        target: recheckTarget,
      }),
    ];
    // aws-scheduler-targets makes one role per stack for its Lambda targets.
    const schedulerRole = Stack.of(this).node.children.find((c) => c.node.id.startsWith('SchedulerRoleForTarget'));
    if (schedulerRole === undefined) throw new Error('The scheduler target role was not found');
    acknowledge(
      schedulerRole,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${this.function.functionArn}:*`)}]`,
      'EventBridge Scheduler\'s target role: aws-scheduler-targets grants lambda:InvokeFunction on the sweeper and its versions; '
      + 'the schedules invoke the unqualified function only (spec §3.4 step 5).',
    );

    this.alarms = this.createAlarms(props.alarmAction);

    // The starter (§3.4 step 5): deployed with the sweeper and after it.
    const starterFn = nodeFunction(this, 'StarterFunction', {
      entry: path.join(CUSTOM_RESOURCES, 'sweeper-starter.function.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      retention: logs.RetentionDays.ONE_MONTH,
      description: 'Tenant front door: starts the sweeper\'s first daily re-check at deploy (spec §3.4 step 5)',
    });
    starterFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'StartSweeper',
      actions: ['lambda:InvokeFunction'],
      resources: [this.function.functionArn],
    }));
    const starterProperties: SweeperStarterProperties = { SweeperFunctionName: this.function.functionName };
    this.starter = new CustomResource(this, 'Starter', {
      serviceToken: starterFn.functionArn,
      resourceType: 'Custom::TenantFrontDoorSweeperStarter',
      properties: { ...starterProperties },
    });
    // The function's subtree holds its role, policies, log group and
    // asynchronous invocation configuration.
    this.starter.node.addDependency(this.function, this.table, this.queue);
    this.starter.node.addDependency(this.node.findChild('FanOut'));
  }

  private createAlarms(action: cloudwatch.IAlarmAction | undefined): cloudwatch.Alarm[] {
    const metric = (metricName: string, statistic: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: SWEEPER_METRIC_NAMESPACE, metricName, statistic, period });
    const alarms = [
      // Spec §3.4 step 5 names the count, not the period: one hour, so a
      // three-miss line alarms within the hour of the page that wrote it.
      new cloudwatch.Alarm(this, 'ThreeMissAlarm', {
        alarmDescription: 'A tenant\'s dedicated domain missed its _tfd-challenge record on three checks in a row: drop the domain or fix the record (spec §3.4 step 5, ADR-0018)',
        metric: metric(SWEEPER_METRICS.threeMiss, cloudwatch.Stats.SUM, Duration.hours(1)),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'UnverifiableAlarm', {
        alarmDescription: 'A dedicated domain\'s challenge lookup errored on three checks in a row: its DNS hides the record (spec §3.4 step 5, ADR-0020)',
        metric: metric(SWEEPER_METRICS.unverifiable, cloudwatch.Stats.SUM, Duration.hours(1)),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // Spec §3.4 step 5 names the queue's depth, not its period: five
      // minutes, the queue metric's own period.
      new cloudwatch.Alarm(this, 'OnFailureDepthAlarm', {
        alarmDescription: 'A sweeper run failed after its retries and waits in the on-failure queue (spec §3.4 step 5)',
        metric: this.queue.metricApproximateNumberOfMessagesVisible({ statistic: cloudwatch.Stats.MAXIMUM, period: Duration.minutes(5) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'MissingPagesAlarm', {
        alarmDescription: 'Yesterday\'s re-check left pages unfinished (spec §3.4 step 5, ADR-0022)',
        metric: metric(SWEEPER_METRICS.missingPages, cloudwatch.Stats.MAXIMUM, Duration.days(1)),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'NoListerAlarm', {
        alarmDescription: 'No re-check lister ran for two days (spec §3.4 step 5, ADR-0020)',
        metric: metric(SWEEPER_METRICS.missingPages, cloudwatch.Stats.SAMPLE_COUNT, Duration.days(1)),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    ];
    if (action !== undefined) {
      for (const alarm of alarms) alarm.addAlarmAction(action);
    }
    return alarms;
  }
}

// ---------------------------------------------------------------------------
// Guard (§3.4, "While `dedicatedDomains` is off")
// ---------------------------------------------------------------------------

export interface DedicatedDomainsGuardProps {
  readonly dedicatedDomains: boolean;
  readonly routeTableArn: string;
  readonly distributionId: string;
  readonly pooledTenantId: string;
}

export class DedicatedDomainsGuard extends Construct {
  public readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: DedicatedDomainsGuardProps) {
    super(scope, id);
    const fn = nodeFunction(this, 'Function', {
      entry: path.join(CUSTOM_RESOURCES, 'dedicated-domains-guard.function.ts'),
      handler: 'handler',
      timeout: GUARD_TIMEOUT,
      retention: logs.RetentionDays.ONE_MONTH,
      description: 'Tenant front door: refuses to turn dedicatedDomains off while a dedicated domain is left (spec §3.4)',
    });
    const a = arns(this);
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RouteTableRead',
      actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:ListKeys'],
      resources: [props.routeTableArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DistributionTenantList', actions: ['cloudfront:ListDistributionTenants'], resources: ['*'] }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CertificateList',
      actions: ['acm:ListCertificates'],
      resources: ['*'],
      conditions: IN_CERTIFICATE_REGION,
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CertificateTags', actions: ['acm:ListTagsForCertificate'], resources: [a.certificates] }));
    acknowledge(
      fn,
      'AwsSolutions-IAM5[Resource::*]',
      'Guard: cloudfront:ListDistributionTenants and acm:ListCertificates take no resource ARN; ListCertificates is held to us-east-1 '
      + 'by aws:RequestedRegion; the guard only reads (spec §3.4).',
    );
    acknowledge(
      fn,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, a.certificates)}]`,
      'Guard: the registrar requests certificates outside the stack, so no ARN is known; the guard reads each one\'s tags to find the '
      + 'registrar\'s and changes nothing (spec §3.4).',
    );

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::TenantFrontDoorDedicatedDomainsGuard',
      properties: {
        DedicatedDomains: props.dedicatedDomains ? 'on' : 'off',
        KeyValueStoreArn: props.routeTableArn,
        DistributionId: props.distributionId,
        PooledTenantId: props.pooledTenantId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Teardown (§6.2, ordered teardown step 6)
// ---------------------------------------------------------------------------

export interface DedicatedDomainsTeardownProps {
  readonly distributionId: string;
}

export class DedicatedDomainsTeardown extends Construct {
  public readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: DedicatedDomainsTeardownProps) {
    super(scope, id);
    const entry = path.join(CUSTOM_RESOURCES, 'dedicated-domains-teardown.function.ts');
    const onEvent = nodeFunction(this, 'OnEvent', {
      entry,
      handler: 'onEvent',
      timeout: Duration.seconds(30),
      retention: logs.RetentionDays.ONE_MONTH,
      description: 'Tenant front door teardown: accepts the request (spec §6.2)',
    });
    // One pass reads every certificate in us-east-1 and every tenant on the distribution.
    const isComplete = nodeFunction(this, 'IsComplete', {
      entry,
      handler: 'isComplete',
      timeout: Duration.minutes(5),
      retention: logs.RetentionDays.ONE_MONTH,
      description: 'Tenant front door teardown: deletes dedicated distribution tenants, then registrar certificates (spec §6.2)',
    });
    for (const s of removalStatements(this, props.distributionId)) isComplete.addToRolePolicy(s);
    isComplete.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CertificateTags',
      actions: ['acm:ListTagsForCertificate'],
      resources: [arns(this).certificates],
    }));
    acknowledgeDedicatedWildcards(isComplete, 'Teardown');

    const frameworkLogs = new logs.LogGroup(this, 'ProviderLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: TEARDOWN_POLL.queryInterval,
      totalTimeout: TEARDOWN_POLL.totalTimeout,
      logGroup: frameworkLogs,
      disableWaiterStateMachineLogging: false,
      waiterStateMachineLogOptions: { destination: frameworkLogs, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    acknowledgeProviderFramework(provider, [onEvent, isComplete]);

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::TenantFrontDoorDedicatedDomainsTeardown',
      properties: { DistributionId: props.distributionId },
    });
  }
}

/** The CDK provider framework's own functions, roles and waiter state machine. */
function acknowledgeProviderFramework(provider: cr.Provider, handlers: readonly lambda.IFunction[]): void {
  const reason = 'CDK\'s custom resource provider framework, which runs only at deploy and delete and calls the teardown\'s two functions (spec §6.2)';
  acknowledge(provider, BASIC_EXECUTION_ROLE_FINDING, `${reason}; logs-only managed policy (M-36).`);
  acknowledge(provider, 'AwsSolutions-L1', `${reason}; CDK pins the framework's runtime.`);
  acknowledge(provider, 'AwsSolutions-SF2', `${reason}; the waiter only polls isComplete, and its executions are logged at ALL without data.`);
  acknowledge(
    provider.node.findChild('waiter-state-machine'),
    'AwsSolutions-IAM5[Resource::*]',
    `${reason}; the waiter's execution logging needs the CloudWatch Logs delivery actions, which take no resource ARN.`,
  );
  // grantInvoke covers each function and its versions.
  const framework = ['framework-isComplete', 'framework-onTimeout'].map((id) => provider.node.findChild(id) as lambda.IFunction);
  for (const fn of [...handlers, ...framework]) {
    acknowledge(
      provider,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(provider, `${fn.functionArn}:*`)}]`,
      `${reason}; CDK grants lambda:InvokeFunction on the function and its versions.`,
    );
  }
}
