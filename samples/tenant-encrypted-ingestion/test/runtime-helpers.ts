// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Runtime test helpers: a mocked STS that vends invented credentials, and
 * tenant-session clients built over it. The SDK clients are real; their
 * `send` is mocked per test with aws-sdk-client-mock, and presigning is
 * local, so nothing reaches the network.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { TenantClients, type TenantCredentials, TenantSessions } from '../src/shared/tenant-session';

export const NOW = Date.parse('2026-11-05T12:00:00Z');
export const TABLE = 'registry-table';
export const BUCKET = 'ingestion-bucket-example';
export const KEY_ARN_A = 'arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-4000-8000-00000000000a';
export const KEY_ARN_B = 'arn:aws:kms:eu-central-1:444455556666:key/00000000-0000-4000-8000-00000000000b';
export const DELIVERY_ID = '01JBX5Z8Y7W6V5T4S3R2Q1P0NM';

export function mockSts(expiresInMs = 3600 * 1000, now = NOW) {
  const sts = mockClient(STSClient);
  sts.on(AssumeRoleCommand).callsFake(() => ({
    Credentials: {
      AccessKeyId: 'AKIAEXAMPLEEXAMPLE00',
      SecretAccessKey: 'example-secret-not-real',
      SessionToken: 'example-session-token',
      Expiration: new Date(now + expiresInMs),
    },
  }));
  return sts;
}

export interface Pair {
  readonly ddb: DynamoDBDocumentClient;
  readonly s3: S3Client;
}

export function tenantClients(roleArn = 'arn:aws:iam::111122223333:role/TenantRole', now = () => NOW): TenantClients<Pair> {
  const sessions = new TenantSessions(new STSClient({ region: 'eu-central-1' }), roleArn, now);
  return new TenantClients<Pair>(sessions, (credentials: TenantCredentials) => ({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1', credentials }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({ region: 'eu-central-1', credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
  }));
}

/** Captures stdout lines written during `fn`. */
export async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    spy.mockRestore();
  }
}
