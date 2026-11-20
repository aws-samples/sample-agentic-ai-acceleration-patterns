// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The single source of the Lambda environment variable names and of the
 * registry table's key and attribute names (spec §3.3, §3.4, §3.6, §3.8,
 * §4.1). The construct sets the variables and every handler reads them
 * through these constants, so a name is spelled once. No aws-cdk-lib import:
 * this file also runs inside the Lambda functions.
 *
 * Values are strings. Durations are whole milliseconds, booleans are
 * `'true'` or `'false'`, lists are comma-separated.
 */

/** Variables the core construct sets on every function it deploys (tool, reaper, drain, offboard, bound functions). */
export const ENV = {
  /** Registry table name (spec §4.1). */
  REGISTRY_TABLE: 'REGISTRY_TABLE',
  /** Input bucket name (`inputs/<tenant>/`, `outputs/<tenant>/`, spec §4.2). */
  INPUT_BUCKET: 'INPUT_BUCKET',
  /** Enabled backends, comma-separated (`microvm,nitro,agentcore`). */
  BACKENDS: 'BACKENDS',
  /** The backend used when a call names none. */
  DEFAULT_BACKEND: 'DEFAULT_BACKEND',
  /** ARN of the tool tenant role the tool assumes with a `TenantId` session tag (spec §3.2). */
  TOOL_TENANT_ROLE_ARN: 'TOOL_TENANT_ROLE_ARN',
  /** `runTimeout` in ms (spec §3.3). */
  RUN_TIMEOUT_MS: 'RUN_TIMEOUT_MS',
  /** `startWait` in ms. */
  START_WAIT_MS: 'START_WAIT_MS',
  /** `maxOutputBytes`: stdout and stderr together. */
  MAX_OUTPUT_BYTES: 'MAX_OUTPUT_BYTES',
  /** `maxInputBytes`: larger inputs are refused before any sandbox starts. */
  MAX_INPUT_BYTES: 'MAX_INPUT_BYTES',
  /** `sandboxIdle` in ms. */
  SANDBOX_IDLE_MS: 'SANDBOX_IDLE_MS',
  /** `sandboxMaxLife` in ms. */
  SANDBOX_MAX_LIFE_MS: 'SANDBOX_MAX_LIFE_MS',
  /** `'true'` with `perTenantMetrics`: the tool also writes EMF metrics (spec §3.8, ADR-0013). */
  PER_TENANT_METRICS: 'PER_TENANT_METRICS',
} as const;

/**
 * Variables a backend's `BackendConstruct.environment()` sets for its own
 * run-time class (spec §3.4). Listed here so the names are spelled once;
 * a backend sets only its own.
 */
export const BACKEND_ENV = {
  /** `microvm`: ARN of the MicroVM image. */
  MICROVM_IMAGE_ARN: 'MICROVM_IMAGE_ARN',
  /** `microvm`: ARN of the VPC egress connector (the only egress connector a start may pass). */
  MICROVM_NETWORK_CONNECTOR_ARN: 'MICROVM_NETWORK_CONNECTOR_ARN',
  /** `nitro`: ARN of the ECS cluster. */
  NITRO_CLUSTER_ARN: 'NITRO_CLUSTER_ARN',
  /** `nitro`: ARN of the pinned task definition revision (spec §4.1, never the family's latest). */
  NITRO_TASK_DEFINITION_ARN: 'NITRO_TASK_DEFINITION_ARN',
  /** `nitro`: name of the runner container in that task definition (for container overrides). */
  NITRO_CONTAINER_NAME: 'NITRO_CONTAINER_NAME',
  /** `nitro`: sandbox subnet ids, comma-separated. */
  NITRO_SUBNET_IDS: 'NITRO_SUBNET_IDS',
  /** `nitro`: the task security group id. */
  NITRO_SECURITY_GROUP_ID: 'NITRO_SECURITY_GROUP_ID',
  /** `agentcore`: ARN of the second AgentCore runtime. */
  AGENTCORE_RUNTIME_ARN: 'AGENTCORE_RUNTIME_ARN',
} as const;

/**
 * The integration test's hooks (spec §8 `max-life`, `failed-start`; ADR-0058, threat T-88). They are read by run-time
 * code only (the tool and the reaper) and set by nothing in the construct: the integration app sets the first two on the
 * functions of its own stack through a raw property override. Without `OVERRIDES` = `1` the reaper ignores
 * `maxLifeSeconds` in its event and the tool never passes `failAtBoot`.
 */
export const TEST_HOOKS = {
  /** `1` on a function: it honours the hooks below. */
  OVERRIDES: 'RC_INTEG_OVERRIDES',
  /** The one tenant whose sandboxes the tool starts with `failAtBoot`. */
  FAIL_START_TENANT: 'RC_INTEG_FAIL_START_TENANT',
  /** `nitro`: container override environment variable the runner reads (runner/PROTOCOL.md "Test hook"). */
  RUNNER_FAIL_AT_BOOT: 'RUNNER_FAIL_AT_BOOT',
  /** `microvm`: boolean field of the `run` hook payload (runner/PROTOCOL.md "Test hook"). */
  RUN_HOOK_FAIL_AT_BOOT: 'failAtBoot',
  /** The reaper event field that replaces `sandboxMaxLife` for one run, in seconds. */
  REAPER_MAX_LIFE_SECONDS: 'maxLifeSeconds',
} as const;

/** Every variable name above, for tests and for a handler that validates its environment. */
export const ALL_ENV_NAMES: readonly string[] = [...Object.values(ENV), ...Object.values(BACKEND_ENV)];

/** Registry key and attribute names (spec §4.1). */
export const REGISTRY = {
  /** Partition key attribute; value `TENANT#<tenantId>`. */
  PK: 'PK',
  /** Sort key attribute; value `SANDBOX#<backend>`. */
  SK: 'SK',
  HANDLE: 'handle',
  ADDRESS: 'address',
  NONCE: 'nonce',
  BOOT_ID: 'bootId',
  STATE: 'state',
  RETRY_AT: 'retryAt',
  CREATED_AT: 'createdAt',
  LAST_USED_AT: 'lastUsedAt',
  LEASE_UNTIL: 'leaseUntil',
  SUSPENDED_MS: 'suspendedMs',
  EXPIRES_AT: 'expiresAt',
  /** DynamoDB TTL attribute, epoch seconds (`expiresAt` + 1 h). */
  TTL_AT: 'ttlAt',
  VERSION: 'version',
} as const;

/** Value prefix of the partition key; the tool tenant role's `dynamodb:LeadingKeys` condition names it (spec §3.6). */
export const TENANT_KEY_PREFIX = 'TENANT#';
/** Value prefix of the sort key. */
export const SANDBOX_KEY_PREFIX = 'SANDBOX#';

/** Partition key value of a tenant's rows. */
export function registryPk(tenantId: string): string {
  return `${TENANT_KEY_PREFIX}${tenantId}`;
}

/** Sort key value of a tenant's row on one backend. */
export function registrySk(backend: string): string {
  return `${SANDBOX_KEY_PREFIX}${backend}`;
}

/** Task tag the `nitro` backend sets and the IAM conditions read (spec §3.6, ADR-0014). */
export const TENANT_TAG = 'TenantId';
