// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for the teardown custom-resource handler (ADR-0022). The topology
 * module and registry are mocked so cold-start wiring loads without the real
 * AWS clients, matching platform.function.test.ts. The handler is driven with
 * injected deps and an injected `send`, so no HTTP PUT leaves the test.
 *
 * Proves: Create answers SUCCESS without draining; Delete drains then answers
 * SUCCESS; a failing drain answers FAILED with Reason = the error class name
 * only (N-6); and the response body carries the five CloudFormation fields.
 */

import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { ENV } from '../../src/shared/constants';
import type { DrainDeps } from '../../src/teardown/tenant-drain';

// Mock the topology barrel so cold start does not build real Cognito clients
// (and the sibling files may be mid-build in a parallel run).
jest.mock('../../src/topology', () => ({
  createProvisioner: () => ({ topology: 'pool-per-tenant' }),
}));

// Avoid constructing a real DynamoDB registry at cold start.
jest.mock('../../src/shared/registry', () => ({
  DynamoDBRegistry: class {},
}));

process.env[ENV.topology] = 'pool-per-tenant';
process.env[ENV.tableName] = 'registry-table';
process.env[ENV.poolIndexName] = 'byUserPoolId';
process.env.AWS_REGION = 'eu-central-1';

// Import after the mocks and env are set so cold-start wiring uses them.
// eslint-disable-next-line import/order
import { handle, respond, type CfnResponseBody } from '../../src/teardown/tenant-drain.function';

const BASE = {
  ServiceToken: 'arn:aws:lambda:eu-central-1:123456789012:function:drain',
  ResponseURL: 'https://cfn.example/presigned',
  StackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/TenantIdentity/abc',
  RequestId: 'req-1',
  LogicalResourceId: 'TenantDrainResource',
  ResourceType: 'Custom::TenantDrain',
  ResourceProperties: { ServiceToken: 'arn:aws:lambda:eu-central-1:123456789012:function:drain' },
};

function deleteEvent(): CloudFormationCustomResourceEvent {
  return {
    ...BASE,
    RequestType: 'Delete',
    PhysicalResourceId: 'tenant-drain',
  } as CloudFormationCustomResourceEvent;
}

function createEvent(): CloudFormationCustomResourceEvent {
  return { ...BASE, RequestType: 'Create' } as CloudFormationCustomResourceEvent;
}

/** A captured `send`: records the body CloudFormation would receive. */
function capturingSend(): { send: jest.Mock; last: () => CfnResponseBody } {
  const bodies: string[] = [];
  const send = jest.fn(async (_url: string, body: string) => {
    bodies.push(body);
  });
  return { send, last: () => JSON.parse(bodies[bodies.length - 1]) as CfnResponseBody };
}

function depsMock(overrides: Partial<{ deprovisionThrows: boolean; items: string[] }> = {}): {
  deps: DrainDeps;
  calls: { markDeleting: string[]; deprovision: number; delete: string[] };
} {
  const items = (overrides.items ?? ['A']).map((tenantId) => ({
    tenantId,
    name: tenantId,
    status: 'ACTIVE' as const,
    topology: 'pool-per-tenant' as const,
    userPoolId: `eu-central-1_${tenantId}`,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  }));
  const calls = { markDeleting: [] as string[], deprovision: 0, delete: [] as string[] };
  const deps = {
    registry: {
      list: jest.fn().mockResolvedValue({ items, nextToken: undefined }),
      markDeleting: jest.fn(async (tenantId: string) => {
        calls.markDeleting.push(tenantId);
        return { ...items.find((i) => i.tenantId === tenantId)!, status: 'DELETING' as const };
      }),
      delete: jest.fn(async (tenantId: string) => {
        calls.delete.push(tenantId);
      }),
      get: jest.fn(),
      batchGet: jest.fn(),
      getByUserPoolId: jest.fn(),
      create: jest.fn(),
    },
    provisioner: {
      topology: 'pool-per-tenant',
      deprovisionTenant: jest.fn(async () => {
        calls.deprovision++;
        if (overrides.deprovisionThrows) {
          throw new TypeError('secret cognito detail');
        }
      }),
    },
  } as unknown as DrainDeps;
  return { deps, calls };
}

describe('tenant-drain.function handler (ADR-0022)', () => {
  it('Create -> SUCCESS without draining', async () => {
    const { send, last } = capturingSend();
    const { deps, calls } = depsMock();

    await handle(createEvent(), { deps, send });

    expect(calls.markDeleting).toEqual([]);
    expect(calls.deprovision).toBe(0);
    expect(last().Status).toBe('SUCCESS');
  });

  it('Delete -> drains and answers SUCCESS', async () => {
    const { send, last } = capturingSend();
    const { deps, calls } = depsMock({ items: ['A', 'B'] });

    await handle(deleteEvent(), { deps, send });

    expect(calls.markDeleting).toEqual(['A', 'B']);
    expect(calls.deprovision).toBe(2);
    expect(calls.delete).toEqual(['A', 'B']);
    expect(last().Status).toBe('SUCCESS');
  });

  it('Delete with a failing drain -> FAILED with Reason = error class name only (N-6)', async () => {
    const { send, last } = capturingSend();
    const { deps } = depsMock({ deprovisionThrows: true });

    await handle(deleteEvent(), { deps, send });

    const body = last();
    expect(body.Status).toBe('FAILED');
    expect(body.Reason).toBe('TypeError');
    // The message must never reach the response.
    expect(body.Reason).not.toContain('secret');
  });

  it('response body carries the five CloudFormation fields', async () => {
    const { send, last } = capturingSend();
    const { deps } = depsMock();

    await handle(deleteEvent(), { deps, send });

    const body = last();
    expect(body).toEqual(
      expect.objectContaining({
        Status: 'SUCCESS',
        PhysicalResourceId: 'tenant-drain',
        StackId: BASE.StackId,
        RequestId: BASE.RequestId,
        LogicalResourceId: BASE.LogicalResourceId,
      }),
    );
  });

  it('respond defaults PhysicalResourceId to tenant-drain when the event has none', async () => {
    const { send, last } = capturingSend();
    const event = { ...createEvent() } as CloudFormationCustomResourceEvent;
    // Create events have no PhysicalResourceId.
    await respond(event, 'SUCCESS', 'ok', send);
    expect(last().PhysicalResourceId).toBe('tenant-drain');
  });

  it('a response is always sent (try/finally), even on success path', async () => {
    const { send } = capturingSend();
    const { deps } = depsMock();
    await handle(deleteEvent(), { deps, send });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
