// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The hourly sweep (spec §8 "Sweep", M-11): an EventBridge schedule on the
 * default bus invoking the sweep function under `sweepRole`. The function
 * runs at most 15 minutes; a tenant population that needs longer is a
 * signal to shard the sweep, which the README names.
 */

import { Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { createFunction, type FunctionWithLogs } from './functions';

export interface SweepProps {
  readonly role: iam.Role;
  readonly environment: Record<string, string>;
  readonly logRetention: logs.RetentionDays;
}

export function createSweep(scope: Construct, props: SweepProps): FunctionWithLogs & { schedule: events.Rule } {
  const sweep = createFunction(scope, 'SweepFunction', {
    entry: 'sweep/handler.ts',
    role: props.role,
    timeout: Duration.minutes(15),
    memorySize: 512,
    environment: props.environment,
    logRetention: props.logRetention,
    description: 'tenant-encrypted-ingestion sweep: expiry, abandoned leases, owed events, REVOKED re-probe, inFlight (spec §8)',
  });
  const schedule = new events.Rule(scope, 'SweepSchedule', {
    description: 'tenant-encrypted-ingestion: hourly sweep (spec §8)',
    schedule: events.Schedule.rate(Duration.hours(1)),
    targets: [new targets.LambdaFunction(sweep.fn, { retryAttempts: 2 })],
  });
  return { ...sweep, schedule };
}
