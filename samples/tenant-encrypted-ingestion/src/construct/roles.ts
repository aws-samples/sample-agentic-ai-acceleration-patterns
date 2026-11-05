// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The roles (spec §7.1, P-2, P-8; ADR-0003; M-12, M-13, M-14, M-22, M-23).
 *
 * Seven BASE roles, one per function, reach no document: no S3 action, no
 * KMS use action. Each that acts for a tenant may assume exactly one TENANT
 * role: `apiRole` the upload role, `processorRole` and `sweepRole` the
 * process role, `platformRole` and `keyFactoryRole` the platform role.
 *
 * Three TENANT roles carry the ABAC wall in their own identity policies
 * (never a session policy, which could only narrow): S3 on
 * `<prefix>/${aws:PrincipalTag/TenantId}/*`, KMS on keys tagged with the
 * same tenant and only via S3 in this Region, the registry only in
 * `TENANT#${aws:PrincipalTag/TenantId}` and only through the role's
 * attribute allowlist, with an explicit Deny on every request naming a
 * protected attribute. Their trust admits only their named base roles,
 * with exactly one session tag, `TenantId`, present and free of the
 * characters §7.0 keeps out (IAM wildcards cannot express the grammar
 * itself; code enforces it).
 */

import { ArnFormat, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { DOCUMENTS_PREFIX, INGEST_PREFIX, METRICS_NAMESPACE, PROBE_SEGMENT, STACK_TAG_KEY, TENANT_TAG_KEY } from '../shared/constants';
import {
  BASE_ROLE_DENIED_UPDATE_ATTRIBUTES,
  PROCESS_ROLE_ATTRIBUTES,
  PROCESSOR_KEY_ROW_ATTRIBUTES,
  PROTECTED_ATTRIBUTES,
  SYSTEM_PK,
  UPLOAD_ROLE_ATTRIBUTES,
} from '../shared/registry';

/** `${aws:PrincipalTag/TenantId}` as IAM evaluates it. */
export const TENANT_TAG_VARIABLE = `\${aws:PrincipalTag/${TENANT_TAG_KEY}}`;

/** Characters §7.0 keeps out of a tenant id, as the trust policy's StringNotLike patterns. */
export const TENANT_TAG_FORBIDDEN_PATTERNS = ['*/*', '*:*', '*=*', '*+*', '*@*', '*.*', '* *', '*,*'];

/** The trust conditions of every tenant role (spec §7.1 "Trust"). */
export const TENANT_ROLE_TRUST_CONDITIONS = {
  'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY] },
  'Null': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: 'false' },
  'StringNotLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: TENANT_TAG_FORBIDDEN_PATTERNS },
};

export const KMS_USE_ACTIONS = ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'];

/**
 * A base role may never use a TENANT key (spec §7.1). The Deny is scoped to
 * keys that carry a `TenantId` tag: Lambda decrypts a function's environment
 * variables with `kms:Decrypt` under the execution role (the AWS-managed
 * `aws/lambda` key, untagged), so an unconditioned Deny on `kms:Decrypt`
 * stops every function of that role from starting, with no log line to show
 * for it (found on the first deployment, 2026-11-05).
 */
export function denyTenantKeyUse(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyTenantKeyUse',
    effect: iam.Effect.DENY,
    actions: KMS_USE_ACTIONS,
    resources: ['*'],
    conditions: { Null: { [`aws:ResourceTag/${TENANT_TAG_KEY}`]: 'false' } },
  });
}

export interface RoleResources {
  readonly bucketArn: string;
  readonly tableArn: string;
  readonly tableStreamArn: string;
  readonly queueArn: string;
  readonly eventBusArn: string;
  readonly watchFailureQueueArn: string;
  readonly tenantThrottle: boolean;
}

export interface BaseRoles {
  readonly authoriserRole: iam.Role;
  readonly apiRole: iam.Role;
  readonly processorRole: iam.Role;
  readonly keyFactoryRole: iam.Role;
  readonly platformRole: iam.Role;
  readonly sweepRole: iam.Role;
  readonly watchRole: iam.Role;
}

export interface TenantRoles {
  readonly upload: iam.Role;
  readonly process: iam.Role;
  readonly platform: iam.Role;
}

function lambdaRole(scope: Construct, id: string, description: string): iam.Role {
  return new iam.Role(scope, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), description });
}

function tenantRole(scope: Construct, id: string, trustedBy: iam.IRole[], description: string): iam.Role {
  const principal = new iam.CompositePrincipal(...trustedBy.map((r) => new iam.ArnPrincipal(r.roleArn)))
    .withConditions(TENANT_ROLE_TRUST_CONDITIONS)
    .withSessionTags();
  return new iam.Role(scope, id, { assumedBy: principal, description });
}

function assume(role: iam.Role, target: iam.IRole): void {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'AssumeTenantRole', actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [target.roleArn] }),
  );
}

/** The registry Allow and Deny every tenant role carries (spec §7.1, the JSON policy). */
function registryStatements(tableArn: string, actions: string[], allowlist: readonly string[] | undefined): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'RegistryOwnTenantAllowlisted',
      actions: actions.map((a) => `dynamodb:${a}`),
      resources: [tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': [`TENANT#${TENANT_TAG_VARIABLE}`],
          ...(allowlist !== undefined ? { 'dynamodb:Attributes': [...allowlist] } : {}),
        },
        'StringEqualsIfExists': { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_OLD', 'UPDATED_NEW'] },
      },
    }),
    new iam.PolicyStatement({
      sid: 'ProtectKeyBinding',
      effect: iam.Effect.DENY,
      actions: ['dynamodb:*'],
      resources: [`${tableArn}*`],
      conditions: { 'ForAnyValue:StringEquals': { 'dynamodb:Attributes': [...PROTECTED_ATTRIBUTES] } },
    }),
  ];
}

function kmsTenantStatements(region: string, keysArn: string, actions: string[]): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'TenantKeysViaS3',
      actions,
      resources: [keysArn],
      conditions: {
        StringEquals: {
          [`aws:ResourceTag/${TENANT_TAG_KEY}`]: TENANT_TAG_VARIABLE,
          'kms:ViaService': `s3.${region}.amazonaws.com`,
        },
      },
    }),
    new iam.PolicyStatement({
      sid: 'TenantKeysDescribe',
      actions: ['kms:DescribeKey'],
      resources: [keysArn],
      conditions: { StringEquals: { [`aws:ResourceTag/${TENANT_TAG_KEY}`]: TENANT_TAG_VARIABLE } },
    }),
  ];
}

const SSE_KMS_CONDITION = { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } };

export function createRoles(scope: Construct, resources: RoleResources): { base: BaseRoles; tenant: TenantRoles } {
  const stack = Stack.of(scope);
  const region = stack.region;
  // KMS keys of this Region in ANY account: `tenant-key` keys live in the tenant's account.
  const anyAccountKeys = stack.formatArn({ service: 'kms', account: '*', resource: 'key', resourceName: '*' });
  const ownKeys = stack.formatArn({ service: 'kms', resource: 'key', resourceName: '*' });
  const tenantAliases = stack.formatArn({ service: 'kms', resource: 'alias', resourceName: 'tenant-*-ingestion' });
  const objects = (prefix: string, rest = '*') => `${resources.bucketArn}/${prefix}${TENANT_TAG_VARIABLE}/${rest}`;
  const apiGateway = (p: string) => stack.formatArn({ service: 'apigateway', account: '', resource: p, arnFormat: ArnFormat.NO_RESOURCE_NAME });

  // ---- base roles -----------------------------------------------------------
  const base: BaseRoles = {
    authoriserRole: lambdaRole(scope, 'AuthoriserRole', 'tenant-encrypted-ingestion authoriser: logs only (M-1)'),
    apiRole: lambdaRole(scope, 'ApiRole', 'tenant-encrypted-ingestion tenant API: assumes the tenant upload role only (spec §7.1)'),
    processorRole: lambdaRole(scope, 'ProcessorRole', 'tenant-encrypted-ingestion processor: queue, bus, validators, REVOKED only (spec §7.1)'),
    keyFactoryRole: lambdaRole(scope, 'KeyFactoryRole', 'tenant-encrypted-ingestion CreateTenantKey: creates and binds keys (spec §7.1, M-22)'),
    platformRole: lambdaRole(scope, 'PlatformRole', 'tenant-encrypted-ingestion platform API and drain (spec §7.1)'),
    sweepRole: lambdaRole(scope, 'SweepRole', 'tenant-encrypted-ingestion sweep (spec §8)'),
    watchRole: lambdaRole(scope, 'WatchRole', 'tenant-encrypted-ingestion registry watch (M-24)'),
  };

  // ---- tenant roles ---------------------------------------------------------
  const tenant: TenantRoles = {
    upload: tenantRole(scope, 'TenantUploadRole', [base.apiRole], 'tenant-encrypted-ingestion: presigns the write-once PUT for one tenant (spec §7.5)'),
    process: tenantRole(scope, 'TenantProcessRole', [base.processorRole, base.sweepRole], 'tenant-encrypted-ingestion: validates and lands one tenant\'s drops (spec §8)'),
    platform: tenantRole(scope, 'TenantPlatformRole', [base.platformRole, base.keyFactoryRole], 'tenant-encrypted-ingestion: probes and offboards one tenant (spec §5.1)'),
  };

  // tenantUploadRole: write a drop, nothing else in S3.
  tenant.upload.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'PutOwnDrop', actions: ['s3:PutObject'], resources: [objects(INGEST_PREFIX)], conditions: SSE_KMS_CONDITION }),
  );
  for (const s of kmsTenantStatements(region, anyAccountKeys, ['kms:GenerateDataKey'])) {
    tenant.upload.addToPrincipalPolicy(s);
  }
  for (const s of registryStatements(resources.tableArn, ['UpdateItem', 'ConditionCheckItem', 'GetItem', 'Query'], UPLOAD_ROLE_ATTRIBUTES)) {
    tenant.upload.addToPrincipalPolicy(s);
  }

  // tenantProcessRole: read and delete drops, write probes and landed documents.
  tenant.process.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'ReadAndDeleteOwnDrops', actions: ['s3:GetObject', 's3:DeleteObjectVersion'], resources: [objects(INGEST_PREFIX)] }),
  );
  tenant.process.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'WriteOwnProbesAndDocuments',
      actions: ['s3:PutObject'],
      resources: [objects(INGEST_PREFIX, `${PROBE_SEGMENT}/*`), objects(DOCUMENTS_PREFIX)],
      conditions: SSE_KMS_CONDITION,
    }),
  );
  for (const s of kmsTenantStatements(region, anyAccountKeys, ['kms:Decrypt', 'kms:GenerateDataKey'])) {
    tenant.process.addToPrincipalPolicy(s);
  }
  for (const s of registryStatements(resources.tableArn, ['UpdateItem', 'ConditionCheckItem', 'GetItem', 'Query'], PROCESS_ROLE_ATTRIBUTES)) {
    tenant.process.addToPrincipalPolicy(s);
  }

  // tenantPlatformRole: list and delete under both prefixes, probe.
  tenant.platform.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'ListOwnPrefixes',
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [resources.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${INGEST_PREFIX}${TENANT_TAG_VARIABLE}/*`, `${DOCUMENTS_PREFIX}${TENANT_TAG_VARIABLE}/*`] } },
    }),
  );
  tenant.platform.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'DeleteOwnObjects',
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [objects(INGEST_PREFIX), objects(DOCUMENTS_PREFIX)],
    }),
  );
  tenant.platform.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'ReadOwnProbes', actions: ['s3:GetObject'], resources: [objects(INGEST_PREFIX, `${PROBE_SEGMENT}/*`)] }),
  );
  tenant.platform.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'WriteOwnProbes',
      actions: ['s3:PutObject'],
      resources: [objects(INGEST_PREFIX, `${PROBE_SEGMENT}/*`)],
      conditions: SSE_KMS_CONDITION,
    }),
  );
  for (const s of kmsTenantStatements(region, anyAccountKeys, ['kms:Decrypt', 'kms:GenerateDataKey'])) {
    tenant.platform.addToPrincipalPolicy(s);
  }
  for (const s of registryStatements(resources.tableArn, ['GetItem', 'Query'], undefined)) {
    tenant.platform.addToPrincipalPolicy(s);
  }

  // ---- base role policies ---------------------------------------------------
  assume(base.apiRole, tenant.upload);

  assume(base.processorRole, tenant.process);
  base.processorRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'ConsumeQueue',
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      resources: [resources.queueArn],
    }),
  );
  base.processorRole.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'PublishDeliveryEvents', actions: ['events:PutEvents'], resources: [resources.eventBusArn] }));
  base.processorRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'RevokeKeyRow',
      actions: ['dynamodb:UpdateItem'],
      resources: [resources.tableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...PROCESSOR_KEY_ROW_ATTRIBUTES] },
        'StringEqualsIfExists': { 'dynamodb:ReturnValues': ['NONE'] },
      },
    }),
  );

  // keyFactoryRole (M-22).
  const kf = base.keyFactoryRole;
  kf.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'CreateSymmetricSingleRegionKey',
      actions: ['kms:CreateKey'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'kms:KeySpec': 'SYMMETRIC_DEFAULT', 'kms:KeyOrigin': 'AWS_KMS', 'kms:KeyUsage': 'ENCRYPT_DECRYPT' },
        Bool: { 'kms:MultiRegion': 'false' },
      },
    }),
  );
  kf.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'TagAtCreation',
      actions: ['kms:TagResource'],
      resources: ['*'],
      conditions: {
        'Null': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: 'false' },
        'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY, STACK_TAG_KEY] },
      },
    }),
  );
  kf.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'CreateTenantAlias', actions: ['kms:CreateAlias'], resources: [tenantAliases, ownKeys] }));
  kf.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'AdministerCreatedKeys',
      actions: ['kms:EnableKeyRotation', 'kms:DescribeKey', 'kms:ScheduleKeyDeletion'],
      resources: [ownKeys, tenantAliases],
    }),
  );
  kf.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'WriteBindings',
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem', 'dynamodb:GetItem'],
      resources: [resources.tableArn],
    }),
  );
  assume(kf, tenant.platform);
  kf.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'DenyKeyPolicyGrantAndRetag',
      effect: iam.Effect.DENY,
      actions: ['kms:PutKeyPolicy', 'kms:CreateGrant', 'kms:UntagResource'],
      resources: ['*'],
    }),
  );
  kf.addToPrincipalPolicy(denyTenantKeyUse());

  // platformRole.
  const pr = base.platformRole;
  assume(pr, tenant.platform);
  pr.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'AdministerTenantKeys',
      actions: [
        'kms:DescribeKey',
        'kms:DeleteAlias',
        'kms:GetKeyRotationStatus',
        'kms:RotateKeyOnDemand',
        'kms:ListResourceTags',
        'kms:GetKeyPolicy',
        'kms:ScheduleKeyDeletion',
        'kms:CancelKeyDeletion',
      ],
      resources: [ownKeys, tenantAliases],
    }),
  );
  pr.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'ListKeys', actions: ['kms:ListKeys'], resources: ['*'] }));
  pr.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'RegistryTableWide',
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem'],
      resources: [resources.tableArn, `${resources.tableArn}/index/*`],
    }),
  );
  for (const role of [pr, base.sweepRole]) {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DenyBindingUpdates',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:UpdateItem'],
        resources: [`${resources.tableArn}*`],
        conditions: { 'ForAnyValue:StringEquals': { 'dynamodb:Attributes': [...BASE_ROLE_DENIED_UPDATE_ATTRIBUTES] } },
      }),
    );
  }
  pr.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'DenyKeyCreationTaggingPolicyAndGrant',
      effect: iam.Effect.DENY,
      actions: ['kms:CreateKey', 'kms:TagResource', 'kms:UntagResource', 'kms:PutKeyPolicy', 'kms:CreateGrant'],
      resources: ['*'],
    }),
  );
  pr.addToPrincipalPolicy(denyTenantKeyUse());

  if (resources.tenantThrottle) {
    // Ids are found at run time (the usage plan by name): an ARN of the plan
    // here would be a dependency cycle through the API's methods.
    kf.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CreateTenantApiKey',
        actions: ['apigateway:POST', 'apigateway:GET'],
        resources: [apiGateway('/apikeys'), apiGateway('/usageplans'), apiGateway('/usageplans/*/keys')],
      }),
    );
    pr.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'DeleteTenantApiKey', actions: ['apigateway:DELETE'], resources: [apiGateway('/apikeys/*')] }));
  }

  // sweepRole.
  assume(base.sweepRole, tenant.process);
  base.sweepRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'QueryIndexes', actions: ['dynamodb:Query'], resources: [`${resources.tableArn}/index/*`] }),
  );
  base.sweepRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'ReadAndUpdateRows', actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [resources.tableArn] }),
  );
  // Not in spec §7.1: the sweep publishes the events of the deliveries it
  // terminates and of owed events (spec §8), so it may put on the bus.
  base.sweepRole.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'PublishDeliveryEvents', actions: ['events:PutEvents'], resources: [resources.eventBusArn] }));

  // watchRole.
  base.watchRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'ReadStream',
      actions: ['dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:DescribeStream', 'dynamodb:ListStreams'],
      resources: [resources.tableStreamArn],
    }),
  );
  base.watchRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'AlarmMetric',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
    }),
  );
  base.watchRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'WriteTombstones',
      actions: ['dynamodb:UpdateItem'],
      resources: [resources.tableArn],
      conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [SYSTEM_PK] } },
    }),
  );
  base.watchRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid: 'OnFailureQueue', actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'], resources: [resources.watchFailureQueueArn] }),
  );

  return { base, tenant };
}

/** Exported for tests: the construct id of each role. */
export const ROLE_IDS = {
  base: ['AuthoriserRole', 'ApiRole', 'ProcessorRole', 'KeyFactoryRole', 'PlatformRole', 'SweepRole', 'WatchRole'],
  tenant: ['TenantUploadRole', 'TenantProcessRole', 'TenantPlatformRole'],
} as const;

