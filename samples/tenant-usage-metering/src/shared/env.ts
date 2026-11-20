// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The environment every function reads its configuration from. The names
 * are the contract between the construct (which sets them) and the
 * functions (which read them); both import this module.
 */

export const ENV = {
  fleetName: 'METERING_FLEET_NAME',
  tableName: 'METERING_TABLE_NAME',
  rawBucket: 'METERING_RAW_BUCKET',
  exportBucket: 'METERING_EXPORT_BUCKET',
  ingestPath: 'METERING_INGEST_PATH',
  ingestBusArn: 'METERING_INGEST_BUS_ARN',
  usageBusArn: 'METERING_USAGE_BUS_ARN',
  firehoseStreamName: 'METERING_FIREHOSE_STREAM',
  ingestDlqUrl: 'METERING_INGEST_DLQ_URL',
  deliveryQueueUrl: 'METERING_DELIVERY_QUEUE_URL',
  trackerFailureQueueUrl: 'METERING_TRACKER_FAILURE_QUEUE_URL',
  recounterArn: 'METERING_RECOUNTER_ARN',
  jobsFunction: 'METERING_JOBS_FUNCTION',
  readmissionFunction: 'METERING_READMISSION_FUNCTION',
  redriveFunction: 'METERING_REDRIVE_FUNCTION',
  registrarArns: 'METERING_REGISTRAR_ARNS',
  operatorArns: 'METERING_OPERATOR_ARNS',
  readerArns: 'METERING_READER_ARNS',
  blockedAccounts: 'METERING_BLOCKED_ACCOUNTS',
  lateGraceMinutes: 'METERING_LATE_GRACE_MINUTES',
  recountWindowHours: 'METERING_RECOUNT_WINDOW_HOURS',
  closeGraceMinutes: 'METERING_CLOSE_GRACE_MINUTES',
  maxEventsPerEmitterPerMinute: 'METERING_MAX_EVENTS_PER_EMITTER_PER_MINUTE',
  maxRefusedPerEmitterPerHour: 'METERING_MAX_REFUSED_PER_EMITTER_PER_HOUR',
  metricNamespace: 'METERING_METRIC_NAMESPACE',
} as const;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`environment variable ${name} is not set`);
  }
  return value;
}

export function requireIntEnv(name: string): number {
  const value = Number(requireEnv(name));
  if (!Number.isInteger(value)) {
    throw new Error(`environment variable ${name} is not an integer`);
  }
  return value;
}

export function listEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').filter((value) => value.length > 0);
}
