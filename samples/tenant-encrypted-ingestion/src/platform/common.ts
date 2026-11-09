// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the platform functions share (spec §5.1): their configuration, the
 * clients they run with, and the mapping of a key row to the API shape.
 *
 * Two kinds of credentials are in play. The function's own role
 * (`keyFactoryRole` for `CreateTenantKey`, `platformRole` for the rest)
 * signs KMS administration, registry and API Gateway calls; it reaches no
 * document. Every S3 call and the `tenant-key` admission `DescribeKey` run
 * under a `tenantPlatformRole` session for the tenant in the path
 * (`tenant`), so the tenant's own identity policy decides what is reachable.
 */

import type { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { KeyRow } from '../shared/registry';
import { tenantOfPk } from '../shared/registry';
import type { TenantClients } from '../shared/tenant-session';
import type { TenantKeySummary } from '../smithy/platform/typescript-ssdk-codegen/src';

export interface PlatformConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly partition: string;
  readonly account: string;
  readonly region: string;
  readonly tenantRoleArns: { readonly upload: string; readonly process: string; readonly platform: string };
  readonly consumerRoleArns: readonly string[];
  readonly platformRoleArn: string;
  readonly keyFactoryRoleArn: string;
  readonly allowTenantKeys: boolean;
  readonly keyRotation: boolean;
  readonly keyDeletionWindowDays: number;
  readonly tenantThrottle: boolean;
  /** Found by name at run time: its id in the environment would be a CloudFormation cycle. */
  readonly usagePlanName?: string;
  readonly stackId: string;
}

export interface TenantPlatformClients {
  readonly s3: S3Client;
  readonly kms: KMSClient;
}

export interface PlatformDependencies {
  readonly config: PlatformConfig;
  /** Under the function's own role. */
  readonly ddb: DynamoDBDocumentClient;
  readonly kms: KMSClient;
  readonly apiGateway?: APIGatewayClient;
  /** Under a `tenantPlatformRole` session for one tenant. */
  readonly tenant: TenantClients<TenantPlatformClients>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `alias/tenant-<tenantId>-ingestion` (spec §3.1). */
export function keyAliasName(tenantId: string): string {
  return `alias/tenant-${tenantId}-ingestion`;
}

/** The session lifetime a platform operation asks for (it runs well under 60 s). */
export const PLATFORM_SESSION_MIN_MS = 5 * 60 * 1000;

/** Account and partition of an IAM role ARN. */
export function arnParts(arn: string): { partition: string; account: string } {
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn' || !/^\d{12}$/.test(parts[4])) {
    throw new Error('arnParts: not an ARN with an account');
  }
  return { partition: parts[1], account: parts[4] };
}

export function toSummary(row: KeyRow): TenantKeySummary {
  return {
    tenantId: tenantOfPk(row.PK) ?? '',
    tier: row.tier,
    keyArn: row.keyArn,
    keyAlias: row.keyAlias,
    keyStatus: row.keyStatus,
    inFlight: row.inFlight ?? 0,
    bytesStored: row.bytesStored ?? 0,
    deliveriesAccepted: row.deliveriesAccepted ?? 0,
    deliveriesRejected: row.deliveriesRejected ?? 0,
    kmsRequests: row.kmsRequests ?? 0,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    lastKeyCheckAt: row.lastKeyCheckAt === undefined ? undefined : new Date(row.lastKeyCheckAt),
  };
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
