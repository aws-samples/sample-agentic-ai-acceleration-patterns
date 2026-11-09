// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared runtime pieces: the registry schemas and write rules (M-23), the
 * tenant id grammar and session names (M-13), session freshness (M-11),
 * the field-allowlisted logger (M-27), the event schema (M-29), and the
 * KMS classifier (M-18).
 */

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { captureStdout, NOW } from './runtime-helpers';
import { isKmsSourced } from '../src/shared/errors';
import { eventDetail } from '../src/shared/events';
import { log } from '../src/shared/logger';
import {
  AttributeNotAllowedError,
  DELIVERY_ROW_ATTRIBUTES,
  KEY_ROW_ATTRIBUTES,
  PROCESS_ROLE_ATTRIBUTES,
  PROTECTED_ATTRIBUTES,
  SHARED_ROW_ATTRIBUTES,
  updateExpression,
  UPLOAD_ROLE_ATTRIBUTES,
} from '../src/shared/registry';
import { isTenantId, parseDropKey, sessionName } from '../src/shared/tenant-id';
import { TenantSessions } from '../src/shared/tenant-session';

describe('registry schemas (spec §4, M-23)', () => {
  it('key rows and delivery rows share no attribute name outside keys and timestamps', () => {
    const shared = KEY_ROW_ATTRIBUTES.filter((a) => (DELIVERY_ROW_ATTRIBUTES as readonly string[]).includes(a));
    expect([...shared].sort()).toEqual([...SHARED_ROW_ATTRIBUTES].sort());
  });

  it('no delivery row attribute is protected, and no allowlist names a protected attribute', () => {
    for (const name of PROTECTED_ATTRIBUTES) {
      expect(DELIVERY_ROW_ATTRIBUTES as readonly string[]).not.toContain(name);
      expect(UPLOAD_ROLE_ATTRIBUTES as readonly string[]).not.toContain(name);
      expect(PROCESS_ROLE_ATTRIBUTES as readonly string[]).not.toContain(name);
    }
  });

  it('the tenant roles can write every key-row name they need and nothing protected', () => {
    // Shared names the tenant roles may touch on a key row are allowlisted counters and timestamps only.
    const keyNamesUpload = KEY_ROW_ATTRIBUTES.filter((a) => (UPLOAD_ROLE_ATTRIBUTES as readonly string[]).includes(a));
    expect([...keyNamesUpload].sort()).toEqual(['PK', 'SK', 'createdAt', 'inFlight', 'updatedAt'].sort());
    const keyNamesProcess = KEY_ROW_ATTRIBUTES.filter((a) => (PROCESS_ROLE_ATTRIBUTES as readonly string[]).includes(a));
    expect([...keyNamesProcess].sort()).toEqual(
      ['PK', 'SK', 'bytesStored', 'deliveriesAccepted', 'deliveriesRejected', 'inFlight', 'kmsRequests', 'updatedAt'].sort(),
    );
  });

  it('an update naming a protected attribute fails before it is sent', () => {
    expect(() => updateExpression({ PK: 'TENANT#a1', SK: 'KEY' }, { set: { keyStatus: 'ACTIVE' } }, PROCESS_ROLE_ATTRIBUTES)).toThrow(
      AttributeNotAllowedError,
    );
    expect(() =>
      updateExpression({ PK: 'TENANT#a1', SK: 'KEY' }, { add: { inFlight: 1 }, condition: '#keyArn = :x', values: { ':x': 'y' } }, UPLOAD_ROLE_ATTRIBUTES),
    ).toThrow(/keyArn/);
  });

  it('names every attribute by placeholder, so the names map is what IAM evaluates', () => {
    const input = updateExpression(
      { PK: 'TENANT#a1', SK: 'DELIVERY#X' },
      { set: { status: 'PROCESSING' }, add: { inFlight: -1 }, remove: ['statusBucket'], condition: 'attribute_exists(#PK)' },
    );
    expect(input.UpdateExpression).toBe('SET #status = :set_status ADD #inFlight :add_inFlight REMOVE #statusBucket');
    expect(Object.values(input.ExpressionAttributeNames).sort()).toEqual(['PK', 'inFlight', 'status', 'statusBucket']);
    expect(input.ReturnValues).toBe('NONE');
  });
});

describe('tenant id grammar and keys (spec §7.0, M-13, M-15)', () => {
  it.each(['a1', 'tenant-a', 'a'.repeat(35), '0abc', 'A1', '01JBX5Z8Y7W6V5T4S3R2Q1P0NM'])('accepts %s', (id) => expect(isTenantId(id)).toBe(true));
  it.each(['a', '-a1', 'a/b', 'a.b', 'a b', 'a'.repeat(36), 'a_b', 'a+b', 'a@b', 'a,b', 'a:b', 'a=b', ''])('refuses %j', (id) =>
    expect(isTenantId(id)).toBe(false),
  );

  it('parses drop keys by the second segment only', () => {
    expect(parseDropKey('ingest/tenant-a/01JBX5Z8Y7W6V5T4S3R2Q1P0NM')).toEqual({ kind: 'delivery', tenantId: 'tenant-a', deliveryId: '01JBX5Z8Y7W6V5T4S3R2Q1P0NM' });
    expect(parseDropKey('ingest/tenant-a/_probe/x')).toEqual({ kind: 'probe', tenantId: 'tenant-a' });
    expect(parseDropKey('ingest/tenant-a/not-a-ulid').kind).toBe('invalid');
    expect(parseDropKey('ingest/ten.ant/01JBX5Z8Y7W6V5T4S3R2Q1P0NM').kind).toBe('invalid');
  });

  it('builds session names t-<tenantId>-<suffix> under 64 characters', () => {
    const name = sessionName('a'.repeat(35), '01JBX5Z8Y7W6V5T4S3R2Q1P0NM');
    expect(name).toBe(`t-${'a'.repeat(35)}-W6V5T4S3R2Q1P0NM`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith(`t-${'a'.repeat(35)}-`)).toBe(true);
    expect(() => sessionName('A', 'x')).toThrow();
  });
});

describe('session freshness (spec §7.1, M-11)', () => {
  const sts = mockClient(STSClient);
  beforeEach(() => sts.reset());

  it('assumes with the TenantId tag and reuses a session only while it has the asked lifetime left', async () => {
    let now = NOW;
    sts.on(AssumeRoleCommand).callsFake(() => ({
      Credentials: { AccessKeyId: 'AKIAEXAMPLEEXAMPLE00', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(now + 3600_000) },
    }));
    const sessions = new TenantSessions(new STSClient({ region: 'eu-central-1' }), 'arn:aws:iam::111122223333:role/R', () => now);
    await sessions.credentials('tenant-a', 'op', 960_000);
    const input = sts.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(input.Tags).toEqual([{ Key: 'TenantId', Value: 'tenant-a' }]);
    expect(input.RoleSessionName).toBe('t-tenant-a-op');
    expect(input.DurationSeconds).toBe(3600);
    expect(input.Policy).toBeUndefined();

    now += 2_000_000; // 1600 s left
    await sessions.credentials('tenant-a', 'op', 960_000);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    now += 1_000_000; // 600 s left: below TTL + 60 s
    await sessions.credentials('tenant-a', 'op', 960_000);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it('refuses a tenant id that fails the grammar before any call', async () => {
    const sessions = new TenantSessions(new STSClient({ region: 'eu-central-1' }), 'arn:aws:iam::111122223333:role/R');
    await expect(sessions.credentials('Tenant/A', 'op', 1)).rejects.toThrow(/grammar/);
    expect(sts.calls()).toHaveLength(0);
  });
});

describe('logger (M-27)', () => {
  it('drops fields outside the allowlist and values that look like URLs or signatures; tenantId on every line', async () => {
    const { lines } = await captureStdout(async () => {
      log.info('x', {
        tenantId: 'tenant-a',
        fileName: 'case-4711.pdf',
        objectUrl: 'https://b.s3.amazonaws.com/k?X-Amz-Signature=abc',
        reason: 'https://evil.example.com/',
        code: 'OK',
      } as never);
      log.info('no tenant');
    });
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ level: 'INFO', message: 'x', tenantId: 'tenant-a', code: 'OK' });
    expect(JSON.parse(lines[1]).tenantId).toBe('-');
  });
});

describe('events (M-29)', () => {
  it('carries only the schema fields: no file name, key ARN or URL', () => {
    const detail = eventDetail({
      tenantId: 'tenant-a',
      deliveryId: 'D',
      landedKey: 'documents/tenant-a/D',
      sizeBytes: 1,
      contentType: 'application/pdf',
      ...({ fileName: 'x.pdf', keyArn: 'arn:aws:kms:eu-central-1:111122223333:key/k', uploadUrl: 'https://x' } as object),
    });
    expect(Object.keys(detail).sort()).toEqual(['contentType', 'deliveryId', 'landedKey', 'sizeBytes', 'tenantId']);
  });
});

describe('KMS classifier (M-18)', () => {
  it.each([
    [{ name: 'KMS.DisabledException', message: 'disabled' }, true],
    [{ name: 'KMS.KMSInvalidStateException', message: 'pending deletion' }, true],
    [{ name: 'AccessDenied', message: 'User: x is not authorized to perform: kms:GenerateDataKey on resource: y' }, true],
    [{ name: 'AccessDenied', message: 'Access Denied' }, false],
    [{ name: 'InternalError', message: 'oops' }, false],
  ])('classifies %j as KMS-sourced: %s', (error, expected) => {
    expect(isKmsSourced(Object.assign(new Error(error.message), { name: error.name }))).toBe(expected);
  });
});
