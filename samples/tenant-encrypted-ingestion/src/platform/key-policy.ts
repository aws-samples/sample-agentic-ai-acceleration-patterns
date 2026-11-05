// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The key policies (spec §7.2, §7.3; ADR-0001, ADR-0002; M-17, M-29).
 * Pure functions: the key factory renders the `vendor-key` policy at
 * `CreateKey` (written once, `BypassPolicyLockoutSafetyCheck`), the README
 * prints the `tenant-key` template, the integration test's scratch key is
 * built from the same function, and unit tests assert every statement.
 *
 * Roles are role ARNs with path, matched on `aws:PrincipalArn` (for an
 * assumed role, the role ARN, never the session ARN). No statement uses a
 * wildcard action: `kms:Create*` includes `kms:CreateGrant`, with which a
 * role grants itself `Decrypt`.
 *
 * The Denies are separate statements: conditions in one statement are
 * ANDed, so one "unless A and B and C" Deny would fire only when all three
 * fail.
 */

export interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Principal: { AWS: string | string[] } | '*';
  readonly Action: string | string[];
  readonly Resource: '*';
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: PolicyStatement[];
}

export interface VendorKeyPolicyInput {
  readonly partition?: string;
  readonly account: string;
  readonly region: string;
  readonly bucket: string;
  readonly tenantId: string;
  /** The tenant roles: upload, process, platform (the pipeline always passes all three). */
  readonly tenantRoleArns: readonly string[];
  /** The deployer's consumer roles; may be empty (statement 2b is then omitted). */
  readonly consumerRoleArns: readonly string[];
  readonly platformRoleArn: string;
  readonly keyFactoryRoleArn: string;
}

/** Statement 1, `platformRole` (spec §7.2). */
export const PLATFORM_ADMIN_ACTIONS = [
  'kms:DeleteAlias',
  'kms:DescribeKey',
  'kms:GetKeyRotationStatus',
  'kms:RotateKeyOnDemand',
  'kms:ListResourceTags',
  'kms:GetKeyPolicy',
  'kms:ScheduleKeyDeletion',
  'kms:CancelKeyDeletion',
] as const;

/** Statement 1, `keyFactoryRole` (spec §7.2). */
export const KEY_FACTORY_ADMIN_ACTIONS = ['kms:CreateAlias', 'kms:EnableKeyRotation', 'kms:DescribeKey', 'kms:ScheduleKeyDeletion'] as const;

/** The actions statements 4a-i, 4b and 4c deny (4a-ii denies `kms:Decrypt` alone). */
export const USE_ACTIONS_EXCEPT_DECRYPT = ['kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:CreateGrant'] as const;
export const ALL_USE_ACTIONS = ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:CreateGrant'] as const;

export function s3ViaService(region: string): string {
  return `s3.${region}.amazonaws.com`;
}

/** The two prefix patterns of a tenant, as `kms:EncryptionContext:aws:s3:arn` values. */
export function tenantObjectArns(partition: string, bucket: string, tenantId: string): { ingest: string; documents: string } {
  return {
    ingest: `arn:${partition}:s3:::${bucket}/ingest/${tenantId}/*`,
    documents: `arn:${partition}:s3:::${bucket}/documents/${tenantId}/*`,
  };
}

function useViaS3(sid: string, principals: readonly string[], actions: string[], region: string, contextArns: string[]): PolicyStatement {
  return {
    Sid: sid,
    Effect: 'Allow',
    Principal: { AWS: [...principals] },
    Action: actions,
    Resource: '*',
    Condition: {
      StringEquals: { 'kms:ViaService': s3ViaService(region) },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': contextArns },
    },
  };
}

/** The `vendor-key` key policy (spec §7.2), statements 1 to 5 in order. */
export function buildVendorKeyPolicy(input: VendorKeyPolicyInput): PolicyDocument {
  const partition = input.partition ?? 'aws';
  // The pipeline passes its three tenant roles; the integration test's
  // scratch key passes its one writer role (M-32).
  const tenantRoles = [...new Set(input.tenantRoleArns)];
  if (tenantRoles.length === 0 || tenantRoles.length > 3) {
    throw new Error('buildVendorKeyPolicy: one to three tenant roles (upload, process, platform)');
  }
  const prefixes = tenantObjectArns(partition, input.bucket, input.tenantId);
  const consumers = [...input.consumerRoleArns];
  const statements: PolicyStatement[] = [
    // 1. Administration, no wildcard.
    {
      Sid: 'AdministrationPlatformRole',
      Effect: 'Allow',
      Principal: { AWS: input.platformRoleArn },
      Action: [...PLATFORM_ADMIN_ACTIONS],
      Resource: '*',
    },
    {
      Sid: 'AdministrationKeyFactoryRole',
      Effect: 'Allow',
      Principal: { AWS: input.keyFactoryRoleArn },
      Action: [...KEY_FACTORY_ADMIN_ACTIONS],
      Resource: '*',
    },
    // 2. Use via S3, bound to the tenant's two prefixes.
    useViaS3('TenantRolesUseViaS3OnTenantPrefixes', tenantRoles, ['kms:GenerateDataKey', 'kms:Decrypt'], input.region, [
      prefixes.ingest,
      prefixes.documents,
    ]),
    // 2, companion: a direct DescribeKey has no ViaService and no context.
    {
      Sid: 'TenantRolesDescribeKey',
      Effect: 'Allow',
      Principal: { AWS: tenantRoles },
      Action: 'kms:DescribeKey',
      Resource: '*',
    },
  ];
  // 2b. Consumer read: Decrypt only, via S3, documents/<t>/* only.
  if (consumers.length > 0) {
    statements.push(useViaS3('ConsumerRolesDecryptLandedDocuments', consumers, ['kms:Decrypt'], input.region, [prefixes.documents]));
  }
  statements.push(
    // 3. Account administration: lets identity policies in the vendor account
    // reach the key; no use action, CreateGrant or TagResource.
    {
      Sid: 'AccountAdministration',
      Effect: 'Allow',
      Principal: { AWS: `arn:${partition}:iam::${input.account}:root` },
      Action: [...new Set<string>([...PLATFORM_ADMIN_ACTIONS, ...KEY_FACTORY_ADMIN_ACTIONS, 'kms:PutKeyPolicy'])],
      Resource: '*',
    },
    // 4a-i. Use (but Decrypt) only by a tenant role.
    {
      Sid: 'DenyUseExceptTenantRoles',
      Effect: 'Deny',
      Principal: '*',
      Action: [...USE_ACTIONS_EXCEPT_DECRYPT],
      Resource: '*',
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': tenantRoles } },
    },
    // 4a-ii. Decrypt only by a tenant role or a consumer role.
    {
      Sid: 'DenyDecryptExceptTenantAndConsumerRoles',
      Effect: 'Deny',
      Principal: '*',
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': [...tenantRoles, ...consumers] } },
    },
    // 4b. Use only via S3 in the bucket's Region.
    {
      Sid: 'DenyUseExceptViaS3',
      Effect: 'Deny',
      Principal: '*',
      Action: [...ALL_USE_ACTIONS],
      Resource: '*',
      Condition: { StringNotEquals: { 'kms:ViaService': s3ViaService(input.region) } },
    },
    // 4c. Use only on the tenant's two prefixes. A bucket key puts the bucket
    // ARN in the context, so it misses statement 2 and meets this Deny.
    {
      Sid: 'DenyUseOutsideTenantPrefixes',
      Effect: 'Deny',
      Principal: '*',
      Action: [...ALL_USE_ACTIONS],
      Resource: '*',
      Condition: { StringNotLike: { 'kms:EncryptionContext:aws:s3:arn': [prefixes.ingest, prefixes.documents] } },
    },
    // 5. No key the factory created can be retagged.
    {
      Sid: 'DenyTagging',
      Effect: 'Deny',
      Principal: '*',
      Action: ['kms:TagResource', 'kms:UntagResource'],
      Resource: '*',
    },
  );
  return { Version: '2012-10-17', Statement: statements };
}

export interface TenantKeyTemplateInput {
  readonly partition?: string;
  /** The tenant's own account, which keeps administration of its key. */
  readonly tenantAccount: string;
  readonly region: string;
  readonly bucket: string;
  readonly tenantId: string;
  readonly tenantRoleArns: readonly string[];
  readonly consumerRoleArns: readonly string[];
}

/**
 * The `tenant-key` key policy template (spec §7.3), for the README: the
 * tenant's own administration, statement 2 for the three tenant roles,
 * statement 2b for the consumer roles and `kms:DescribeKey` for the tenant
 * roles; never a grant. The tenant may add its own Denies.
 */
export function buildTenantKeyTemplate(input: TenantKeyTemplateInput): PolicyDocument {
  const partition = input.partition ?? 'aws';
  const prefixes = tenantObjectArns(partition, input.bucket, input.tenantId);
  const statements: PolicyStatement[] = [
    {
      Sid: 'TenantAccountAdministration',
      Effect: 'Allow',
      Principal: { AWS: `arn:${partition}:iam::${input.tenantAccount}:root` },
      Action: 'kms:*',
      Resource: '*',
    },
    useViaS3('VendorTenantRolesUseViaS3OnTenantPrefixes', input.tenantRoleArns, ['kms:GenerateDataKey', 'kms:Decrypt'], input.region, [
      prefixes.ingest,
      prefixes.documents,
    ]),
    {
      Sid: 'VendorTenantRolesDescribeKey',
      Effect: 'Allow',
      Principal: { AWS: [...input.tenantRoleArns] },
      Action: 'kms:DescribeKey',
      Resource: '*',
    },
  ];
  if (input.consumerRoleArns.length > 0) {
    statements.push(
      useViaS3('VendorConsumerRolesDecryptLandedDocuments', input.consumerRoleArns, ['kms:Decrypt'], input.region, [prefixes.documents]),
    );
  }
  return { Version: '2012-10-17', Statement: statements };
}
