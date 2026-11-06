// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TenantEncryptedIngestion` (spec §3, §6; ADR-0012; standard §4.5): the
 * pattern as one construct. One bucket, API, pipeline and registry serve
 * every tenant; the tenant unit is the KMS key, the S3 prefix and the
 * registry partition.
 *
 * The construct takes its dependencies as props (the issuer, the consumer
 * roles, the validators, where to register scopes) and creates none of
 * them; it applies no cdk-nag aspect and carries its own acknowledgments,
 * so a consumer who applies cdk-nag sees the same result as the sample. It
 * publishes nothing to SSM: the demo stack publishes the read-only
 * properties as the sample's parameters (spec §6.3).
 */

import { Aws, CustomResource, Duration, Stack, Validations } from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as events from 'aws-cdk-lib/aws-events';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { createAccessLogBucket } from './construct/access-log-bucket';
import { createAlarms, type IngestionAlarms } from './construct/alarms';
import { createApi, usagePlanName } from './construct/api';
import { createIngestionBucket } from './construct/bucket';
import { addIngestionBucketPolicy } from './construct/bucket-policy';
import { addBusDeny, createDeliveryBus, createObjectCreatedRule } from './construct/events';
import { createFunction } from './construct/functions';
import { createTopTenantRules } from './construct/observability';
import { createProcessorFunction, processorTimeout } from './construct/pipeline';
import { addQueueDenies, createPipelineQueues } from './construct/queues';
import { createRegistryTable } from './construct/registry';
import { createRoles, type TenantRoles } from './construct/roles';
import { createSweep } from './construct/sweep';
import { createWatch, createWatchFailureQueue } from './construct/watch';
import { DEFAULT_ALLOWED_CONTENT_TYPES } from './processor/structural';
import { ENV, SCOPES } from './shared/constants';
import { LogDrain } from './shared/log-drain';
import { acknowledgeGranularFinding, acknowledgeWildcards } from './shared/nag';
import { type IdentityApiProps, ScopeRegistration } from './shared/scope-registration.cdk';
import { type IDeliveryValidator, VALIDATOR_NAME_PATTERN } from './validators/lambda-validator';

/** The issuer the token authoriser verifies (spec §3.3, ARCHITECTURE.md §2.1). */
export interface IdentityProps {
  /** OIDC discovery URL of the issuer. */
  readonly discoveryUrl: string;
  /** Accepted `client_id`s; at least one. */
  readonly allowedClientIds: string[];
}

/** Per-tenant throttling with one API key per tenant (N-8, ADR-0011). */
export interface TenantThrottleProps {
  readonly rateLimit: number;
  readonly burstLimit: number;
}

/** Deployment inputs (spec §3.3). Every option is off or secure unless set. */
export interface TenantEncryptedIngestionProps {
  readonly identity: IdentityProps;
  /** Where to register `ingestion/deliver` and `ingestion/read`. Default: tenant-identity's published parameters. */
  readonly identityApi?: IdentityApiProps;
  /** Enables `tenant-key`. Default false. */
  readonly allowTenantKeys?: boolean;
  /** May decrypt under `documents/<tenantId>/` (statement 2b). Fixed at key creation. Default none. */
  readonly consumerRoles?: iam.IRole[];
  /** Rotation on `vendor-key` keys. Default true. */
  readonly keyRotation?: boolean;
  /** 7..30. Default 7. */
  readonly keyDeletionWindowDays?: number;
  /** Larger is `TOO_LARGE`. Default 100 MiB. */
  readonly maxObjectSizeBytes?: number;
  /** Declared type and magic bytes. Default PDF, ZIP, PNG, JPEG, TIFF. */
  readonly allowedContentTypes?: string[];
  /** 60..3300. Default 900. */
  readonly uploadUrlTtlSeconds?: number;
  /** 1..10000. Default 100. */
  readonly maxInFlightPerTenant?: number;
  /** A per-tenant usage plan. Default off. */
  readonly tenantThrottle?: TenantThrottleProps;
  /** 1..7. Default 1. */
  readonly dropRetentionDays?: number;
  /** Custom validators, in order. Default none. */
  readonly validators?: IDeliveryValidator[];
  /** 60..900. Default 300. */
  readonly validatorObjectUrlTtlSeconds?: number;
  /** 1..10. Default 3. */
  readonly maxReceiveCount?: number;
  /** 2..12. Default 6. */
  readonly visibilityTimeoutFactor?: number;
  /** 60..86400. Default 3600. */
  readonly abandonGraceSeconds?: number;
  /** The queue's one other sender. Unset: no redrive. */
  readonly redriveOperatorRole?: iam.IRole;
  /** EMF per tenant. Default false. */
  readonly perTenantMetrics?: boolean;
  /** Every log group. Default one month. */
  readonly logRetention?: logs.RetentionDays;
  /** The access-log bucket's one reader. Default none. */
  readonly accessLogReaderRole?: iam.IRole;
}

/** The supported content types: the processor knows their magic bytes. */
export const SUPPORTED_CONTENT_TYPES: readonly string[] = DEFAULT_ALLOWED_CONTENT_TYPES;

export const DEFAULTS = {
  keyRotation: true,
  keyDeletionWindowDays: 7,
  maxObjectSizeBytes: 100 * 1024 * 1024,
  uploadUrlTtlSeconds: 900,
  maxInFlightPerTenant: 100,
  dropRetentionDays: 1,
  validatorObjectUrlTtlSeconds: 300,
  maxReceiveCount: 3,
  visibilityTimeoutFactor: 6,
  abandonGraceSeconds: 3600,
  logRetention: logs.RetentionDays.ONE_MONTH,
} as const;

/** S3's single PUT limit. */
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

function intInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`TenantEncryptedIngestion: ${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** The validated props with defaults applied. Exported for tests. */
export function resolveProps(props: TenantEncryptedIngestionProps) {
  if (props.identity === undefined || typeof props.identity.discoveryUrl !== 'string' || props.identity.discoveryUrl.length === 0) {
    throw new Error('TenantEncryptedIngestion: identity.discoveryUrl is required');
  }
  if (!Array.isArray(props.identity.allowedClientIds) || props.identity.allowedClientIds.length === 0) {
    throw new Error('TenantEncryptedIngestion: identity.allowedClientIds must name at least one client');
  }
  const allowedContentTypes = props.allowedContentTypes ?? [...DEFAULT_ALLOWED_CONTENT_TYPES];
  if (allowedContentTypes.length === 0 || allowedContentTypes.some((t) => !SUPPORTED_CONTENT_TYPES.includes(t))) {
    throw new Error(`TenantEncryptedIngestion: allowedContentTypes must be a non-empty subset of ${SUPPORTED_CONTENT_TYPES.join(', ')}`);
  }
  const validators = props.validators ?? [];
  const names = new Set<string>();
  for (const v of validators) {
    if (!VALIDATOR_NAME_PATTERN.test(v.name) || v.name === 'structural') {
      throw new Error(`TenantEncryptedIngestion: validators: name '${v.name}' must match ${VALIDATOR_NAME_PATTERN.source} and not be 'structural'`);
    }
    if (names.has(v.name)) {
      throw new Error(`TenantEncryptedIngestion: validators: name '${v.name}' is used twice`);
    }
    names.add(v.name);
    if (v.timeout.toSeconds() > 600) {
      throw new Error(`TenantEncryptedIngestion: validators: ${v.name} timeout must be at most 10 minutes`);
    }
  }
  if (props.tenantThrottle !== undefined) {
    const { rateLimit, burstLimit } = props.tenantThrottle;
    if (!(rateLimit > 0) || !Number.isInteger(burstLimit) || burstLimit < 1) {
      throw new Error('TenantEncryptedIngestion: tenantThrottle needs rateLimit > 0 and an integer burstLimit >= 1');
    }
  }
  return {
    identity: props.identity,
    identityApi: props.identityApi,
    allowTenantKeys: props.allowTenantKeys ?? false,
    consumerRoles: props.consumerRoles ?? [],
    keyRotation: props.keyRotation ?? DEFAULTS.keyRotation,
    keyDeletionWindowDays: intInRange('keyDeletionWindowDays', props.keyDeletionWindowDays ?? DEFAULTS.keyDeletionWindowDays, 7, 30),
    maxObjectSizeBytes: intInRange('maxObjectSizeBytes', props.maxObjectSizeBytes ?? DEFAULTS.maxObjectSizeBytes, 1, MAX_SINGLE_PUT_BYTES),
    allowedContentTypes,
    uploadUrlTtlSeconds: intInRange('uploadUrlTtlSeconds', props.uploadUrlTtlSeconds ?? DEFAULTS.uploadUrlTtlSeconds, 60, 3300),
    maxInFlightPerTenant: intInRange('maxInFlightPerTenant', props.maxInFlightPerTenant ?? DEFAULTS.maxInFlightPerTenant, 1, 10000),
    tenantThrottle: props.tenantThrottle,
    dropRetentionDays: intInRange('dropRetentionDays', props.dropRetentionDays ?? DEFAULTS.dropRetentionDays, 1, 7),
    validators,
    validatorObjectUrlTtlSeconds: intInRange(
      'validatorObjectUrlTtlSeconds',
      props.validatorObjectUrlTtlSeconds ?? DEFAULTS.validatorObjectUrlTtlSeconds,
      60,
      900,
    ),
    maxReceiveCount: intInRange('maxReceiveCount', props.maxReceiveCount ?? DEFAULTS.maxReceiveCount, 1, 10),
    visibilityTimeoutFactor: intInRange('visibilityTimeoutFactor', props.visibilityTimeoutFactor ?? DEFAULTS.visibilityTimeoutFactor, 2, 12),
    abandonGraceSeconds: intInRange('abandonGraceSeconds', props.abandonGraceSeconds ?? DEFAULTS.abandonGraceSeconds, 60, 86400),
    redriveOperatorRole: props.redriveOperatorRole,
    perTenantMetrics: props.perTenantMetrics ?? false,
    logRetention: props.logRetention ?? DEFAULTS.logRetention,
    accessLogReaderRole: props.accessLogReaderRole,
  };
}

const TENANT_ROLE_REASON =
  'The ABAC wall itself (M-12): S3 on <prefix>/${aws:PrincipalTag/TenantId}/*, and KMS keys of this Region in any account (tenant-key keys live in the tenant account) conditioned on aws:ResourceTag/TenantId = the session tag and kms:ViaService = S3; the key policy binds each key to the tenant prefixes (M-17).';

/** Why each role's wildcard is the narrowest expression of its §7.1 row. */
const WILDCARD_REASONS: Record<string, string> = {
  TenantUploadRole: TENANT_ROLE_REASON,
  TenantProcessRole: TENANT_ROLE_REASON,
  TenantPlatformRole: TENANT_ROLE_REASON,
  KeyFactoryRole:
    'kms:CreateKey and kms:TagResource accept no resource ARN and are conditioned on key spec, origin, usage, single-Region and the request tags (M-22); the alias pattern is alias/tenant-*-ingestion and this account\'s keys are usable only where the key policy names the role (M-17); API key routes are found at run time, a plan ARN here would be a cycle (M-5).',
  PlatformRole:
    'This account\'s keys and alias/tenant-*-ingestion, reachable only where the key policy names the role (M-17); kms:ListKeys has no resource ARN (the drain backstop, M-26); the registry GSIs (index/*); the tenant API keys, found by id at run time (M-5).',
  SweepRole: 'The registry GSIs (index/*) the sweep queries for open deliveries and key rows (spec §8).',
  WatchRole: 'cloudwatch:PutMetricData has no resource ARN and is conditioned on the sample namespace (M-24).',
  ProcessorRole: 'Granted by the SQS event source mapping on the one pipeline queue (spec §8).',
};

/** {@link TenantEncryptedIngestion.pipelineTiming}. */
export interface PipelineTiming {
  /** T. */
  readonly processorTimeoutSeconds: number;
  /** `visibilityTimeoutFactor` × T. */
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly abandonGraceSeconds: number;
  readonly uploadUrlTtlSeconds: number;
  readonly maxInFlightPerTenant: number;
}

/** The keys of {@link TenantEncryptedIngestion.logGroups}. */
export type IngestionLogGroupName =
  | 'authoriser'
  | 'tenantApi'
  | 'keyFactory'
  | 'platform'
  | 'processor'
  | 'sweep'
  | 'watch'
  | 'keyDrain'
  | 'apiAccess';

export class TenantEncryptedIngestion extends Construct {
  /** The ingestion bucket: `ingest/<tenantId>/` (drop), `documents/<tenantId>/` (landed). */
  readonly bucket: s3.Bucket;
  /** The separate SSE-S3 access-log bucket. */
  readonly accessLogBucket: s3.Bucket;
  /** The API's base URL (stage included, trailing slash). */
  readonly apiUrl: string;
  /** The REST API. */
  readonly api: apigateway.RestApi;
  /** The bus `Delivery*` events go to. */
  readonly eventBus: events.EventBus;
  /** The registry table. */
  readonly registryTable: dynamodb.Table;
  /** The pipeline queue. */
  readonly queue: sqs.Queue;
  /** The pipeline queue's DLQ. */
  readonly deadLetterQueue: sqs.Queue;
  readonly processorFunction: lambda.IFunction;
  readonly sweepFunction: lambda.IFunction;
  /** The three tenant roles. */
  readonly tenantRoles: TenantRoles;
  readonly platformRole: iam.IRole;
  readonly keyFactoryRole: iam.IRole;
  readonly sweepRole: iam.IRole;
  /** The ARNs of the consumer roles, as key policies name them. */
  readonly consumerRoleArns: string[];
  /** T, the processor timeout (spec §8). */
  readonly processorTimeout: Duration;
  /**
   * Every log group the construct writes, by writer: the functions and the
   * API access log (spec §3.4). The integration test scans them (§10 steps
   * 7b, 10).
   */
  readonly logGroups: Readonly<Record<IngestionLogGroupName, logs.ILogGroup>>;
  /** The names of the Contributor Insights top-tenant rules (P-9). */
  readonly contributorInsightRuleNames: string[];
  /** The resolved pipeline timings and limits (spec §8 "Timing"), in seconds. */
  readonly pipelineTiming: PipelineTiming;
  readonly alarms: IngestionAlarms;

  constructor(scope: Construct, id: string, props: TenantEncryptedIngestionProps) {
    super(scope, id);
    // Server access logs are delivered through the access-log bucket's
    // policy, not an ACL: the bucket keeps BucketOwnerEnforced (spec §7.4).
    // Set here, before any child exists, so it holds whatever the app sets.
    this.node.setContext('@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy', true);
    const p = resolveProps(props);
    const stack = Stack.of(this);
    const T = processorTimeout(p.validators);
    this.processorTimeout = T;
    this.pipelineTiming = {
      processorTimeoutSeconds: T.toSeconds(),
      visibilityTimeoutSeconds: T.toSeconds() * p.visibilityTimeoutFactor,
      maxReceiveCount: p.maxReceiveCount,
      abandonGraceSeconds: p.abandonGraceSeconds,
      uploadUrlTtlSeconds: p.uploadUrlTtlSeconds,
      maxInFlightPerTenant: p.maxInFlightPerTenant,
    };
    const visibility = Duration.seconds(T.toSeconds() * p.visibilityTimeoutFactor);
    this.consumerRoleArns = p.consumerRoles.map((r) => r.roleArn);

    // ---- data plane resources ------------------------------------------------
    this.accessLogBucket = createAccessLogBucket(this, 'AccessLogBucket', { dropRetentionDays: p.dropRetentionDays, readerRole: p.accessLogReaderRole });
    this.bucket = createIngestionBucket(this, 'Bucket', { accessLogBucket: this.accessLogBucket, dropRetentionDays: p.dropRetentionDays });
    this.registryTable = createRegistryTable(this, 'Registry');
    const queues = createPipelineQueues(this, { visibilityTimeout: visibility, maxReceiveCount: p.maxReceiveCount });
    this.queue = queues.queue;
    this.deadLetterQueue = queues.deadLetterQueue;
    this.eventBus = createDeliveryBus(this);
    const watchFailureQueue = createWatchFailureQueue(this);

    // ---- roles (spec §7.1) ---------------------------------------------------
    const { base, tenant } = createRoles(this, {
      bucketArn: this.bucket.bucketArn,
      tableArn: this.registryTable.tableArn,
      tableStreamArn: this.registryTable.tableStreamArn!,
      queueArn: this.queue.queueArn,
      eventBusArn: this.eventBus.eventBusArn,
      watchFailureQueueArn: watchFailureQueue.queueArn,
      tenantThrottle: p.tenantThrottle !== undefined,
    });
    this.tenantRoles = tenant;
    this.platformRole = base.platformRole;
    this.keyFactoryRole = base.keyFactoryRole;
    this.sweepRole = base.sweepRole;

    // ---- resource policies (spec §7.4, §7.7) ----------------------------------
    addIngestionBucketPolicy(this.bucket, {
      tenantRoles: tenant,
      maxSignatureAgeSeconds: Math.max(p.uploadUrlTtlSeconds, p.validatorObjectUrlTtlSeconds),
    });
    const rule = createObjectCreatedRule(this, { bucket: this.bucket, queue: this.queue, targetDeadLetterQueue: queues.targetDeadLetterQueue });
    addQueueDenies(queues, { ruleArn: rule.ruleArn, redriveOperatorRole: p.redriveOperatorRole });
    addBusDeny(this.eventBus, [base.processorRole, base.sweepRole]);

    // ---- functions -----------------------------------------------------------
    const common = { logRetention: p.logRetention };
    const tableEnv = { [ENV.tableName]: this.registryTable.tableName, [ENV.bucketName]: this.bucket.bucketName };
    const usagePlan = usagePlanName(this);

    const authoriser = createFunction(this, 'AuthoriserFunction', {
      ...common,
      entry: 'authoriser/handler.ts',
      role: base.authoriserRole,
      timeout: Duration.seconds(10),
      environment: {
        [ENV.discoveryUrl]: p.identity.discoveryUrl,
        [ENV.allowedClientIds]: p.identity.allowedClientIds.join(','),
        [ENV.tenantThrottle]: String(p.tenantThrottle !== undefined),
        [ENV.stackId]: Aws.STACK_ID,
      },
      description: 'tenant-encrypted-ingestion token authoriser: tenant-identity contract, logs only (M-1)',
    });
    const tenantApi = createFunction(this, 'TenantApiFunction', {
      ...common,
      entry: 'api/handler.ts',
      role: base.apiRole,
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: {
        ...tableEnv,
        [ENV.tenantUploadRoleArn]: tenant.upload.roleArn,
        [ENV.allowedContentTypes]: p.allowedContentTypes.join(','),
        [ENV.maxObjectSizeBytes]: String(p.maxObjectSizeBytes),
        [ENV.uploadUrlTtlSeconds]: String(p.uploadUrlTtlSeconds),
        [ENV.maxInFlightPerTenant]: String(p.maxInFlightPerTenant),
      },
      description: 'tenant-encrypted-ingestion tenant API: deliveries under the tenant upload session (spec §5.2)',
    });
    const platformEnv = {
      ...tableEnv,
      [ENV.tenantUploadRoleArn]: tenant.upload.roleArn,
      [ENV.tenantProcessRoleArn]: tenant.process.roleArn,
      [ENV.tenantPlatformRoleArn]: tenant.platform.roleArn,
      [ENV.platformRoleArn]: base.platformRole.roleArn,
      [ENV.keyFactoryRoleArn]: base.keyFactoryRole.roleArn,
      [ENV.consumerRoleArns]: this.consumerRoleArns.join(','),
      [ENV.allowTenantKeys]: String(p.allowTenantKeys),
      [ENV.keyRotation]: String(p.keyRotation),
      [ENV.keyDeletionWindowDays]: String(p.keyDeletionWindowDays),
      [ENV.tenantThrottle]: String(p.tenantThrottle !== undefined),
      [ENV.usagePlanName]: usagePlan,
      [ENV.stackId]: Aws.STACK_ID,
    };
    const keyFactory = createFunction(this, 'KeyFactoryFunction', {
      ...common,
      entry: 'platform/handler.ts',
      handler: 'factoryHandler',
      role: base.keyFactoryRole,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: platformEnv,
      description: 'tenant-encrypted-ingestion CreateTenantKey under keyFactoryRole (spec §5.1, M-22)',
    });
    const platform = createFunction(this, 'PlatformFunction', {
      ...common,
      entry: 'platform/handler.ts',
      handler: 'platformHandler',
      role: base.platformRole,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: platformEnv,
      description: 'tenant-encrypted-ingestion Get/Rotate/DeleteTenantKey under platformRole (spec §5.1)',
    });

    for (const validator of p.validators) {
      validator.bind(this, base.processorRole);
    }
    const processor = createProcessorFunction(this, {
      ...common,
      role: base.processorRole,
      queue: this.queue,
      timeout: T,
      environment: {
        ...tableEnv,
        [ENV.eventBusName]: this.eventBus.eventBusName,
        [ENV.tenantProcessRoleArn]: tenant.process.roleArn,
        [ENV.maxObjectSizeBytes]: String(p.maxObjectSizeBytes),
        [ENV.allowedContentTypes]: p.allowedContentTypes.join(','),
        [ENV.validators]: JSON.stringify(
          p.validators.map((v) => ({ name: v.name, functionArn: v.functionArn, timeoutSeconds: v.timeout.toSeconds() })),
        ),
        [ENV.validatorObjectUrlTtlSeconds]: String(p.validatorObjectUrlTtlSeconds),
        [ENV.maxReceiveCount]: String(p.maxReceiveCount),
        [ENV.processorTimeoutSeconds]: String(T.toSeconds()),
        [ENV.perTenantMetrics]: String(p.perTenantMetrics),
      },
    });
    this.processorFunction = processor.fn;

    const sweep = createSweep(this, {
      ...common,
      role: base.sweepRole,
      environment: {
        ...tableEnv,
        [ENV.eventBusName]: this.eventBus.eventBusName,
        [ENV.tenantProcessRoleArn]: tenant.process.roleArn,
        [ENV.maxReceiveCount]: String(p.maxReceiveCount),
        [ENV.visibilityTimeoutSeconds]: String(visibility.toSeconds()),
        [ENV.abandonGraceSeconds]: String(p.abandonGraceSeconds),
      },
    });
    this.sweepFunction = sweep.fn;

    const watch = createWatch(this, {
      ...common,
      role: base.watchRole,
      table: this.registryTable,
      failureQueue: watchFailureQueue,
      environment: { [ENV.tableName]: this.registryTable.tableName },
    });

    // ---- API (spec §5) -------------------------------------------------------
    const ingestionApi = createApi(this, {
      authoriserFn: authoriser.fn,
      tenantFn: tenantApi.fn,
      keyFactoryFn: keyFactory.fn,
      platformFn: platform.fn,
      tenantThrottle: p.tenantThrottle,
      usagePlanName: usagePlan,
      logRetention: p.logRetention,
    });
    this.api = ingestionApi.api;
    this.apiUrl = ingestionApi.api.url;

    // ---- the stack-delete key drain (spec §6.2, M-26) ------------------------
    const drain = createFunction(this, 'KeyDrainFunction', {
      ...common,
      entry: 'platform/drain.ts',
      role: base.platformRole,
      timeout: Duration.minutes(5),
      environment: {
        [ENV.tableName]: this.registryTable.tableName,
        [ENV.stackId]: Aws.STACK_ID,
        [ENV.keyDeletionWindowDays]: String(p.keyDeletionWindowDays),
      },
      description: 'tenant-encrypted-ingestion: on stack delete, schedules every vendor-key key for deletion (M-26)',
    });
    const drainResource = new CustomResource(this, 'KeyDrain', {
      serviceToken: drain.fn.functionArn,
      resourceType: 'Custom::TenantKeyDrain',
    });
    // Removed BEFORE the drain runs: the API and every function that can create a key.
    for (const writer of [ingestionApi.api, keyFactory.fn, platform.fn, processor.fn, sweep.fn]) {
      writer.node.addDependency(drainResource);
    }
    drainResource.node.addDependency(base.platformRole);

    // ---- scopes (spec §3.2) ----------------------------------------------------
    const logDrain = new LogDrain(this, 'LogDrain');
    const scopes = new ScopeRegistration(this, 'ScopeRegistration', {
      backend: 'ingestion',
      scopes: [SCOPES.deliver, SCOPES.read],
      identityApi: p.identityApi,
      logDrain,
    });
    ingestionApi.api.node.addDependency(scopes.resource);

    // ---- observability and alarms -------------------------------------------
    const insightRules = createTopTenantRules(this, { processorLogs: processor.logGroup, apiAccessLogs: ingestionApi.accessLogs });
    this.contributorInsightRuleNames = insightRules.map((r) => r.ruleName);
    this.logGroups = {
      authoriser: authoriser.logGroup,
      tenantApi: tenantApi.logGroup,
      keyFactory: keyFactory.logGroup,
      platform: platform.logGroup,
      processor: processor.logGroup,
      sweep: sweep.logGroup,
      watch: watch.logGroup,
      keyDrain: drain.logGroup,
      apiAccess: ingestionApi.accessLogs,
    };
    this.alarms = createAlarms(this, { logRetention: p.logRetention });

    // LogDrain (ADR-0015, copied from agentic-runtime-isolation ADR-0019):
    // late log lines land before their groups go. Writers are removed before
    // the drain waits.
    for (const group of [authoriser, tenantApi, keyFactory, platform, processor, sweep, watch, drain]) {
      logDrain.protect(group.logGroup);
      logDrain.writer(group.fn);
    }
    logDrain.protect(ingestionApi.accessLogs);
    logDrain.writer(ingestionApi.api.deploymentStage);

    this.acknowledgeFindings(stack);
  }

  private acknowledgeFindings(stack: Stack): void {
    // CDK's stack singleton that turns on the bucket's EventBridge
    // notifications (eventBridgeEnabled): a provider role with the logs-only
    // managed policy and s3:PutBucketNotification on '*', which CDK owns.
    for (const child of stack.node.children) {
      if (child.node.id.startsWith('BucketNotificationsHandler')) {
        acknowledgeGranularFinding(
          child,
          'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
          'CDK\'s bucket-notifications provider (eventBridgeEnabled, spec §8) carries the logs-only managed policy; the sample does not own it (M-31).',
        );
        acknowledgeWildcards(child, () => 'CDK\'s bucket-notifications provider: s3:PutBucketNotification accepts the bucket only through its own handler (M-31).');
      }
    }
    acknowledgeWildcards(this, (policyPath) => {
      const reason = Object.entries(WILDCARD_REASONS).find(([role]) => policyPath.includes(`/${role}/`))?.[1];
      return reason;
    });
    Validations.of(this).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'The DLQs (pipeline, EventBridge target, watch on-failure) and the audit queue are the end of their chains; a DLQ of a DLQ would hold nothing new (M-16, M-24, M-25).',
    });
    Validations.of(this).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Every function runs Node.js 24, the newest runtime the sample is tested on (M-31).',
    });
  }
}
