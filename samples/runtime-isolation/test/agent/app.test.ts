// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { buildReport, NONCE, promptOf, unverifiedClaims, type AgentClients } from '../../src/agent/app';
import { encodeCredentials, RUNTIME_HEADERS } from '../../src/backend/agentcore-runtime.transport';

/** The echo agent (spec C-2) reports what reached it and never echoes a header value. */
const credentials = { accessKeyId: 'ASIA-SYNTHETIC', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token', expiration: '2026-01-01T00:15:00.000Z' };
const token = `h.${Buffer.from(JSON.stringify({ tenant_id: 'tenant-a', scope: 'tenant-api/read', sub: 'user-a1' })).toString('base64url')}.sig`;

const clients = (items: Record<string, Record<string, unknown>>, deny = false): AgentClients & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    sent,
    sts: () => ({
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { Arn: 'arn:aws:sts::111122223333:assumed-role/tenant/tenant-tenant-a' } as any;
      },
    }),
    dynamo: () => ({
      send: async (cmd: unknown) => {
        sent.push(cmd);
        if (deny) {
          const e = new Error('denied');
          e.name = 'AccessDeniedException';
          throw e;
        }
        const key = (cmd as GetItemCommand).input.Key!.PK.S!;
        return { Item: items[key] } as any;
      },
    }),
  };
};

describe('promptOf', () => {
  it('accepts prompt at the top level or under input; refuses non-strings', () => {
    expect(promptOf('{"prompt":"hi"}')).toBe('hi');
    expect(promptOf('{"input":{"prompt":"hi"}}')).toBe('hi');
    expect(promptOf('{"prompt":42}')).toBeUndefined();
    expect(promptOf('{}')).toBeUndefined();
    expect(promptOf('')).toBeUndefined();
    expect(promptOf('nope')).toBeUndefined();
  });
});

describe('unverifiedClaims', () => {
  it('decodes tenant_id and scope for display only', () => {
    expect(unverifiedClaims(token)).toEqual({ tenant_id: 'tenant-a', scope: 'tenant-api/read' });
    expect(unverifiedClaims('garbage')).toBeNull();
  });
});

describe('buildReport', () => {
  it('reports the unit id, its prefix, the per-VM nonce, and no token or credentials when none arrived', async () => {
    const report = await buildReport({ [RUNTIME_HEADERS.SESSION_ID.toLowerCase()]: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001' }, 'hello', undefined);
    expect(report).toEqual({
      nonce: NONCE,
      unitId: 's-abcdefghijklmnopqrstuvwxyz-conversationA1x0001',
      sessionPrefix: 'abcdefghijklmnopqrstuvwxyz',
      forwardedToken: false,
      forwardedTenant: null,
      forwardedScope: null,
      credentials: false,
    });
    expect(NONCE).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the forwarded token by its non-secret claims, never the token itself', async () => {
    const report = await buildReport({ [RUNTIME_HEADERS.USER_TOKEN.toLowerCase()]: token }, 'hello', undefined);
    expect(report.forwardedToken).toBe(true);
    expect(report.forwardedTenant).toBe('tenant-a');
    expect(report.forwardedScope).toBe('tenant-api/read');
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("'read <tenant>' uses the vended credentials and returns the item; the caller ARN is reported", async () => {
    const c = clients({ 'TENANT#tenant-a': { PK: { S: 'TENANT#tenant-a' }, secret: { S: 'alpha' } } });
    const report = await buildReport(
      { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) },
      'read tenant-a',
      'demo-table',
      c,
    );
    expect(report.credentials).toBe(true);
    expect(report.callerArn).toBe('arn:aws:sts::111122223333:assumed-role/tenant/tenant-tenant-a');
    expect(report.read).toEqual({ tenant: 'tenant-a', result: 'ok', item: { PK: 'TENANT#tenant-a', secret: 'alpha' } });
    expect(c.sent[0]).toBeInstanceOf(GetCallerIdentityCommand);
    expect((c.sent[1] as GetItemCommand).input).toEqual({ TableName: 'demo-table', Key: { PK: { S: 'TENANT#tenant-a' } } });
    expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  });

  it("'read <other tenant>' surfaces IAM's refusal by name (the wall is IAM, P-8)", async () => {
    const report = await buildReport(
      { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) },
      'read tenant-b',
      'demo-table',
      clients({}, true),
    );
    expect(report.read).toEqual({ tenant: 'tenant-b', result: 'error', error: 'AccessDeniedException' });
  });

  it("'read' without credentials, without a table, or with a malformed header reports why", async () => {
    expect((await buildReport({}, 'read tenant-a', 'demo-table')).read).toEqual({ tenant: 'tenant-a', result: 'error', error: 'NoCredentials' });
    const h = { [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: encodeCredentials(credentials) };
    expect((await buildReport(h, 'read tenant-a', undefined)).read).toEqual({ tenant: 'tenant-a', result: 'error', error: 'NoTable' });
    expect((await buildReport({ [RUNTIME_HEADERS.TENANT_CREDENTIALS.toLowerCase()]: 'bad' }, 'read tenant-a', 't')).read).toEqual({
      tenant: 'tenant-a',
      result: 'error',
      error: 'MalformedCredentials',
    });
  });
});
