// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `CreateTenantKey` (spec §5.1, §4.1, §7.2, §7.3; ADR-0001, ADR-0004;
 * M-5, M-17, M-19, M-22, M-24). Runs under `keyFactoryRole`.
 *
 * `vendor-key`: `CreateKey` with all four key properties named (the role's
 * `kms:CreateKey` Allow is conditioned on each), the §7.2 policy and
 * `BypassPolicyLockoutSafetyCheck` (the role holds no `PutKeyPolicy`;
 * statement 3 keeps the key manageable), tags `TenantId` and `tei:stack`
 * at creation, then the alias and rotation.
 *
 * `tenant-key`: refused unless `allowTenantKeys`; 422 for a key ARN in the
 * vendor's account, an alias ARN, a bare id or another Region; then
 * `DescribeKey` under a `tenantPlatformRole` session for the tenant. That
 * the session is admitted at all proves the key's `TenantId` tag (§7.3):
 * the role reaches only keys tagged with its session's tenant. The
 * canonical ARN is `KeyMetadata.Arn`; `SYMMETRIC_DEFAULT`, `ENCRYPT_DECRYPT`,
 * `Enabled` and single-Region are required.
 *
 * Both tiers: the key row (`CREATING`) and `KEYARN#<keyArn>` are written in
 * one transaction with `attribute_not_exists` (409 if either exists), the
 * key is probed through S3, the API key is created with `tenantThrottle`,
 * and the row is flipped to `ACTIVE` conditionally. A failure after the
 * transaction leaves a `CREATING` row that a repeat of the call finishes
 * (as tenant-identity ADR-0021); a `vendor-key` key created by a call whose
 * transaction then failed is scheduled for deletion at once (the role's
 * "undo").
 */

import { ConflictException, CreateApiKeyCommand, CreateUsagePlanKeyCommand, GetApiKeysCommand, GetUsagePlansCommand } from '@aws-sdk/client-api-gateway';
import {
  AlreadyExistsException,
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  ScheduleKeyDeletionCommand,
  type KeyMetadata,
} from '@aws-sdk/client-kms';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { arnParts, defaultSleep, keyAliasName, PLATFORM_SESSION_MIN_MS, type PlatformDependencies, toSummary } from './common';
import { buildVendorKeyPolicy } from './key-policy';
import { apiError, ApiError } from '../api/errors';
import { usageKeyName, usageKeyValue } from '../authoriser/usage-key';
import { STACK_TAG_KEY, TENANT_TAG_KEY } from '../shared/constants';
import { cancellationCodes, errorCode, retryThrottled } from '../shared/errors';
import { log } from '../shared/logger';
import { probeKeyThroughS3 } from '../shared/probe';
import { isoNow, keyArnItemKey, type KeyRow, keyRowKey, type KeyTier, updateInput } from '../shared/registry';
import { isTenantId } from '../shared/tenant-id';
import type { TenantKeySummary } from '../smithy/platform/typescript-ssdk-codegen/src';

export interface CreateTenantKeyInput {
  readonly tenantId: string;
  readonly tier: KeyTier;
  readonly keyArn?: string;
}

/** The four key properties `CreateKey` names (M-22): the role's Allow requires each. */
export const VENDOR_KEY_PROPERTIES = {
  KeySpec: 'SYMMETRIC_DEFAULT',
  KeyUsage: 'ENCRYPT_DECRYPT',
  Origin: 'AWS_KMS',
  MultiRegion: false,
} as const;

const KEY_ARN_PATTERN = /^arn:(aws[a-z-]*):kms:([a-z0-9-]+):(\d{12}):key\/([A-Za-z0-9-]+)$/;
const PROBE_ATTEMPTS = 4;
const UNDO_WINDOW_DAYS = 7;

/** The checks on a `tenant-key` ARN before any call (M-19). Returns the refusal, or undefined. */
export function tenantKeyArnProblem(keyArn: string, vendorAccount: string, region: string): string | undefined {
  const match = KEY_ARN_PATTERN.exec(keyArn);
  if (match === null) {
    return 'keyArn must be a KMS key ARN (an alias ARN or a bare key id is not accepted)';
  }
  if (match[2] !== region) {
    return 'the key must be in the bucket Region';
  }
  if (match[3] === vendorAccount) {
    return 'a tenant-key key must be in the tenant account';
  }
  return undefined;
}

/** The checks on `DescribeKey`'s answer (M-19). Returns the refusal, or undefined. */
export function keyMetadataProblem(metadata: KeyMetadata | undefined, keyArn: string): string | undefined {
  if (metadata === undefined || metadata.Arn !== keyArn) {
    return 'the key ARN is not canonical';
  }
  if (metadata.KeySpec !== 'SYMMETRIC_DEFAULT' || metadata.KeyUsage !== 'ENCRYPT_DECRYPT') {
    return 'the key must be SYMMETRIC_DEFAULT for ENCRYPT_DECRYPT';
  }
  if (metadata.KeyState !== 'Enabled') {
    return 'the key is not enabled';
  }
  if (metadata.MultiRegion === true) {
    return 'the key must be single-Region';
  }
  return undefined;
}

export async function createTenantKey(deps: PlatformDependencies, input: CreateTenantKeyInput): Promise<TenantKeySummary> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { tenantId, tier } = input;
  if (!isTenantId(tenantId)) {
    throw apiError.validation('tenantId fails the tenant id grammar');
  }
  if (tier === 'tenant-key' && !config.allowTenantKeys) {
    throw apiError.unsupportedInDeployment('this deployment does not accept tenant-key');
  }
  if (tier === 'vendor-key' && input.keyArn !== undefined) {
    throw apiError.validation('keyArn is only accepted with tier tenant-key');
  }
  if (tier === 'tenant-key' && input.keyArn === undefined) {
    throw apiError.validation('tier tenant-key needs keyArn');
  }

  const existing = (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true })))
    .Item as KeyRow | undefined;
  if (existing !== undefined && (existing.keyStatus !== 'CREATING' || existing.tier !== tier)) {
    throw apiError.conflict('the tenant already has a key');
  }

  const { client: tenant } = await deps.tenant.client(tenantId, 'CreateTenantKey', PLATFORM_SESSION_MIN_MS);
  let keyArn: string;
  if (existing !== undefined) {
    // Resume a create that stopped after its transaction.
    if (tier === 'tenant-key' && existing.keyArn !== input.keyArn) {
      throw apiError.conflict('the tenant already has a key');
    }
    keyArn = existing.keyArn;
  } else if (tier === 'tenant-key') {
    keyArn = await admitTenantKey(deps, tenant.kms, input.keyArn!);
    await writeBinding(deps, tenantId, tier, keyArn, now());
  } else {
    keyArn = await createVendorKey(deps, tenantId);
    try {
      await writeBinding(deps, tenantId, tier, keyArn, now());
    } catch (error) {
      try {
        await deps.kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArn, PendingWindowInDays: UNDO_WINDOW_DAYS }));
      } catch {
        // The drain's tag backstop schedules it at stack delete (M-26).
      }
      throw error;
    }
  }

  if (tier === 'vendor-key') {
    await ensureAlias(deps, tenantId, keyArn);
    if (config.keyRotation) {
      await deps.kms.send(new EnableKeyRotationCommand({ KeyId: keyArn }));
    }
  }

  // ACTIVE only if the pipeline can use the key (spec §5.1). A new key's
  // tag can take a moment to reach the identity-policy evaluation, so the
  // probe is retried briefly before the call gives up.
  let probe = await probeKeyThroughS3(tenant.s3, config.bucketName, tenantId, keyArn);
  for (let attempt = 1; probe.outcome !== 'usable' && attempt < PROBE_ATTEMPTS; attempt++) {
    await sleep(1000 * attempt);
    probe = await probeKeyThroughS3(tenant.s3, config.bucketName, tenantId, keyArn);
  }
  if (probe.outcome !== 'usable') {
    log.warn('key not usable', { tenantId, operation: 'CreateTenantKey', tier, outcome: probe.outcome, errorType: probe.errorType });
    throw apiError.keyNotUsable('the pipeline cannot use the key through S3; repeat the call to finish once it can');
  }

  const apiKeyId = config.tenantThrottle ? await ensureApiKey(deps, tenantId) : undefined;
  const iso = isoNow(now());
  await deps.ddb.send(
    new UpdateCommand(
      updateInput(config.tableName, keyRowKey(tenantId), {
        set: { keyStatus: 'ACTIVE', apiKeyId, updatedAt: iso, lastKeyCheckAt: iso },
        condition: '#keyStatus = :creating AND #keyArn = :keyArn',
        values: { ':creating': 'CREATING', ':keyArn': keyArn },
      }),
    ),
  );
  log.info('tenant key active', { tenantId, operation: 'CreateTenantKey', tier });
  const row = (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true }))).Item as KeyRow;
  return toSummary(row);
}

async function admitTenantKey(deps: PlatformDependencies, tenantKms: PlatformDependencies['kms'], keyArn: string): Promise<string> {
  const vendor = arnParts(deps.config.platformRoleArn).account;
  const problem = tenantKeyArnProblem(keyArn, vendor, deps.config.region);
  if (problem !== undefined) {
    throw apiError.keyNotUsable(problem);
  }
  let metadata: KeyMetadata | undefined;
  try {
    metadata = (await tenantKms.send(new DescribeKeyCommand({ KeyId: keyArn }))).KeyMetadata;
  } catch (error) {
    // AccessDenied: the key is untagged, tagged for another tenant, or its
    // policy does not trust the tenant roles. NotFound: no such key.
    throw apiError.keyNotUsable(`the key is not admitted for this tenant (${errorCode(error)})`);
  }
  const metadataProblem = keyMetadataProblem(metadata, keyArn);
  if (metadataProblem !== undefined) {
    throw apiError.keyNotUsable(metadataProblem);
  }
  return metadata!.Arn!;
}

async function createVendorKey(deps: PlatformDependencies, tenantId: string): Promise<string> {
  const { config } = deps;
  const policy = buildVendorKeyPolicy({
    partition: config.partition,
    account: config.account,
    region: config.region,
    bucket: config.bucketName,
    tenantId,
    tenantRoleArns: [config.tenantRoleArns.upload, config.tenantRoleArns.process, config.tenantRoleArns.platform],
    consumerRoleArns: config.consumerRoleArns,
    platformRoleArn: config.platformRoleArn,
    keyFactoryRoleArn: config.keyFactoryRoleArn,
  });
  const created = await deps.kms.send(
    new CreateKeyCommand({
      ...VENDOR_KEY_PROPERTIES,
      Description: `tenant-encrypted-ingestion key for tenant ${tenantId}`,
      Policy: JSON.stringify(policy),
      BypassPolicyLockoutSafetyCheck: true,
      Tags: [
        { TagKey: TENANT_TAG_KEY, TagValue: tenantId },
        { TagKey: STACK_TAG_KEY, TagValue: config.stackId },
      ],
    }),
  );
  const arn = created.KeyMetadata?.Arn;
  if (arn === undefined) {
    throw apiError.internal();
  }
  return arn;
}

async function writeBinding(deps: PlatformDependencies, tenantId: string, tier: KeyTier, keyArn: string, at: number): Promise<void> {
  const { config } = deps;
  const iso = isoNow(at);
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: config.tableName,
              Item: {
                ...keyRowKey(tenantId),
                tier,
                keyArn,
                ...(tier === 'vendor-key' ? { keyAlias: keyAliasName(tenantId) } : {}),
                keyStatus: 'CREATING',
                inFlight: 0,
                bytesStored: 0,
                deliveriesAccepted: 0,
                deliveriesRejected: 0,
                kmsRequests: 0,
                createdAt: iso,
                updatedAt: iso,
              },
              ConditionExpression: 'attribute_not_exists(#keyArn)',
              ExpressionAttributeNames: { '#keyArn': 'keyArn' },
            },
          },
          {
            Put: {
              TableName: config.tableName,
              Item: { ...keyArnItemKey(keyArn), boundTenantId: tenantId, createdAt: iso },
              ConditionExpression: 'attribute_not_exists(#PK)',
              ExpressionAttributeNames: { '#PK': 'PK' },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (cancellationCodes(error) !== undefined) {
      throw apiError.conflict('the tenant or the key is already bound');
    }
    throw error;
  }
}

async function ensureAlias(deps: PlatformDependencies, tenantId: string, keyArn: string): Promise<void> {
  const aliasName = keyAliasName(tenantId);
  try {
    await deps.kms.send(new CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyArn }));
  } catch (error) {
    if (!(error instanceof AlreadyExistsException) && errorCode(error) !== 'AlreadyExistsException') {
      throw error;
    }
    const target = (await deps.kms.send(new DescribeKeyCommand({ KeyId: aliasName }))).KeyMetadata?.Arn;
    if (target !== keyArn) {
      throw apiError.conflict('the tenant alias points at another key');
    }
  }
}

let usagePlanIdCache: string | undefined;

/** The usage plan's id, found once by its name. */
export async function findUsagePlan(apiGateway: NonNullable<PlatformDependencies['apiGateway']>, name: string): Promise<string> {
  if (usagePlanIdCache !== undefined) {
    return usagePlanIdCache;
  }
  let position: string | undefined;
  do {
    const page = await apiGateway.send(new GetUsagePlansCommand({ position, limit: 500 }));
    const found = page.items?.find((p) => p.name === name)?.id;
    if (found !== undefined) {
      usagePlanIdCache = found;
      return found;
    }
    position = page.position;
  } while (position !== undefined);
  throw apiError.internal('the tenant usage plan was not found');
}

/**
 * The API Gateway control plane is throttled per account, and a parallel
 * deploy in the same account eats the quota: every call here retries a
 * throttle with backoff (ADR-0011). The row stays `CREATING` if the budget
 * runs out, so a repeated `CreateTenantKey` resumes.
 */
async function ensureApiKey(deps: PlatformDependencies, tenantId: string): Promise<string> {
  const { config } = deps;
  const apiGateway = deps.apiGateway;
  if (apiGateway === undefined || config.usagePlanName === undefined) {
    throw apiError.internal();
  }
  const sleep = deps.sleep ?? defaultSleep;
  const send = <T>(call: () => Promise<T>) => retryThrottled(call, 5, sleep);
  const usagePlanId = await send(() => findUsagePlan(apiGateway, config.usagePlanName!));
  const name = usageKeyName(tenantId);
  let id: string | undefined;
  try {
    id = (await send(() => apiGateway.send(new CreateApiKeyCommand({ name, value: usageKeyValue(config.stackId, tenantId), enabled: true })))).id;
  } catch (error) {
    if (!(error instanceof ConflictException) && errorCode(error) !== 'ConflictException') {
      throw error;
    }
    const found = await send(() => apiGateway.send(new GetApiKeysCommand({ nameQuery: name, includeValues: false })));
    id = found.items?.find((k) => k.name === name)?.id;
  }
  if (id === undefined) {
    throw apiError.internal();
  }
  try {
    await send(() => apiGateway.send(new CreateUsagePlanKeyCommand({ usagePlanId, keyId: id, keyType: 'API_KEY' })));
  } catch (error) {
    if (!(error instanceof ConflictException) && errorCode(error) !== 'ConflictException') {
      throw error;
    }
  }
  return id;
}

export { ApiError };
