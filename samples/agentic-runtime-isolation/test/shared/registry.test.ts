// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BACKEND_NAME_PATTERN,
  BackendRegistry,
  backendFromPath,
  isValidBackendName,
  parseRegistryEntry,
  RegistryError,
  registryParameterName,
} from '../../src/shared/registry';
import { REGISTRY_PREFIX, RUNTIME_ARN } from '../helpers';

/** The backend registry (ADR-0024): the entry schema, the route parser and the cached SSM client. */

const ENTRY = JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });

describe('parseRegistryEntry', () => {
  it('accepts a well-formed entry and defaults requiredScopes to none', () => {
    expect(parseRegistryEntry(ENTRY)).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });
    expect(parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, status: 'draining' }))).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: [], status: 'draining' });
  });

  it('refuses a malformed Runtime ARN', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: 'arn:aws:lambda:eu-central-1:111122223333:function:x', status: 'active' }))).toThrow(/runtimeArn/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: `${RUNTIME_ARN}/runtime-endpoint/DEFAULT`, status: 'active' }))).toThrow(/runtimeArn/);
    expect(() => parseRegistryEntry(JSON.stringify({ status: 'active' }))).toThrow(/runtimeArn/);
  });

  it('refuses scopes that are not a list of non-empty, space-free strings', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: 'tenant-api/write', status: 'active' }))).toThrow(/requiredScopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: [42], status: 'active' }))).toThrow(/requiredScopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: ['a b'], status: 'active' }))).toThrow(/requiredScopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: [''], status: 'active' }))).toThrow(/requiredScopes/);
  });

  it('refuses an unknown status', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, status: 'retired' }))).toThrow(/status/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN }))).toThrow(/status/);
  });

  it('refuses anything that is not a JSON object', () => {
    expect(() => parseRegistryEntry('not json')).toThrow(/not JSON/);
    expect(() => parseRegistryEntry('[1]')).toThrow(/not an object/);
    expect(() => parseRegistryEntry('null')).toThrow(/not an object/);
  });
});

describe('backend names and parameter names', () => {
  it('a name is 1 to 32 lower-case letters, digits and hyphens', () => {
    expect(isValidBackendName('agent')).toBe(true);
    expect(isValidBackendName('billing-2')).toBe(true);
    expect(isValidBackendName('a'.repeat(32))).toBe(true);
    expect(isValidBackendName('a'.repeat(33))).toBe(false);
    expect(isValidBackendName('Agent')).toBe(false);
    expect(isValidBackendName('agent_x')).toBe(false);
    expect(isValidBackendName('')).toBe(false);
    expect(isValidBackendName(42)).toBe(false);
    expect(BACKEND_NAME_PATTERN.source).toBe('^[a-z0-9-]{1,32}$');
  });

  it('the entry lives at <prefix>backends/<name>', () => {
    expect(registryParameterName(REGISTRY_PREFIX, 'agent')).toBe('/application-plane/shared/agent-runtime/backends/agent');
  });
});

describe('backendFromPath', () => {
  it('reads the name before /invocations, with or without a stage prefix or a query string', () => {
    expect(backendFromPath('/agent/invocations')).toBe('agent');
    expect(backendFromPath('/prod/agent/invocations')).toBe('agent');
    expect(backendFromPath('agent/invocations/')).toBe('agent');
    expect(backendFromPath('/agent/invocations?x=1')).toBe('agent');
  });

  it('the bare route resolves to the default backend, or to nothing', () => {
    expect(backendFromPath('/invocations', 'agent')).toBe('agent');
    expect(backendFromPath('/prod/invocations', 'agent')).toBe('prod');
    expect(backendFromPath('/invocations')).toBeUndefined();
    expect(backendFromPath(undefined, 'agent')).toBeUndefined();
  });

  it('an ill-formed name is nothing, even with a default', () => {
    expect(backendFromPath('/Agent/invocations', 'agent')).toBeUndefined();
    expect(backendFromPath('/a_b/invocations')).toBeUndefined();
    expect(backendFromPath(`/${'a'.repeat(33)}/invocations`)).toBeUndefined();
  });

  it('a path that does not end in /invocations is nothing', () => {
    expect(backendFromPath('/agent/other', 'agent')).toBeUndefined();
    expect(backendFromPath('/agent', 'agent')).toBeUndefined();
    expect(backendFromPath('/', 'agent')).toBeUndefined();
    expect(backendFromPath('', 'agent')).toBeUndefined();
  });
});

describe('BackendRegistry', () => {
  const ssm = mockClient(SSMClient);
  let clock: number;
  const now = () => clock;
  const registry = (ttlSeconds = 60) => new BackendRegistry({ prefix: REGISTRY_PREFIX, ttlSeconds }, new SSMClient({}), now);
  const miss = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RegistryError) {
        return error.reason;
      }
      throw error;
    }
    throw new Error('expected a RegistryError');
  };
  const notFound = () => new ParameterNotFound({ $metadata: {}, message: 'not found' });

  beforeEach(() => {
    ssm.reset();
    clock = 1_000_000;
  });

  it('a hit reads the parameter once and serves the cache within the TTL', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    const entry = await r.resolve('agent');
    expect(entry).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });
    clock += 59_000;
    expect(await r.resolve('agent')).toBe(entry);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    expect(ssm).toHaveReceivedCommandWith(GetParameterCommand, { Name: '/application-plane/shared/agent-runtime/backends/agent' });
    expect(r.prefix).toBe(REGISTRY_PREFIX);
  });

  it('a name SSM does not know is unknown_backend, and the miss is cached for the TTL', async () => {
    ssm.on(GetParameterCommand).rejects(notFound());
    const r = registry();
    expect(await miss(r.resolve('nope'))).toBe('unknown_backend');
    expect(await miss(r.resolve('nope'))).toBe('unknown_backend');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    // A parameter with no value is a miss too.
    ssm.on(GetParameterCommand).resolves({ Parameter: {} });
    expect(await miss(r.resolve('empty'))).toBe('unknown_backend');
  });

  it('an ill-formed name never reaches SSM', async () => {
    expect(await miss(registry().resolve('Agent'))).toBe('unknown_backend');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 0);
  });

  it('a draining backend is backend_draining', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ runtimeArn: RUNTIME_ARN, status: 'draining' }) } });
    expect(await miss(registry().resolve('old'))).toBe('backend_draining');
  });

  it('an entry the schema rejects is registry_entry_invalid', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: '{"runtimeArn":"nope","status":"active"}' } });
    expect(await miss(registry().resolve('bad'))).toBe('registry_entry_invalid');
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'not json' } });
    expect(await miss(registry().resolve('worse'))).toBe('registry_entry_invalid');
  });

  it('an SSM error with nothing cached is registry_unavailable, held for one TTL, then retried', async () => {
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    const r = registry();
    expect(await miss(r.resolve('agent'))).toBe('registry_unavailable');
    expect(await miss(r.resolve('agent'))).toBe('registry_unavailable');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    clock += 61_000;
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    expect((await r.resolve('agent')).runtimeArn).toBe(RUNTIME_ARN);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
  });

  it('an SSM error after the TTL serves the stale entry (stale-while-refresh)', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    const first = await r.resolve('agent');
    clock += 61_000;
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    expect(await r.resolve('agent')).toEqual(first);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
  });

  it('refreshes after the TTL and picks up a changed entry; a definite miss replaces a stale entry', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry(30);
    expect((await r.resolve('agent')).requiredScopes).toEqual(['tenant-api/write']);
    clock += 29_000;
    await r.resolve('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    clock += 2_000;
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: [], status: 'active' }) } });
    expect((await r.resolve('agent')).requiredScopes).toEqual([]);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
    clock += 31_000;
    ssm.on(GetParameterCommand).rejects(notFound());
    expect(await miss(r.resolve('agent'))).toBe('unknown_backend');
  });

  it('warm() pre-fetches an entry and swallows failures; undefined is a no-op', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    await r.warm('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    await r.resolve('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    await expect(r.warm('other')).resolves.toBeUndefined();
    await expect(r.warm(undefined)).resolves.toBeUndefined();
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
  });

  it('concurrent lookups of one cold name share a single SSM read', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    await Promise.all([r.resolve('agent'), r.resolve('agent'), r.resolve('agent')]);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
  });
});
