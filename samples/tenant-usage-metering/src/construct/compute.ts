// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The functions, queues, schedules and the recounter state machine (spec
 * §3.1), each function under its own role from src/construct/roles.ts with
 * the grants it needs and no more.
 */

import { ArnFormat, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { createFunction } from './functions';
import type { Pipeline } from './pipeline';
import type { ResolvedProps } from './props';
import type { ServiceRoles } from './roles';
import { ERROR_PREFIX, FIREHOSE_ERROR_PREFIX, RAW_PREFIX, READMITTED_PREFIX } from './storage';
import { ENV } from '../shared/env';

/** The recounter's execution timeout, below the 30-minute lease (spec §4.5). */
export const RECOUNT_EXECUTION_TIMEOUT = Duration.minutes(25);
/** Reserved concurrency of the ingest function (spec §3.2). */
export const INGEST_RESERVED_CONCURRENCY = 25;
/** The dispatcher's visibility timeout: six times its function timeout. */
const DISPATCHER_TIMEOUT = Duration.seconds(30);

export interface ComputeProps {
  readonly config: ResolvedProps;
  readonly roles: ServiceRoles;
  readonly table: dynamodb.TableV2;
  readonly rawBucket: s3.Bucket;
  readonly exportBucket: s3.Bucket;
  readonly pipeline: Pipeline;
  readonly firehoseStreamName: string;
  readonly scheduleGroupName: string;
  readonly metricNamespace: string;
}

export interface Compute {
  readonly ingestFn: NodejsFunction;
  readonly adminFn: NodejsFunction;
  readonly jobsFn: NodejsFunction;
  readonly readmissionFn: NodejsFunction;
  readonly redriveFn: NodejsFunction;
  readonly trackerFn: NodejsFunction;
  readonly recountFn: NodejsFunction;
  readonly schedulerFn: NodejsFunction;
  readonly publisherFn: NodejsFunction;
  readonly dispatcherFn: NodejsFunction;
  readonly recounter: sfn.StateMachine;
  readonly trackerFailureQueue: sqs.Queue;
  readonly publisherFailureQueue: sqs.Queue;
  readonly deliveryQueue: sqs.Queue;
  readonly deliveryDeadLetterQueue: sqs.Queue;
}

function queue(scope: Construct, id: string, props: sqs.QueueProps = {}): sqs.Queue {
  return new sqs.Queue(scope, id, {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
    ...props,
  });
}

export function createCompute(scope: Construct, props: ComputeProps): Compute {
  const stack = Stack.of(scope);
  const { config, roles, table, rawBucket, exportBucket, pipeline } = props;
  const logRetention = logs.RetentionDays.ONE_MONTH;

  // Queues -------------------------------------------------------------------
  const trackerFailureQueue = queue(scope, 'TrackerFailureQueue');
  const publisherFailureQueue = queue(scope, 'PublisherFailureQueue');
  const deliveryDeadLetterQueue = queue(scope, 'DeliveryDeadLetterQueue');
  const deliveryQueue = queue(scope, 'DeliveryQueue', {
    retentionPeriod: Duration.days(4),
    visibilityTimeout: Duration.seconds(DISPATCHER_TIMEOUT.toSeconds() * 6),
    // Retries are the dispatcher's (24 h, spec §4.7); the queue's DLQ only catches a delivery the code never settles.
    deadLetterQueue: { queue: deliveryDeadLetterQueue, maxReceiveCount: 200 },
  });
  for (const dlq of [trackerFailureQueue, publisherFailureQueue, deliveryDeadLetterQueue]) {
    Validations.of(dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is itself a failure destination or dead-letter queue, with an alarm on its depth.',
    });
  }

  // Environment ----------------------------------------------------------------
  const base: Record<string, string> = {
    [ENV.tableName]: table.tableName,
    [ENV.fleetName]: config.fleetName,
    [ENV.metricNamespace]: props.metricNamespace,
    [ENV.recountWindowHours]: String(config.recountWindowHours),
  };
  const fn = (
    id: string,
    entry: string,
    role: iam.Role,
    timeout: Duration,
    environment: Record<string, string>,
    extra: Partial<Parameters<typeof createFunction>[2]> = {},
  ) =>
    createFunction(scope, id, {
      entry,
      role,
      timeout,
      environment: { ...base, ...environment },
      logRetention,
      description: `tenant-usage-metering ${id}`,
      ...extra,
    });

  const ingestFn = fn(
    'IngestFunction',
    'ingest/ingest.function.ts',
    roles.ingest,
    Duration.seconds(30),
    {
      [ENV.rawBucket]: rawBucket.bucketName,
      [ENV.ingestPath]: config.ingestPath,
      ...(pipeline.ingestBusArn !== undefined ? { [ENV.ingestBusArn]: pipeline.ingestBusArn } : {}),
      [ENV.firehoseStreamName]: props.firehoseStreamName,
      [ENV.maxEventsPerEmitterPerMinute]: String(config.maxEventsPerEmitterPerMinute),
      [ENV.maxRefusedPerEmitterPerHour]: String(config.maxRefusedPerEmitterPerHour),
    },
    { memorySize: 512, reservedConcurrentExecutions: INGEST_RESERVED_CONCURRENCY },
  );

  const jobsEnv = { [ENV.deliveryQueueUrl]: deliveryQueue.queueUrl };
  const jobsFn = fn('JobsFunction', 'jobs/jobs.function.ts', roles.jobs, Duration.minutes(15), jobsEnv);
  const readmissionFn = fn(
    'ReadmissionFunction',
    'jobs/jobs.function.ts',
    roles.readmission,
    Duration.minutes(15),
    { [ENV.rawBucket]: rawBucket.bucketName },
    {
      handler: 'readmissionHandler',
      memorySize: 1024,
    },
  );
  const redriveFn = fn(
    'RedriveFunction',
    'jobs/jobs.function.ts',
    roles.redrive,
    Duration.minutes(15),
    {
      [ENV.rawBucket]: rawBucket.bucketName,
      [ENV.firehoseStreamName]: props.firehoseStreamName,
      ...(pipeline.ingestDeadLetterQueue !== undefined ? { [ENV.ingestDlqUrl]: pipeline.ingestDeadLetterQueue.queueUrl } : {}),
    },
    { handler: 'redriveHandler' },
  );

  const blocked = [
    ...(config.testOnlyAllowCellsInMeteringAccount ? [] : [stack.account]),
    ...config.rawSubscriberAccountIds,
    ...config.usageSubscriberAccountIds,
  ];
  const adminFn = fn('AdminFunction', 'api/handler.ts', roles.admin, Duration.seconds(30), {
    [ENV.closeGraceMinutes]: String(config.closeGraceMinutes),
    [ENV.blockedAccounts]: [...new Set(blocked)].join(','),
    [ENV.ingestPath]: config.ingestPath,
    [ENV.registrarArns]: config.registrarPrincipalArns.join(','),
    [ENV.operatorArns]: config.operatorPrincipalArns.join(','),
    [ENV.readerArns]: config.readerPrincipalArns.join(','),
    [ENV.jobsFunction]: jobsFn.functionName,
    [ENV.readmissionFunction]: readmissionFn.functionName,
    [ENV.redriveFunction]: redriveFn.functionName,
  });

  const trackerFn = fn('TrackerFunction', 'tracker/tracker.function.ts', roles.tracker, Duration.seconds(30), {});
  // 30 minutes of event age, well inside the jobs' 60-minute close guard (spec §4.5).
  trackerFn.configureAsyncInvoke({
    retryAttempts: 2,
    maxEventAge: Duration.minutes(30),
    onFailure: new destinations.SqsDestination(trackerFailureQueue),
  });

  const recountFn = fn(
    'RecountFunction',
    'recount/recount.function.ts',
    roles.recounter,
    Duration.minutes(15),
    {
      [ENV.rawBucket]: rawBucket.bucketName,
      [ENV.lateGraceMinutes]: String(config.lateGraceMinutes),
    },
    { memorySize: 3008 },
  );

  const publisherFn = fn('PublisherFunction', 'publisher/publisher.function.ts', roles.publisher, Duration.minutes(5), {
    [ENV.usageBusArn]: pipeline.usageBusArn,
    [ENV.deliveryQueueUrl]: deliveryQueue.queueUrl,
  });

  const dispatcherFn = fn('DispatcherFunction', 'dispatcher/dispatcher.function.ts', roles.dispatcher, DISPATCHER_TIMEOUT, {
    [ENV.exportBucket]: exportBucket.bucketName,
    [ENV.deliveryQueueUrl]: deliveryQueue.queueUrl,
  });

  // Recounter -------------------------------------------------------------------
  const countTask = new tasks.LambdaInvoke(scope, 'Count', {
    lambdaFunction: recountFn,
    payload: sfn.TaskInput.fromObject({
      step: 'count',
      hour: sfn.JsonPath.stringAt('$.hour'),
      lease: sfn.JsonPath.stringAt('$$.Execution.Name'),
    }),
    resultSelector: { 'outcome.$': '$.Payload.outcome' },
    retryOnServiceExceptions: true,
  });
  const failTask = new tasks.LambdaInvoke(scope, 'MarkFailed', {
    lambdaFunction: recountFn,
    payload: sfn.TaskInput.fromObject({
      step: 'fail',
      hour: sfn.JsonPath.stringAt('$$.Execution.Input.hour'),
      lease: sfn.JsonPath.stringAt('$$.Execution.Name'),
    }),
    retryOnServiceExceptions: true,
  });
  failTask.next(
    new sfn.Fail(scope, 'CountFailed', {
      error: 'CountFailed',
      cause: 'the count of the hour failed; the scheduler retries it with backoff',
    }),
  );
  countTask.addCatch(failTask, { resultPath: sfn.JsonPath.DISCARD });
  const recounterLogs = new logs.LogGroup(scope, 'RecounterLogs', { retention: logRetention, removalPolicy: RemovalPolicy.DESTROY });
  const recounter = new sfn.StateMachine(scope, 'Recounter', {
    definitionBody: sfn.DefinitionBody.fromChainable(countTask.next(new sfn.Succeed(scope, 'Done'))),
    stateMachineType: sfn.StateMachineType.STANDARD,
    timeout: RECOUNT_EXECUTION_TIMEOUT,
    tracingEnabled: true,
    // Execution data is the hour and the outcome only (spec §3.5, Logs).
    logs: { destination: recounterLogs, level: sfn.LogLevel.ALL, includeExecutionData: false },
  });

  // Scheduler and the outbox sweep ------------------------------------------------
  const schedulerFn = fn('SchedulerFunction', 'scheduler/scheduler.function.ts', roles.scheduler, Duration.minutes(5), {
    [ENV.recounterArn]: recounter.stateMachineArn,
    [ENV.trackerFailureQueueUrl]: trackerFailureQueue.queueUrl,
    [ENV.lateGraceMinutes]: String(config.lateGraceMinutes),
  });
  const scheduleGroup = new scheduler.CfnScheduleGroup(scope, 'ScheduleGroup', { name: props.scheduleGroupName });
  for (const [id, target, input] of [
    ['Scheduler', schedulerFn, '{}'],
    ['OutboxSweep', publisherFn, '{"sweep":true}'],
  ] as const) {
    const schedule = new scheduler.CfnSchedule(scope, `${id}Schedule`, {
      groupName: props.scheduleGroupName,
      scheduleExpression: 'rate(5 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: target.functionArn,
        roleArn: roles.schedule.roleArn,
        input,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    schedule.addResourceDependency(scheduleGroup);
    target.grantInvoke(roles.schedule);
  }

  // Event sources -------------------------------------------------------------------
  publisherFn.addEventSource(
    new sources.DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      onFailure: new sources.SqsDlq(publisherFailureQueue),
      filters: [
        lambda.FilterCriteria.filter({
          dynamodb: { NewImage: { PK: { S: lambda.FilterRule.beginsWith('USAGE#') }, publishPending: { S: lambda.FilterRule.exists() } } },
        }),
      ],
    }),
  );
  dispatcherFn.addEventSource(
    new sources.SqsEventSource(deliveryQueue, { batchSize: 10, reportBatchItemFailures: true, maxConcurrency: 10 }),
  );
  for (const prefix of [RAW_PREFIX, READMITTED_PREFIX, FIREHOSE_ERROR_PREFIX]) {
    rawBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(trackerFn), { prefix });
  }

  // Grants -------------------------------------------------------------------------
  const tableItems = (role: iam.IRole, actions: string[]) => table.grant(role, ...actions.map((action) => `dynamodb:${action}`));
  const reads = ['GetItem', 'BatchGetItem', 'Query', 'ConditionCheckItem'];
  tableItems(roles.ingest, ['GetItem', 'Query', 'UpdateItem']);
  table.grantReadWriteData(roles.admin);
  // RECOUNT, SINK_REDRIVE and RESEND_BLOCKED read records, scan for failed
  // deliveries, and update records and the job item; they never put or delete.
  tableItems(roles.jobs, [...reads, 'Scan', 'UpdateItem']);
  tableItems(roles.readmission, [...reads, 'UpdateItem']);
  tableItems(roles.redrive, [...reads, 'UpdateItem']);
  tableItems(roles.tracker, ['GetItem', 'PutItem', 'UpdateItem']);
  tableItems(roles.recounter, [...reads, 'PutItem', 'UpdateItem']);
  tableItems(roles.scheduler, [...reads, 'PutItem', 'UpdateItem']);
  tableItems(roles.publisher, [...reads, 'UpdateItem']);
  tableItems(roles.dispatcher, [...reads, 'UpdateItem']);

  rawBucket.grantPut(roles.ingest, `${ERROR_PREFIX}*`);
  rawBucket.grantRead(roles.readmission, `${ERROR_PREFIX}*`);
  rawBucket.grantPut(roles.readmission, `${READMITTED_PREFIX}*`);
  rawBucket.grantPut(roles.readmission, `${ERROR_PREFIX}*`);
  rawBucket.grantPut(roles.redrive, `${ERROR_PREFIX}*`);
  rawBucket.grantRead(roles.recounter, `${RAW_PREFIX}*`);
  rawBucket.grantRead(roles.recounter, `${READMITTED_PREFIX}*`);
  exportBucket.grantPut(roles.dispatcher);

  const firehoseArn = stack.formatArn({ service: 'firehose', resource: 'deliverystream', resourceName: props.firehoseStreamName });
  for (const role of [roles.ingest, roles.redrive]) {
    role.addToPolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecordBatch'], resources: [firehoseArn] }));
  }
  pipeline.ingestDeadLetterQueue?.grantConsumeMessages(roles.redrive);
  for (const target of [jobsFn, readmissionFn, redriveFn]) {
    target.grantInvoke(roles.admin);
  }
  deliveryQueue.grantSendMessages(roles.jobs);
  deliveryQueue.grantSendMessages(roles.publisher);
  trackerFailureQueue.grantConsumeMessages(roles.scheduler);
  recounter.grantStartExecution(roles.scheduler);
  roles.dispatcher.addToPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${config.fleetName}/metering/sinks/*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );

  return {
    ingestFn,
    adminFn,
    jobsFn,
    readmissionFn,
    redriveFn,
    trackerFn,
    recountFn,
    schedulerFn,
    publisherFn,
    dispatcherFn,
    recounter,
    trackerFailureQueue,
    publisherFailureQueue,
    deliveryQueue,
    deliveryDeadLetterQueue,
  };
}
