// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Names shared by the construct (which writes them into function
 * environments and policies) and the runtime (which reads them). One place,
 * so a renamed variable or prefix cannot drift between the two sides.
 */

/** The session tag every tenant role is assumed with (spec P-2, ADR-0003). */
export const TENANT_TAG_KEY = 'TenantId';

/** The stack tag on every `vendor-key` key, for the drain's backstop (spec §6.2). */
export const STACK_TAG_KEY = 'tei:stack';

/** The drop and landed prefixes (spec §3.1). Both end in `/`. */
export const INGEST_PREFIX = 'ingest/';
export const DOCUMENTS_PREFIX = 'documents/';

/** The third key segment of a probe object, `ingest/<t>/_probe/<ulid>` (spec §8). */
export const PROBE_SEGMENT = '_probe';

/** `source` of every event the pipeline publishes (spec §5.4). */
export const EVENT_SOURCE = 'tenant-encrypted-ingestion';

/** The two scopes the sample registers with tenant-identity (spec §3.2). */
export const SCOPES = {
  deliver: 'ingestion/deliver',
  read: 'ingestion/read',
} as const;

/** The GSIs of the registry (spec §4, plus keyStatusIndex: see src/construct/registry.ts). */
export const OPEN_INDEX_NAME = 'statusBucket-urlExpiresAt';
export const KEY_STATUS_INDEX_NAME = 'keyStatus';

/** Environment variable names, one per value the runtime needs. */
export const ENV = {
  tableName: 'TEI_TABLE_NAME',
  bucketName: 'TEI_BUCKET_NAME',
  eventBusName: 'TEI_EVENT_BUS_NAME',
  tenantUploadRoleArn: 'TEI_TENANT_UPLOAD_ROLE_ARN',
  tenantProcessRoleArn: 'TEI_TENANT_PROCESS_ROLE_ARN',
  tenantPlatformRoleArn: 'TEI_TENANT_PLATFORM_ROLE_ARN',
  platformRoleArn: 'TEI_PLATFORM_ROLE_ARN',
  keyFactoryRoleArn: 'TEI_KEY_FACTORY_ROLE_ARN',
  consumerRoleArns: 'TEI_CONSUMER_ROLE_ARNS',
  allowTenantKeys: 'TEI_ALLOW_TENANT_KEYS',
  keyRotation: 'TEI_KEY_ROTATION',
  keyDeletionWindowDays: 'TEI_KEY_DELETION_WINDOW_DAYS',
  maxObjectSizeBytes: 'TEI_MAX_OBJECT_SIZE_BYTES',
  allowedContentTypes: 'TEI_ALLOWED_CONTENT_TYPES',
  uploadUrlTtlSeconds: 'TEI_UPLOAD_URL_TTL_SECONDS',
  maxInFlightPerTenant: 'TEI_MAX_IN_FLIGHT_PER_TENANT',
  tenantThrottle: 'TEI_TENANT_THROTTLE',
  usagePlanName: 'TEI_USAGE_PLAN_NAME',
  stackId: 'TEI_STACK_ID',
  validators: 'TEI_VALIDATORS',
  validatorObjectUrlTtlSeconds: 'TEI_VALIDATOR_OBJECT_URL_TTL_SECONDS',
  maxReceiveCount: 'TEI_MAX_RECEIVE_COUNT',
  visibilityTimeoutSeconds: 'TEI_VISIBILITY_TIMEOUT_SECONDS',
  processorTimeoutSeconds: 'TEI_PROCESSOR_TIMEOUT_SECONDS',
  abandonGraceSeconds: 'TEI_ABANDON_GRACE_SECONDS',
  perTenantMetrics: 'TEI_PER_TENANT_METRICS',
  discoveryUrl: 'TEI_DISCOVERY_URL',
  allowedClientIds: 'TEI_ALLOWED_CLIENT_IDS',
  metricsNamespace: 'TEI_METRICS_NAMESPACE',
  watchFailureQueueUrl: 'TEI_WATCH_FAILURE_QUEUE_URL',
} as const;

/** CloudWatch namespace of every metric the sample writes. */
export const METRICS_NAMESPACE = 'TenantEncryptedIngestion';

/** The registry watch's alarm metric (M-24). */
export const BINDING_CHANGE_METRIC = 'KeyBindingChanged';

/** Reads a required environment variable, failing loudly at cold start. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

/** Reads a required integer environment variable. */
export function requireIntEnv(name: string): number {
  const value = Number(requireEnv(name));
  if (!Number.isInteger(value)) {
    throw new Error(`environment variable ${name} is not an integer`);
  }
  return value;
}

/** Reads an optional boolean environment variable (`true` only counts). */
export function boolEnv(name: string): boolean {
  return process.env[name] === 'true';
}
