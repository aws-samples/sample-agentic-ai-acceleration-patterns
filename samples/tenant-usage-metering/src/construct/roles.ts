// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stack's own roles, created first because the explicit-deny resource
 * policies of spec §3.5 name them: a write that does not come from one of
 * these is denied whatever an identity policy in the account allows. The
 * functions and the state machine attach to them as they are built; each
 * role's grants are added next to the resource it reaches.
 *
 * Service trust is conditioned on `aws:SourceAccount`, and on `aws:SourceArn`
 * where the source's ARN is known before it exists (spec §3.5, M-26).
 */

import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ServiceRoles {
  /** The ingest function: `PutUsageEvents` (spec §3.1). */
  readonly ingest: iam.Role;
  /** The admin function: every other route. */
  readonly admin: iam.Role;
  /** `RECOUNT`, `SINK_REDRIVE` and `RESEND_BLOCKED` jobs. */
  readonly jobs: iam.Role;
  /** `READMIT` jobs: writes `readmitted/` and `error/`. */
  readonly readmission: iam.Role;
  /** `INGEST_REDRIVE` jobs: moves the dead-letter queue into Firehose. */
  readonly redrive: iam.Role;
  /** The object tracker: hour items and their generation. */
  readonly tracker: iam.Role;
  /** The recounter's task function: reads the hour's objects, writes its records. */
  readonly recounter: iam.Role;
  /** The record publisher, which also runs the `publishPending` sweep. */
  readonly publisher: iam.Role;
  /** The sink dispatcher. */
  readonly dispatcher: iam.Role;
  /** The scheduler function, started by EventBridge Scheduler. */
  readonly scheduler: iam.Role;
  /** EventBridge Scheduler's role that invokes the scheduler function. */
  readonly schedule: iam.Role;
  /** Firehose's delivery role into the raw bucket. */
  readonly firehose: iam.Role;
  /** The ingest bus subscriber's delivery role into Firehose. */
  readonly subscriber: iam.Role;
}

/** The roles that write the table (the DynamoDB resource policy's allow-list). */
export function tableWriters(roles: ServiceRoles): iam.Role[] {
  return [
    roles.ingest,
    roles.admin,
    roles.jobs,
    roles.readmission,
    roles.redrive,
    roles.tracker,
    roles.recounter,
    roles.publisher,
    roles.dispatcher,
    roles.scheduler,
  ];
}

/** The names the deny policies and trust conditions use. */
export interface RoleNames {
  readonly firehoseStreamName: string;
  readonly ingestSubscriberName: string;
  /**
   * The stack's own EventBridge Scheduler schedule group. Scheduler sets
   * `aws:SourceArn` to the schedule group, not the schedule, when it assumes
   * its role (verified in a test account, 2026-11-18: a schedule ARN is refused).
   */
  readonly scheduleGroupName: string;
}

export function createServiceRoles(scope: Construct, names: RoleNames): ServiceRoles {
  const stack = Stack.of(scope);
  const lambdaRole = (id: string, description: string): iam.Role =>
    new iam.Role(scope, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description,
    });
  const sourceAccount = { StringEquals: { 'aws:SourceAccount': stack.account } };

  return {
    ingest: lambdaRole('IngestRole', 'tenant-usage-metering ingest function (spec §3.1)'),
    admin: lambdaRole('AdminRole', 'tenant-usage-metering admin function (spec §3.1)'),
    jobs: lambdaRole('JobsRole', 'tenant-usage-metering RECOUNT, SINK_REDRIVE and RESEND_BLOCKED jobs (spec §4.6)'),
    readmission: lambdaRole('ReadmissionRole', 'tenant-usage-metering READMIT jobs (spec §4.6)'),
    redrive: lambdaRole('RedriveRole', 'tenant-usage-metering INGEST_REDRIVE jobs (spec §3.1)'),
    tracker: lambdaRole('TrackerRole', 'tenant-usage-metering object tracker (spec §4.5)'),
    publisher: lambdaRole('PublisherRole', 'tenant-usage-metering record publisher and outbox sweep (spec §4.7)'),
    dispatcher: lambdaRole('DispatcherRole', 'tenant-usage-metering sink dispatcher (spec §4.7)'),
    scheduler: lambdaRole('SchedulerRole', 'tenant-usage-metering scheduler function (spec §4.5)'),
    // The state machine has its own role, which may only invoke this task's function.
    recounter: lambdaRole('RecounterRole', 'tenant-usage-metering recount task (spec §4.9)'),
    schedule: new iam.Role(scope, 'ScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          ...sourceAccount,
          ArnEquals: { 'aws:SourceArn': stack.formatArn({ service: 'scheduler', resource: 'schedule-group', resourceName: names.scheduleGroupName }) },
        },
      }),
      description: 'tenant-usage-metering EventBridge Scheduler (spec §3.1)',
    }),
    firehose: new iam.Role(scope, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', {
        conditions: {
          ...sourceAccount,
          ArnEquals: { 'aws:SourceArn': stack.formatArn({ service: 'firehose', resource: 'deliverystream', resourceName: names.firehoseStreamName }) },
        },
      }),
      description: 'tenant-usage-metering Firehose delivery into the raw bucket (spec §3.5)',
    }),
    subscriber: new iam.Role(scope, 'IngestSubscriberRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com', {
        conditions: {
          ...sourceAccount,
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'events', resource: 'subscriber', resourceName: `${names.ingestSubscriberName}/*` }) },
        },
      }),
      description: 'tenant-usage-metering ingest bus subscriber into Firehose (ADR-0002)',
    }),
  };
}
