// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The platform functions (spec §5.1; M-5, M-17, M-18, M-19, M-22, M-26):
 * CreateTenantKey for both tiers and each refusal, GetTenantKey's probe,
 * RotateTenantKey by tier, DeleteTenantKey's order and idempotence, the drain.
 */

import { APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand, DeleteApiKeyCommand, GetUsagePlansCommand } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  KMSClient,
  ListKeysCommand,
  ListResourceTagsCommand,
  RotateKeyOnDemandCommand,
  ScheduleKeyDeletionCommand,
} from '@aws-sdk/client-kms';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { BUCKET, KEY_ARN_A, KEY_ARN_B, mockSts, NOW, TABLE } from './runtime-helpers';
import { usageKeyValue } from '../src/authoriser/usage-key';
import type { PlatformConfig, PlatformDependencies, TenantPlatformClients } from '../src/platform/common';
import { createTenantKey, keyMetadataProblem, tenantKeyArnProblem, VENDOR_KEY_PROPERTIES } from '../src/platform/create-tenant-key';
import { deleteTenantKey } from '../src/platform/delete-tenant-key';
import { drainKeys } from '../src/platform/drain';
import { getTenantKey, statusAfterProbe } from '../src/platform/get-tenant-key';
import { rotateTenantKey } from '../src/platform/rotate-tenant-key';
import { TenantClients, type TenantCredentials, TenantSessions } from '../src/shared/tenant-session';

const ddb = mockClient(DynamoDBDocumentClient);
const kms = mockClient(KMSClient);
const s3 = mockClient(S3Client);
const apigw = mockClient(APIGatewayClient);
mockSts();

const STACK_ID = 'arn:aws:cloudformation:eu-central-1:111122223333:stack/TenantEncryptedIngestion/00000000-0000-4000-8000-00000000000f';
const CONFIG: PlatformConfig = {
  tableName: TABLE,
  bucketName: BUCKET,
  partition: 'aws',
  account: '111122223333',
  region: 'eu-central-1',
  tenantRoleArns: {
    upload: 'arn:aws:iam::111122223333:role/TenantUploadRole',
    process: 'arn:aws:iam::111122223333:role/TenantProcessRole',
    platform: 'arn:aws:iam::111122223333:role/TenantPlatformRole',
  },
  consumerRoleArns: [],
  platformRoleArn: 'arn:aws:iam::111122223333:role/PlatformRole',
  keyFactoryRoleArn: 'arn:aws:iam::111122223333:role/KeyFactoryRole',
  allowTenantKeys: true,
  keyRotation: true,
  keyDeletionWindowDays: 7,
  tenantThrottle: false,
  stackId: STACK_ID,
};

function deps(overrides: Partial<PlatformConfig> = {}): PlatformDependencies {
  const sessions = new TenantSessions(new STSClient({ region: 'eu-central-1' }), CONFIG.tenantRoleArns.platform, () => NOW);
  const config = { ...CONFIG, ...overrides };
  return {
    config,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    kms: new KMSClient({ region: 'eu-central-1' }),
    apiGateway: config.tenantThrottle ? new APIGatewayClient({ region: 'eu-central-1' }) : undefined,
    tenant: new TenantClients<TenantPlatformClients>(sessions, (credentials: TenantCredentials) => ({
      s3: new S3Client({ region: 'eu-central-1', credentials }),
      kms: new KMSClient({ region: 'eu-central-1', credentials }),
    })),
    now: () => NOW,
    sleep: async () => undefined,
  };
}

function probeOk() {
  s3.on(PutObjectCommand).resolves({ VersionId: 'pv' });
  s3.on(GetObjectCommand).callsFake(() => ({ Body: { transformToString: async () => 'x' } as never }));
  s3.on(DeleteObjectCommand).resolves({});
}

function keyRowAfter(tier: string, keyArn: string) {
  let calls = 0;
  ddb.on(GetCommand).callsFake(() => {
    calls++;
    return calls === 1 ? {} : { Item: { PK: 'TENANT#tenant-a', SK: 'KEY', tier, keyArn, keyStatus: 'ACTIVE', createdAt: 't', updatedAt: 't' } };
  });
}

beforeEach(() => {
  ddb.reset();
  kms.reset();
  s3.reset();
  apigw.reset();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
});

describe('CreateTenantKey vendor-key (M-17, M-22)', () => {
  it('creates the key with all four properties, the policy, tags and lockout bypass; binds; aliases; rotates; probes; flips ACTIVE', async () => {
    keyRowAfter('vendor-key', KEY_ARN_A);
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    kms.on(CreateAliasCommand).resolves({});
    kms.on(EnableKeyRotationCommand).resolves({});
    probeOk();
    const summary = await createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key' });
    expect(summary.keyStatus).toBe('ACTIVE');

    const create = kms.commandCalls(CreateKeyCommand)[0].args[0].input;
    expect(create).toMatchObject({ ...VENDOR_KEY_PROPERTIES, BypassPolicyLockoutSafetyCheck: true });
    expect(create.Tags).toEqual([
      { TagKey: 'TenantId', TagValue: 'tenant-a' },
      { TagKey: 'tei:stack', TagValue: STACK_ID },
    ]);
    const policy = JSON.parse(create.Policy!);
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toContain('DenyUseOutsideTenantPrefixes');

    const binding = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(binding[0].Put!.ConditionExpression).toBe('attribute_not_exists(#keyArn)');
    expect(binding[0].Put!.Item).toMatchObject({ PK: 'TENANT#tenant-a', SK: 'KEY', keyArn: KEY_ARN_A, keyStatus: 'CREATING', tier: 'vendor-key' });
    expect(binding[1].Put!.Item).toMatchObject({ PK: `KEYARN#${KEY_ARN_A}`, SK: 'KEY' });
    expect(kms.commandCalls(CreateAliasCommand)[0].args[0].input.AliasName).toBe('alias/tenant-tenant-a-ingestion');
    expect(s3.commandCalls(PutObjectCommand)[0].args[0].input.Key).toMatch(/^ingest\/tenant-a\/_probe\//);
    // No probe version left behind.
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input.VersionId).toBe('pv');
    const flip = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(flip.ConditionExpression).toBe('#keyStatus = :creating AND #keyArn = :keyArn');
  });

  it('schedules the new key for deletion (undo) when the binding already exists: 409', async () => {
    ddb.on(GetCommand).resolves({});
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error('c'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }));
    await expect(createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key' })).rejects.toMatchObject({ name: 'ConflictError' });
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)[0].args[0].input.KeyId).toBe(KEY_ARN_A);
  });

  it('is 409 when the tenant already has an ACTIVE key, before any KMS call', async () => {
    ddb.on(GetCommand).resolves({ Item: { keyStatus: 'ACTIVE', tier: 'vendor-key', keyArn: KEY_ARN_A } });
    await expect(createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key' })).rejects.toMatchObject({ name: 'ConflictError' });
    expect(kms.calls()).toHaveLength(0);
  });

  it('resumes a CREATING row without a second key', async () => {
    let calls = 0;
    ddb.on(GetCommand).callsFake(() => ({
      Item: { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'vendor-key', keyArn: KEY_ARN_A, keyStatus: ++calls === 1 ? 'CREATING' : 'ACTIVE', createdAt: 't', updatedAt: 't' },
    }));
    kms.on(CreateAliasCommand).rejects(Object.assign(new Error('exists'), { name: 'AlreadyExistsException' }));
    kms.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    probeOk();
    await createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key' });
    expect(kms.commandCalls(CreateKeyCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('is 422 KeyNotUsable when the probe keeps failing, leaving the row CREATING', async () => {
    ddb.on(GetCommand).resolves({});
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    s3.on(PutObjectCommand).rejects(Object.assign(new Error('not authorized to perform: kms:GenerateDataKey'), { name: 'AccessDenied' }));
    await expect(createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key' })).rejects.toMatchObject({ name: 'KeyNotUsableError' });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('creates the tenant API key with the value the authoriser computes (M-5)', async () => {
    keyRowAfter('vendor-key', KEY_ARN_A);
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    probeOk();
    apigw.on(GetUsagePlansCommand).resolves({ items: [{ id: 'plan1', name: 'plan-name' }] });
    apigw.on(CreateApiKeyCommand).resolves({ id: 'key1' });
    apigw.on(CreateUsagePlanKeyCommand).resolves({});
    await createTenantKey(deps({ tenantThrottle: true, usagePlanName: 'plan-name' }), { tenantId: 'tenant-a', tier: 'vendor-key' });
    expect(apigw.commandCalls(CreateApiKeyCommand)[0].args[0].input.value).toBe(usageKeyValue(STACK_ID, 'tenant-a'));
    expect(apigw.commandCalls(CreateUsagePlanKeyCommand)[0].args[0].input).toMatchObject({ usagePlanId: 'plan1', keyId: 'key1' });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':set_apiKeyId']).toBe('key1');
  });

  it('retries a throttled API Gateway control-plane call with backoff and finishes (parallel deploy in the account)', async () => {
    keyRowAfter('vendor-key', KEY_ARN_A);
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    probeOk();
    apigw.on(GetUsagePlansCommand).resolves({ items: [{ id: 'plan1', name: 'plan-name' }] });
    const throttle = Object.assign(new Error('Too Many Requests'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } });
    apigw.on(CreateApiKeyCommand).rejectsOnce(throttle).rejectsOnce(throttle).resolves({ id: 'key1' });
    apigw.on(CreateUsagePlanKeyCommand).rejectsOnce(throttle).resolves({});
    const slept: number[] = [];
    const d = { ...deps({ tenantThrottle: true, usagePlanName: 'plan-name' }), sleep: async (ms: number) => void slept.push(ms) };
    await createTenantKey(d, { tenantId: 'tenant-a', tier: 'vendor-key' });
    expect(apigw.commandCalls(CreateApiKeyCommand)).toHaveLength(3);
    expect(apigw.commandCalls(CreateUsagePlanKeyCommand)).toHaveLength(2);
    expect(slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 1000]);
  });

  it('gives up after five throttled attempts; the row stays CREATING for a repeated call', async () => {
    keyRowAfter('vendor-key', KEY_ARN_A);
    kms.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_A } });
    probeOk();
    apigw.on(GetUsagePlansCommand).resolves({ items: [{ id: 'plan1', name: 'plan-name' }] });
    apigw.on(CreateApiKeyCommand).rejects(Object.assign(new Error('Too Many Requests'), { name: 'TooManyRequestsException' }));
    await expect(createTenantKey(deps({ tenantThrottle: true, usagePlanName: 'plan-name' }), { tenantId: 'tenant-a', tier: 'vendor-key' })).rejects.toMatchObject({
      name: 'TooManyRequestsException',
    });
    expect(apigw.commandCalls(CreateApiKeyCommand)).toHaveLength(5);
    expect(ddb.commandCalls(UpdateCommand).some((c) => c.args[0].input.ExpressionAttributeValues?.[':set_keyStatus'] === 'ACTIVE')).toBe(false);
  });

  it('refuses keyArn with vendor-key', async () => {
    await expect(createTenantKey(deps(), { tenantId: 'tenant-a', tier: 'vendor-key', keyArn: KEY_ARN_A })).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });
});

describe('CreateTenantKey tenant-key (M-19)', () => {
  it('is 400 UnsupportedInDeployment unless allowTenantKeys', async () => {
    await expect(createTenantKey(deps({ allowTenantKeys: false }), { tenantId: 'tenant-b', tier: 'tenant-key', keyArn: KEY_ARN_B })).rejects.toMatchObject({
      name: 'UnsupportedInDeploymentError',
    });
  });

  it.each([
    ['an alias ARN', 'arn:aws:kms:eu-central-1:444455556666:alias/tenant-b'],
    ['a bare key id', '00000000-0000-4000-8000-00000000000b'],
    ['another Region', 'arn:aws:kms:us-east-1:444455556666:key/00000000-0000-4000-8000-00000000000b'],
    ['the vendor account', 'arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-4000-8000-00000000000b'],
  ])('refuses %s with 422 before any call', (_name, arn) => {
    expect(tenantKeyArnProblem(arn, '111122223333', 'eu-central-1')).toBeDefined();
  });

  it.each([
    ['a non-canonical ARN', { Arn: `${KEY_ARN_B}x`, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled' }],
    ['an asymmetric key', { Arn: KEY_ARN_B, KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled' }],
    ['a disabled key', { Arn: KEY_ARN_B, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Disabled' }],
    ['a multi-Region key', { Arn: KEY_ARN_B, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled', MultiRegion: true }],
  ])('refuses %s', (_name, metadata) => {
    expect(keyMetadataProblem(metadata as never, KEY_ARN_B)).toBeDefined();
  });

  it('is 422 when DescribeKey under the tenant session is denied (untagged or wrongly tagged)', async () => {
    ddb.on(GetCommand).resolves({});
    kms.on(DescribeKeyCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(createTenantKey(deps(), { tenantId: 'tenant-b', tier: 'tenant-key', keyArn: KEY_ARN_B })).rejects.toMatchObject({
      name: 'KeyNotUsableError',
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('is 409 when another tenant holds the key (KEYARN#)', async () => {
    ddb.on(GetCommand).resolves({});
    kms.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_B, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled' } });
    ddb.on(TransactWriteCommand).rejects(
      Object.assign(new Error('c'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }),
    );
    await expect(createTenantKey(deps(), { tenantId: 'tenant-c', tier: 'tenant-key', keyArn: KEY_ARN_B })).rejects.toMatchObject({ name: 'ConflictError' });
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)).toHaveLength(0);
  });

  it('binds an admitted key with no alias, no rotation and never a CreateKey', async () => {
    keyRowAfter('tenant-key', KEY_ARN_B);
    kms.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'k', Arn: KEY_ARN_B, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled' } });
    probeOk();
    await createTenantKey(deps(), { tenantId: 'tenant-b', tier: 'tenant-key', keyArn: KEY_ARN_B });
    expect(kms.commandCalls(CreateKeyCommand)).toHaveLength(0);
    expect(kms.commandCalls(CreateAliasCommand)).toHaveLength(0);
    expect(kms.commandCalls(EnableKeyRotationCommand)).toHaveLength(0);
  });
});

describe('GetTenantKey and RotateTenantKey', () => {
  it('moves status by the probe only: ACTIVE->REVOKED on KMS, REVOKED->ACTIVE on success, never on other', () => {
    expect(statusAfterProbe('ACTIVE', 'kms')).toBe('REVOKED');
    expect(statusAfterProbe('REVOKED', 'usable')).toBe('ACTIVE');
    expect(statusAfterProbe('ACTIVE', 'other')).toBeUndefined();
    expect(statusAfterProbe('REVOKED', 'kms')).toBeUndefined();
  });

  it('GetTenantKey marks REVOKED when the probe fails in KMS', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'TENANT#tenant-b', SK: 'KEY', tier: 'tenant-key', keyArn: KEY_ARN_B, keyStatus: 'ACTIVE', createdAt: 't', updatedAt: 't' } });
    s3.on(PutObjectCommand).rejects(Object.assign(new Error('disabled'), { name: 'KMS.DisabledException' }));
    const summary = await getTenantKey(deps(), 'tenant-b');
    expect(summary.keyStatus).toBe('REVOKED');
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe('#keyStatus = :current');
  });

  it('RotateTenantKey: vendor-key rotates; tenant-key is UnsupportedInTier; the quota is RotationLimitReached', async () => {
    ddb.on(GetCommand).resolves({ Item: { tier: 'vendor-key', keyArn: KEY_ARN_A, keyStatus: 'ACTIVE' } });
    kms.on(RotateKeyOnDemandCommand).resolves({});
    expect(await rotateTenantKey(deps(), 'tenant-a')).toEqual({ tenantId: 'tenant-a', rotationStarted: true });
    kms.on(RotateKeyOnDemandCommand).rejects(Object.assign(new Error('limit'), { name: 'LimitExceededException' }));
    await expect(rotateTenantKey(deps(), 'tenant-a')).rejects.toMatchObject({ name: 'ConflictError', message: expect.stringMatching(/^RotationLimitReached/) });
    ddb.on(GetCommand).resolves({ Item: { tier: 'tenant-key', keyArn: KEY_ARN_B, keyStatus: 'ACTIVE' } });
    await expect(rotateTenantKey(deps(), 'tenant-b')).rejects.toMatchObject({ name: 'UnsupportedInTierError' });
  });
});

describe('DeleteTenantKey (M-26)', () => {
  const row = { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'vendor-key', keyArn: KEY_ARN_A, keyStatus: 'ACTIVE', apiKeyId: 'key1' };

  it('stops presigning, removes the API key, every version, the alias and the key, then the row and KEYARN#', async () => {
    ddb.on(GetCommand).resolves({ Item: row });
    apigw.on(DeleteApiKeyCommand).resolves({});
    s3.on(ListObjectVersionsCommand).resolves({ Versions: [{ Key: 'ingest/tenant-a/x', VersionId: 'v1' }], DeleteMarkers: [{ Key: 'documents/tenant-a/y', VersionId: 'm1' }] });
    s3.on(DeleteObjectsCommand).resolves({});
    kms.on(DeleteAliasCommand).resolves({});
    kms.on(ScheduleKeyDeletionCommand).resolves({});
    const result = await deleteTenantKey(deps({ tenantThrottle: true }), 'tenant-a');
    expect(result.statusCode).toBe(202);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':set_keyStatus']).toBe('DELETING');
    expect(s3.commandCalls(ListObjectVersionsCommand).map((c) => c.args[0].input.Prefix)).toEqual(['ingest/tenant-a/', 'documents/tenant-a/']);
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)[0].args[0].input.PendingWindowInDays).toBe(7);
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx.map((i) => i.Delete!.Key)).toEqual([
      { PK: 'TENANT#tenant-a', SK: 'KEY' },
      { PK: `KEYARN#${KEY_ARN_A}`, SK: 'KEY' },
    ]);
  });

  it('leaves a tenant-key key untouched', async () => {
    ddb.on(GetCommand).resolves({ Item: { ...row, tier: 'tenant-key', keyArn: KEY_ARN_B, apiKeyId: undefined } });
    s3.on(ListObjectVersionsCommand).resolves({});
    expect((await deleteTenantKey(deps(), 'tenant-b')).statusCode).toBe(202);
    expect(kms.calls()).toHaveLength(0);
  });

  it('resumes after a failure at any step: already-gone steps are not errors, and a missing row is 204', async () => {
    ddb.on(GetCommand).resolves({ Item: { ...row, keyStatus: 'DELETING' } });
    apigw.on(DeleteApiKeyCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFoundException' }));
    s3.on(ListObjectVersionsCommand).resolves({});
    kms.on(DeleteAliasCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFoundException' }));
    kms.on(ScheduleKeyDeletionCommand).rejects(Object.assign(new Error('pending'), { name: 'KMSInvalidStateException' }));
    expect((await deleteTenantKey(deps({ tenantThrottle: true }), 'tenant-a')).statusCode).toBe(202);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    ddb.on(GetCommand).resolves({});
    expect((await deleteTenantKey(deps(), 'tenant-a')).statusCode).toBe(204);
  });
});

describe('the stack-delete drain (M-26)', () => {
  it('schedules registered vendor-key keys and unknown keys tagged with this stack, never tenant-key keys', async () => {
    ddb.on(ScanCommand).resolves({
      Items: [
        { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'vendor-key', keyArn: KEY_ARN_A },
        { PK: 'TENANT#tenant-b', SK: 'KEY', tier: 'tenant-key', keyArn: KEY_ARN_B },
      ],
    });
    const orphan = 'arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-4000-8000-0000000000cc';
    const foreign = 'arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-4000-8000-0000000000dd';
    kms.on(ListKeysCommand).resolves({ Keys: [{ KeyArn: KEY_ARN_A }, { KeyArn: orphan }, { KeyArn: foreign }] });
    kms.on(ListResourceTagsCommand, { KeyId: orphan }).resolves({ Tags: [{ TagKey: 'tei:stack', TagValue: STACK_ID }] });
    kms.on(ListResourceTagsCommand, { KeyId: foreign }).rejects(Object.assign(new Error('d'), { name: 'AccessDeniedException' }));
    kms.on(ScheduleKeyDeletionCommand).resolves({});
    const scheduled = await drainKeys({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
      kms: new KMSClient({ region: 'eu-central-1' }),
      tableName: TABLE,
      stackId: STACK_ID,
      windowDays: 7,
    });
    expect(scheduled).toBe(2);
    expect(kms.commandCalls(ScheduleKeyDeletionCommand).map((c) => c.args[0].input.KeyId).sort()).toEqual([KEY_ARN_A, orphan].sort());
  });
});
