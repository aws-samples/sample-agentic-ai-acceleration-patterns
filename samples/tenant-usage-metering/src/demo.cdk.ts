// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack: one `TenantUsageMetering` with stand-in roles the
 * integration test assumes until the control plane's hooks are released
 * (spec §6.4): a registrar, an operator and a reader. Every role trusts only
 * this account, and a principal there needs `sts:AssumeRole` on it.
 *
 * With `integLocalCell=true` (test only, standard §5.3) the stack also holds
 * one cell's emitter role, `<fleet>-ue-<cellId>`, and lets that cell be
 * registered in this account, so a one-account test can send usage.
 *
 * The stack writes the published parameter
 * `/application-plane/shared/metering/service` (spec §6.3).
 */

import { Aws, CfnOutput, Fn, RemovalPolicy, Stack, type StackProps, Validations } from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ADMIN_ROUTES } from './api/routes';
import { STAGE_NAME } from './construct/api';
import { createFunction } from './construct/functions';
import type { IngestPath } from './construct/props';
import { emitterRoleName } from './shared/identity';
import { acknowledgeWildcards } from './shared/nag';
import { UsageSubscriber } from './subscriber/usage-subscriber';
import { TenantUsageMetering } from './tenant-usage-metering';

/** The cell id of the test emitter (a fixed ULID). */
export const DEMO_CELL_ID = '01JD00000000000000000000C1';

export const SERVICE_PARAMETER = '/application-plane/shared/metering/service';

export interface DemoContext {
  readonly fleetName: string;
  readonly ingestPath: IngestPath;
  readonly rawRetentionDays?: number;
  readonly lateGraceMinutes?: number;
  readonly integLocalCell: boolean;
  /** Write the published parameter; off for a second demo stack in the same account. */
  readonly publishServiceParameter: boolean;
  /** TEST ONLY: a public stand-in billing API for the HTTP sink (needs integLocalCell). */
  readonly integHttpReceiver: boolean;
}

export function parseDemoContext(get: (key: string) => unknown): DemoContext {
  const fleetName = (get('fleetName') as string | undefined) ?? 'demo';
  const ingestPath = ((get('ingestPath') as string | undefined) ?? 'BUS') as IngestPath;
  const retention = get('rawRetentionDays') as string | number | undefined;
  const grace = get('lateGraceMinutes') as string | number | undefined;
  return {
    fleetName,
    ingestPath,
    ...(retention !== undefined ? { rawRetentionDays: Number(retention) } : {}),
    ...(grace !== undefined ? { lateGraceMinutes: Number(grace) } : {}),
    integLocalCell: String(get('integLocalCell') ?? 'false') === 'true',
    publishServiceParameter: String(get('publishServiceParameter') ?? 'true') === 'true',
    integHttpReceiver: String(get('integHttpReceiver') ?? 'false') === 'true',
  };
}

export interface DemoStackProps extends StackProps {
  readonly context: DemoContext;
}

export class TenantUsageMeteringDemoStack extends Stack {
  public readonly metering: TenantUsageMetering;

  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    const account = new iam.AccountPrincipal(this.account);
    const role = (roleId: string, description: string) => new iam.Role(this, roleId, { assumedBy: account, description });
    const registrar = role('DemoRegistrar', 'Stand-in for the control plane global hook (spec §6.4)');
    const operator = role('DemoOperator', 'Metering operator for the integration test');
    const reader = role('DemoReader', 'Usage reader for the integration test');

    this.metering = new TenantUsageMetering(this, 'Metering', {
      fleetName: props.context.fleetName,
      ingestPath: props.context.ingestPath,
      registrarPrincipalArns: [registrar.roleArn],
      operatorPrincipalArns: [operator.roleArn],
      readerPrincipalArns: [reader.roleArn],
      ...(props.context.rawRetentionDays !== undefined ? { rawRetentionDays: props.context.rawRetentionDays } : {}),
      ...(props.context.lateGraceMinutes !== undefined ? { lateGraceMinutes: props.context.lateGraceMinutes } : {}),
      testOnlyAllowCellsInMeteringAccount: props.context.integLocalCell,
    });

    // The callers' own side of the grant (spec §6.1): an identity policy for each.
    registrar.addToPolicy(this.metering.registrarStatement);
    for (const [caller, cls] of [
      [operator, 'operator'],
      [reader, 'reader'],
    ] as const) {
      const routes = ADMIN_ROUTES.filter((route) => route.callers.includes(cls));
      caller.addToPolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: routes.map((route) =>
            this.metering.api.arnForExecuteApi(route.method, route.path.replace(/\{[^}]+\}/g, '*'), STAGE_NAME),
          ),
        }),
      );
    }

    if (props.context.integLocalCell) {
      const emitter = new iam.Role(this, 'DemoCellEmitter', {
        roleName: emitterRoleName(props.context.fleetName, DEMO_CELL_ID),
        assumedBy: account,
        description: 'TEST ONLY: the emitter role of one cell, in the metering account (spec §6.1)',
      });
      emitter.addToPolicy(this.metering.ingestStatement);
      new CfnOutput(this, 'EmitterRoleArn', { value: emitter.roleArn });
      new CfnOutput(this, 'CellId', { value: DEMO_CELL_ID });
      // TEST ONLY: the credential of the integration test's HTTP sink.
      // Named per stack create: a deleted secret keeps its name for its recovery
      // window, so a fixed name would fail the next run's create.
      const runId = Fn.select(2, Fn.split('/', Aws.STACK_ID));
      const sinkSecretName = `${props.context.fleetName}/metering/sinks/integ-${runId}`;
      const sinkSecret = new secretsmanager.Secret(this, 'DemoHttpSinkSecret', {
        secretName: sinkSecretName,
        // A header-safe value: the dispatcher sends it as `Authorization: Bearer <value>`.
        generateSecretString: { excludePunctuation: true, passwordLength: 40 },
        description: 'TEST ONLY: credential of the integration test HTTP sink',
        removalPolicy: RemovalPolicy.DESTROY,
      });
      Validations.of(sinkSecret).acknowledge({
        id: 'AwsSolutions-SMG4',
        reason: 'A test-only credential that lives for one integration run.',
      });
      new CfnOutput(this, 'HttpSinkSecretName', { value: sinkSecretName });

      if (props.context.integHttpReceiver) {
        // TEST ONLY: a stand-in billing API behind an AWS_IAM function URL, the
        // target of an `auth: AWS_IAM` sink. Only the dispatcher's role is
        // granted invoke (an identity grant, so the function has no resource
        // policy); an unsigned call is refused by Lambda before the code runs.
        // It stores nothing and runs at most two at a time
        // (src/test-aid/http-receiver.function.ts).
        const receiverRole = new iam.Role(this, 'DemoHttpReceiverRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          description: 'TEST ONLY: the integration test HTTP sink receiver',
        });
        const receiver = createFunction(this, 'DemoHttpReceiver', {
          entry: 'test-aid/http-receiver.function.ts',
          role: receiverRole,
          timeout: Duration.seconds(5),
          environment: {},
          logRetention: logs.RetentionDays.ONE_WEEK,
          description: 'TEST ONLY: stand-in billing API for the HTTP sink',
          reservedConcurrentExecutions: 2,
        });
        const url = receiver.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
        receiver.grantInvokeUrl(this.metering.roles.dispatcher);
        new CfnOutput(this, 'HttpReceiverUrl', { value: url.url });
        new CfnOutput(this, 'HttpReceiverLogGroup', { value: receiver.logGroup.logGroupName });
      }
    }

    // A reader of the usage bus (ADR-0006): UsageRecorded records of one
    // meter into a queue, the way a billing system would subscribe.
    const usageQueue = new sqs.Queue(this, 'DemoUsageQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
    });
    Validations.of(usageQueue).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'The demo reader queue is the target of a UsageSubscriber, whose own dead-letter queue catches failed deliveries (ADR-0006).',
    });
    const deliveryRole = new iam.Role(this, 'DemoUsageReaderRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'Delivers UsageRecorded to the demo reader queue',
    });
    usageQueue.grantSendMessages(deliveryRole);
    const filtered = new UsageSubscriber(this, 'DemoUsageReader', {
      busArn: this.metering.usageBusArn,
      stream: 'usage',
      targetArn: usageQueue.queueArn,
      role: deliveryRole,
      meters: ['agent.tokens'],
    });
    new CfnOutput(this, 'UsageQueueUrl', { value: usageQueue.queueUrl });
    new CfnOutput(this, 'UsageReaderDlqUrl', { value: filtered.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'UsageReaderArn', { value: filtered.subscriber.attrSubscriberArn });

    // A second reader with no filter: every UsageRecorded.
    const allQueue = new sqs.Queue(this, 'DemoUsageAllQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
    });
    Validations.of(allQueue).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'The demo reader queue is the target of a UsageSubscriber, whose own dead-letter queue catches failed deliveries (ADR-0006).',
    });
    const allRole = new iam.Role(this, 'DemoUsageAllReaderRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'Delivers every UsageRecorded to the second demo reader queue',
    });
    allQueue.grantSendMessages(allRole);
    const unfiltered = new UsageSubscriber(this, 'DemoUsageAllReader', {
      busArn: this.metering.usageBusArn,
      targetArn: allQueue.queueArn,
      role: allRole,
    });
    new CfnOutput(this, 'UsageAllQueueUrl', { value: allQueue.queueUrl });
    new CfnOutput(this, 'UsageAllReaderDlqUrl', { value: unfiltered.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'UsageAllReaderArn', { value: unfiltered.subscriber.attrSubscriberArn });

    acknowledgeWildcards(this, (path) =>
      /\/Demo[A-Za-z]+\/DefaultPolicy\//.test(path)
        ? 'The stand-in callers invoke API routes whose labels (cell, tenant) are chosen at run time; the API resource policy narrows each route to its callers (spec §3.2).'
        : undefined,
    );

    if (props.context.publishServiceParameter) {
      new ssm.StringParameter(this, 'ServiceParameter', {
        parameterName: SERVICE_PARAMETER,
        description: 'tenant-usage-metering: the metering service (spec §6.3)',
        stringValue: Stack.of(this).toJsonString({
          version: 1,
          apiUrl: this.metering.apiUrl,
          region: this.region,
          ingestBusArn: this.metering.ingestBusArn ?? '',
          usageBusArn: this.metering.usageBusArn,
          emitterRoleNamePattern: this.metering.emitterRoleNamePattern,
        }),
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.metering.apiUrl });
    new CfnOutput(this, 'UsageBusArn', { value: this.metering.usageBusArn });
    if (this.metering.ingestBusArn !== undefined) {
      new CfnOutput(this, 'IngestBusArn', { value: this.metering.ingestBusArn });
    }
    new CfnOutput(this, 'RawBucketName', { value: this.metering.rawBucket.bucketName });
    new CfnOutput(this, 'ExportBucketName', { value: this.metering.exportBucket.bucketName });
    new CfnOutput(this, 'TableName', { value: this.metering.table.tableName });
    new CfnOutput(this, 'RegistrarRoleArn', { value: registrar.roleArn });
    new CfnOutput(this, 'OperatorRoleArn', { value: operator.roleArn });
    new CfnOutput(this, 'ReaderRoleArn', { value: reader.roleArn });
  }
}
