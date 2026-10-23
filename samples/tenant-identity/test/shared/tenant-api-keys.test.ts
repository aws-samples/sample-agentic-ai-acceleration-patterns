// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  GetUsagePlansCommand,
} from '@aws-sdk/client-api-gateway';
import { mockClient } from 'aws-sdk-client-mock';
import { ApiGatewayTenantApiKeys } from '../../src/shared/tenant-api-keys';

/**
 * Unit tests for the per-tenant API keys (ADR-0025): create a generated,
 * enabled key named tenant-<id>, add it to the stack's usage plan (found by
 * name, once), roll the key back when the plan step fails, and delete
 * idempotently.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const apigw: any = mockClient(APIGatewayClient as any);
const PLAN_NAME = 'TenantIdentity-shared-pool-tenant';
const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';

const STACK = 'TenantIdentity-shared-pool';

function keys(name: string = PLAN_NAME): ApiGatewayTenantApiKeys {
  return new ApiGatewayTenantApiKeys(new APIGatewayClient({ region: 'eu-central-1' }), name, STACK);
}

const notFound = () => Object.assign(new Error('Invalid API Key identifier specified'), { name: 'NotFoundException' });

beforeEach(() => {
  apigw.reset();
  apigw.on(GetUsagePlansCommand).resolves({ items: [{ id: 'plan-1', name: PLAN_NAME }, { id: 'plan-x', name: 'other' }] });
  apigw.on(CreateApiKeyCommand).resolves({ id: 'key-1', value: 'generated-value-0123456789' });
  apigw.on(CreateUsagePlanKeyCommand).resolves({});
  apigw.on(DeleteApiKeyCommand).resolves({});
});

describe('ApiGatewayTenantApiKeys.create (ADR-0025)', () => {
  it('creates an enabled key named tenant-<id>, tagged with the stack, with a generated value, and adds it to the plan', async () => {
    const out = await keys().create(TENANT_A);

    expect(out).toEqual({ apiKeyId: 'key-1', apiKeyValue: 'generated-value-0123456789' });
    const create = apigw.commandCalls(CreateApiKeyCommand)[0].args[0].input;
    // No value is passed: API Gateway generates it.
    // The stack tag is what the IAM delete condition checks (T-7).
    expect(create).toEqual({ name: `tenant-${TENANT_A}`, enabled: true, tags: { 'tenant-identity:stack': STACK } });
    expect(apigw.commandCalls(CreateUsagePlanKeyCommand)[0].args[0].input).toEqual({
      usagePlanId: 'plan-1',
      keyId: 'key-1',
      keyType: 'API_KEY',
    });
  });

  it.each([undefined, ''])('refuses to create a key without a stack name (%p), calling nothing', async (stack) => {
    const noStack = new ApiGatewayTenantApiKeys(new APIGatewayClient({ region: 'eu-central-1' }), PLAN_NAME, stack);
    await expect(noStack.create(TENANT_A)).rejects.toThrow('requires the stack name');
    expect(apigw.calls()).toHaveLength(0);
  });

  it('looks the plan up once per execution environment', async () => {
    const k = keys();
    await k.create(TENANT_A);
    await k.create(TENANT_A);
    expect(apigw.commandCalls(GetUsagePlansCommand)).toHaveLength(1);
  });

  it('pages through usage plans to find the stack\'s plan', async () => {
    apigw
      .on(GetUsagePlansCommand)
      .resolvesOnce({ items: [{ id: 'p0', name: 'a' }], position: 'next' })
      .resolvesOnce({ items: [{ id: 'plan-9', name: PLAN_NAME }] });
    await keys().create(TENANT_A);
    expect(apigw.commandCalls(GetUsagePlansCommand)[1].args[0].input.position).toBe('next');
    expect(apigw.commandCalls(CreateUsagePlanKeyCommand)[0].args[0].input.usagePlanId).toBe('plan-9');
  });

  it.each([
    ['no plan', []],
    ['two plans', [{ id: 'a', name: PLAN_NAME }, { id: 'b', name: PLAN_NAME }]],
  ])('refuses to guess when the name matches %s, and creates no key', async (_label, items) => {
    apigw.on(GetUsagePlansCommand).resolves({ items });
    await expect(keys().create(TENANT_A)).rejects.toThrow(/exactly one usage plan/);
    expect(apigw.commandCalls(CreateApiKeyCommand)).toHaveLength(0);
  });

  it('a failed lookup is retried on the next call, not cached', async () => {
    apigw.on(GetUsagePlansCommand).rejectsOnce(new Error('throttled')).resolves({ items: [{ id: 'plan-1', name: PLAN_NAME }] });
    const k = keys();
    await expect(k.create(TENANT_A)).rejects.toThrow('throttled');
    await expect(k.create(TENANT_A)).resolves.toMatchObject({ apiKeyId: 'key-1' });
  });

  it('without a plan name (the drain) create is refused', async () => {
    const drainKeys = new ApiGatewayTenantApiKeys(new APIGatewayClient({ region: 'eu-central-1' }), undefined);
    await expect(drainKeys.create(TENANT_A)).rejects.toThrow(/requires the/);
    expect(apigw.commandCalls(CreateApiKeyCommand)).toHaveLength(0);
  });

  it('deletes the new key and rethrows when adding it to the plan fails', async () => {
    apigw.on(CreateUsagePlanKeyCommand).rejects(Object.assign(new Error('conflict'), { name: 'ConflictException' }));
    await expect(keys().create(TENANT_A)).rejects.toMatchObject({ name: 'ConflictException' });
    expect(apigw.commandCalls(DeleteApiKeyCommand)[0].args[0].input).toEqual({ apiKey: 'key-1' });
  });

  it('surfaces the plan error even when the roll-back delete also fails', async () => {
    apigw.on(CreateUsagePlanKeyCommand).rejects(Object.assign(new Error('conflict'), { name: 'ConflictException' }));
    apigw.on(DeleteApiKeyCommand).rejects(new Error('throttled'));
    await expect(keys().create(TENANT_A)).rejects.toMatchObject({ name: 'ConflictException' });
  });

  it('refuses a key without id or value', async () => {
    apigw.on(CreateApiKeyCommand).resolves({ id: 'key-1' });
    await expect(keys().create(TENANT_A)).rejects.toThrow(/id and value/);
    expect(apigw.commandCalls(CreateUsagePlanKeyCommand)).toHaveLength(0);
  });
});

describe('ApiGatewayTenantApiKeys.delete (ADR-0025)', () => {
  it('deletes the key by id', async () => {
    await keys().delete('key-1');
    expect(apigw.commandCalls(DeleteApiKeyCommand)[0].args[0].input).toEqual({ apiKey: 'key-1' });
    // Deleting needs no plan lookup.
    expect(apigw.commandCalls(GetUsagePlansCommand)).toHaveLength(0);
  });

  it('is a no-op for a tenant with no key', async () => {
    await keys().delete(undefined);
    expect(apigw.commandCalls(DeleteApiKeyCommand)).toHaveLength(0);
  });

  it('treats an already-deleted key as done (idempotent)', async () => {
    apigw.on(DeleteApiKeyCommand).rejects(notFound());
    await expect(keys().delete('key-1')).resolves.toBeUndefined();
  });

  it('rethrows any other error', async () => {
    apigw.on(DeleteApiKeyCommand).rejects(Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' }));
    await expect(keys().delete('key-1')).rejects.toMatchObject({ name: 'TooManyRequestsException' });
  });
});
