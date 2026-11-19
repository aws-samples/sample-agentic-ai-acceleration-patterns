// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test doubles for the registrar: an in-memory KeyValueStore behind
 * `aws-sdk-client-mock`, a fake control plane and token endpoint behind a
 * mocked `fetch`, and API Gateway REST events from either admitted role.
 * Accounts are obvious fakes; names are example.com.
 */

import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ResourceNotFoundException,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import type { RegistrarConfig } from '../../src/registrar/config';
import { ControlPlaneReader } from '../../src/registrar/control-plane';
import type { DedicatedDomains } from '../../src/registrar/dedicated-domains';
import { createHandler, type Handler } from '../../src/registrar/registrar.function';
import { KvsRouteStore } from '../../src/registrar/route-store';

export const EDGE_ACCOUNT = '123456789012';
export const CP_ACCOUNT = '210987654321';
export const CELL_ACCOUNT = '111111111111';
export const OTHER_ACCOUNT = '222222222222';

/** From `test/fixtures/route-table.json`. */
export const TENANT = '01HZX8K9P0QRST7VWXYZ1A2B3C';
export const TENANT_2 = '01HZX8K9P0QRST7VWXYZ1A2B3E';
export const CELL = '01HZX8K9P0QRST7VWXYZ1A2B3D';
export const CELL_2 = '01HZX8K9P0QRST7VWXYZ1A2B3H';
export const API_DOMAIN = 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-central-1.on.aws';
export const API_DOMAIN_2 = 'zyxwvutsrqponmlkjihgfedcba543210.lambda-url.eu-central-1.on.aws';
/** `createdAt` of the fixture's `dt` 1795080000000. */
export const CREATED_AT = '2026-11-19T09:20:00Z';
export const DT = 1795080000000;

export const ROUTE_TABLE_ARN = `arn:aws:cloudfront::${EDGE_ACCOUNT}:key-value-store/11111111-2222-3333-4444-555555555555`;

export function testConfig(overrides: Partial<RegistrarConfig> = {}): RegistrarConfig {
  return {
    routeTableArn: ROUTE_TABLE_ARN,
    appDomain: 'tenants.example.com',
    addressing: 'single',
    applicationId: 'demo-app',
    controlPlaneUrl: 'https://cp.example.com/prod',
    controlPlaneAccount: CP_ACCOUNT,
    controlPlaneRegion: 'eu-central-1',
    vendorIdpTokenUrl: 'https://auth.example.com/oauth2/token',
    vendorIdpClientId: 'registrarclient',
    vendorIdpSecretArn: `arn:aws:secretsmanager:eu-central-1:${EDGE_ACCOUNT}:secret:registrar-AbCdEf`,
    fleet: 'fleet1',
    edgeOperatorRoleArn: `arn:aws:iam::${EDGE_ACCOUNT}:role/ops/EdgeOperator`,
    dedicatedDomains: false,
    ...overrides,
  };
}

export const HOOK_ARN = `arn:aws:sts::${CP_ACCOUNT}:assumed-role/fleet1-global-hook/build-1`;
export const OPERATOR_ARN = `arn:aws:sts::${EDGE_ACCOUNT}:assumed-role/EdgeOperator/alice`;

export type Who = 'hook' | 'operator' | { readonly userArn: string; readonly accountId: string };

export function identityOf(who: Who): { userArn: string; accountId: string } {
  if (who === 'hook') return { userArn: HOOK_ARN, accountId: CP_ACCOUNT };
  if (who === 'operator') return { userArn: OPERATOR_ARN, accountId: EDGE_ACCOUNT };
  return { userArn: who.userArn, accountId: who.accountId };
}

/** A REST v1 proxy event, with the client's own header casing. */
export function restEvent(method: string, path: string, who: Who, body?: unknown): APIGatewayProxyEvent {
  const headers: Record<string, string> = body === undefined ? { Host: 'registrar.example.com' } : { 'Content-Type': 'application/json', 'Host': 'registrar.example.com' };
  const multiValueHeaders: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) multiValueHeaders[k] = [v];
  return {
    httpMethod: method,
    path,
    resource: path,
    headers,
    multiValueHeaders,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { identity: identityOf(who) } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

// ---------------------------------------------------------------------------
// In-memory KeyValueStore
// ---------------------------------------------------------------------------

export class MemoryKvs {
  readonly items = new Map<string, string>();
  version = 1;
  /** Extra size outside `items`, to bring the store near its limit. */
  padding = 0;
  /** Each UpdateKeys while this is positive fails with a conflict, as if another writer won. */
  conflicts = 0;
  /** Called after each Describe, to let a test write between the read and the write. */
  afterDescribe?: () => void;
  writes = 0;

  size(): number {
    let n = this.padding;
    for (const [k, v] of this.items) n += Buffer.byteLength(k) + Buffer.byteLength(v);
    return n;
  }

  get(key: string): string | undefined {
    return this.items.get(key);
  }

  set(key: string, value: string): void {
    this.items.set(key, value);
    this.version++;
  }
}

export const kvsMock = mockClient(CloudFrontKeyValueStoreClient);
export const secretsMock = mockClient(SecretsManagerClient);

export function installKvs(kvs: MemoryKvs): void {
  kvsMock.reset();
  kvsMock.on(DescribeKeyValueStoreCommand).callsFake(() => {
    const out = { ETag: `etag-${kvs.version}`, TotalSizeInBytes: kvs.size(), ItemCount: kvs.items.size };
    kvs.afterDescribe?.();
    return out;
  });
  kvsMock.on(GetKeyCommand).callsFake((input: { Key: string }) => {
    const value = kvs.items.get(input.Key);
    if (value === undefined) throw new ResourceNotFoundException({ message: 'key not found', $metadata: {} });
    return { Key: input.Key, Value: value, ItemCount: kvs.items.size, TotalSizeInBytes: kvs.size() };
  });
  kvsMock.on(UpdateKeysCommand).callsFake((input: { IfMatch: string; Puts?: { Key: string; Value: string }[]; Deletes?: { Key: string }[] }) => {
    if (kvs.conflicts > 0) {
      kvs.conflicts--;
      kvs.version++;
      throw new ConflictException({ message: 'etag mismatch', $metadata: {} });
    }
    if (input.IfMatch !== `etag-${kvs.version}`) throw new ConflictException({ message: 'etag mismatch', $metadata: {} });
    for (const d of input.Deletes ?? []) kvs.items.delete(d.Key);
    for (const p of input.Puts ?? []) kvs.items.set(p.Key, p.Value);
    kvs.version++;
    kvs.writes++;
    return { ETag: `etag-${kvs.version}`, TotalSizeInBytes: kvs.size(), ItemCount: kvs.items.size };
  });
}

// ---------------------------------------------------------------------------
// Fake control plane and token endpoint
// ---------------------------------------------------------------------------

export interface FakeCell {
  applicationId?: string;
  accountId?: string;
  status: string;
}

export interface FakeDeployment {
  applicationId?: string;
  cellId?: string;
  accountId?: string;
  status: string;
  createdAt?: unknown;
}

export class FakeControlPlane {
  readonly cells = new Map<string, FakeCell>();
  readonly deployments = new Map<string, FakeDeployment>();
  readonly tenants = new Map<string, { name: string }>();
  /** When set, every control-plane GET answers this status. */
  failWith?: number;
  /** When set, the token endpoint answers this status. */
  tokenStatus = 200;
  tokenExpiresIn = 3600;
  tokenCalls = 0;
  reads: string[] = [];
  readonly token = 'reader-token-1';

  readonly fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u === 'https://auth.example.com/oauth2/token') {
      this.tokenCalls++;
      if (this.tokenStatus !== 200) return new Response('{}', { status: this.tokenStatus });
      return Response.json({ access_token: this.token, expires_in: this.tokenExpiresIn, token_type: 'Bearer' });
    }
    const path = u.replace('https://cp.example.com/prod', '');
    this.reads.push(path);
    if ((init?.headers as Record<string, string>).authorization !== `Bearer ${this.token}`) return new Response('{}', { status: 401 });
    if (this.failWith !== undefined) return new Response('{}', { status: this.failWith });
    let m = /^\/cells\/([0-9A-Z]{26})$/.exec(path);
    if (m) {
      const c = this.cells.get(m[1]);
      if (!c) return notFound();
      return Response.json({
        cell: { cellId: m[1], applicationId: c.applicationId ?? 'demo-app', accountId: c.accountId ?? CELL_ACCOUNT, status: c.status },
        parameters: {},
      });
    }
    m = /^\/tenants\/([0-9A-Z]{26})\/deployments\/([a-z0-9-]+)$/.exec(path);
    if (m) {
      const d = this.deployments.get(`${m[1]}/${m[2]}`);
      if (!d) return notFound();
      return Response.json({
        deployment: {
          tenantId: m[1],
          applicationId: d.applicationId ?? m[2],
          cellId: d.cellId ?? CELL,
          status: d.status,
          createdAt: 'createdAt' in d ? d.createdAt : CREATED_AT,
          updatedAt: CREATED_AT,
        },
        accountId: d.accountId ?? CELL_ACCOUNT,
        parameters: {},
      });
    }
    m = /^\/tenants\/([0-9A-Z]{26})$/.exec(path);
    if (m) {
      const t = this.tenants.get(m[1]);
      if (!t) return notFound();
      return Response.json({ tenant: { tenantId: m[1], name: t.name, deploymentCount: 1, createdAt: CREATED_AT, updatedAt: CREATED_AT } });
    }
    return new Response('{"message":"Missing Authentication Token"}', { status: 403 });
  });

  deployment(tenantId: string, d: FakeDeployment): void {
    this.deployments.set(`${tenantId}/demo-app`, d);
  }
}

function notFound(): Response {
  return new Response('{"message":"not found"}', { status: 404, headers: { 'x-amzn-errortype': 'ResourceNotFoundError' } });
}

// ---------------------------------------------------------------------------
// The handler, wired to the doubles
// ---------------------------------------------------------------------------

export interface Harness {
  readonly handler: Handler;
  readonly kvs: MemoryKvs;
  readonly cp: FakeControlPlane;
  readonly domains: { putTenantDomain: jest.Mock; releaseDomain: jest.Mock };
  readonly sleeps: number[];
}

export function harness(config: RegistrarConfig = testConfig(), domains?: DedicatedDomains): Harness {
  const kvs = new MemoryKvs();
  installKvs(kvs);
  secretsMock.reset();
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'client-secret-value' });
  const cp = new FakeControlPlane();
  const sleeps: number[] = [];
  const fakeDomains = {
    putTenantDomain: jest.fn(async (...args: unknown[]) => domains!.putTenantDomain(...(args as [never]))),
    releaseDomain: jest.fn(async () => undefined),
  };
  const handler = createHandler({
    config,
    controlPlane: new ControlPlaneReader({
      baseUrl: config.controlPlaneUrl,
      tokenUrl: config.vendorIdpTokenUrl,
      clientId: config.vendorIdpClientId,
      secretArn: config.vendorIdpSecretArn,
      secrets: new SecretsManagerClient({}),
      fetch: cp.fetch as unknown as typeof fetch,
    }),
    store: new KvsRouteStore({
      client: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
      arn: config.routeTableArn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
    domains: fakeDomains,
  });
  return { handler, kvs, cp, domains: fakeDomains, sleeps };
}

export function json(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}
