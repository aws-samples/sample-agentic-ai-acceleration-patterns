// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BACKEND_NAME_PATTERN,
  BackendRegistry,
  backendFromPath,
  backendScopesProblem,
  isValidBackendName,
  isValidScopeName,
  MAX_STALE_TTL_MULTIPLE,
  parseRegistryEntry,
  partitionOf,
  REFRESH_RETRY_SECONDS,
  RegistryError,
  registryParameterName,
  SCOPE_NAME_PATTERN,
  scopeOwner,
} from '../../src/shared/registry';
import { REGISTRY_PREFIX, RUNTIME_ARN } from '../helpers';

/** The backend registry (ADR-0024): the entry schema, the route parser and the cached SSM client. */

const SCOPES = ['billing/read', 'billing/invoke'];
const ENTRY = JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: SCOPES, status: 'active' });

describe('scope names (ADR-0025, tenant-identity ScopeName)', () => {
  it('isValidScopeName: <owner>/<action> of [a-z0-9-], 3 to 128 characters', () => {
    expect(SCOPE_NAME_PATTERN.source).toBe('^[a-z0-9-]+\\/[a-z0-9-]+$');
    for (const ok of ['a/b', 'default/chat', 'billing/invoke', 'tenant-admin/users', `x/${'y'.repeat(126)}`]) {
      expect(isValidScopeName(ok)).toBe(true);
    }
    for (const bad of ['', 'ab', 'a/', '/b', 'noslash', 'a/b/c', 'A/b', 'a/B', 'a b/c', 'a/b ', `x/${'y'.repeat(127)}`, 42, undefined, null]) {
      expect(isValidScopeName(bad)).toBe(false);
    }
  });

  it('scopeOwner is the text before the slash', () => {
    expect(scopeOwner('billing/read')).toBe('billing');
    expect(scopeOwner('default/chat')).toBe('default');
  });

  it('backendScopesProblem: at least one, every one valid and owned by the backend, no repeats; undefined when acceptable', () => {
    expect(backendScopesProblem('billing', ['billing/read', 'billing/invoke'])).toBeUndefined();
    expect(backendScopesProblem('default', ['default/chat'])).toBeUndefined();
    expect(backendScopesProblem('billing', [])).toMatch(/at least one scope/);
    expect(backendScopesProblem('billing', ['billing/read', 'billing/read'])).toMatch(/must not repeat/);
    expect(backendScopesProblem('billing', ['billing/Read'])).toMatch(/'billing\/Read' must match/);
    expect(backendScopesProblem('billing', ['billing'])).toMatch(/'billing' must match/);
    expect(backendScopesProblem('billing', ['billing/read', 'default/chat'])).toMatch(/'default\/chat' must be owned by this backend: billing\/<action>/);
    expect(backendScopesProblem('billing', ['billing-2/read'])).toMatch(/must be owned by this backend/);
    // The first problem in list order is the one reported.
    expect(backendScopesProblem('billing', ['x/y', 'billing/read', 'billing/read'])).toMatch(/'x\/y' must be owned/);
  });
});

describe('parseRegistryEntry', () => {
  it('accepts a well-formed entry; an empty scope list parses (and admits nothing at the ingress)', () => {
    expect(parseRegistryEntry(ENTRY)).toEqual({ runtimeArn: RUNTIME_ARN, scopes: SCOPES, status: 'active' });
    expect(parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: [], status: 'draining' }))).toEqual({ runtimeArn: RUNTIME_ARN, scopes: [], status: 'draining' });
  });

  it('refuses an entry without scopes, so a pre-ADR-0025 requiredScopes entry is 502, not "no scopes"', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, status: 'active' }))).toThrow(/scopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, requiredScopes: ['x/y'], status: 'active' }))).toThrow(/scopes/);
  });

  it('refuses a malformed Runtime ARN', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: 'arn:aws:lambda:eu-central-1:111122223333:function:x', status: 'active' }))).toThrow(/runtimeArn/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: `${RUNTIME_ARN}/runtime-endpoint/DEFAULT`, status: 'active' }))).toThrow(/runtimeArn/);
    expect(() => parseRegistryEntry(JSON.stringify({ status: 'active' }))).toThrow(/runtimeArn/);
  });

  it('refuses scopes that are not a list of non-empty, space-free strings', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: 'billing/read', status: 'active' }))).toThrow(/scopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: [42], status: 'active' }))).toThrow(/scopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: ['a b'], status: 'active' }))).toThrow(/scopes/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: [''], status: 'active' }))).toThrow(/scopes/);
  });

  it('refuses an unknown status', () => {
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: SCOPES, status: 'retired' }))).toThrow(/status/);
    expect(() => parseRegistryEntry(JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: SCOPES }))).toThrow(/status/);
  });

  it('refuses anything that is not a JSON object', () => {
    expect(() => parseRegistryEntry('not json')).toThrow(/not JSON/);
    expect(() => parseRegistryEntry('[1]')).toThrow(/not an object/);
    expect(() => parseRegistryEntry('null')).toThrow(/not an object/);
  });

  describe('the Runtime ARN must be in the ingress partition, Region and account', () => {
    const scope = { region: 'eu-central-1', account: '111122223333' };

    it('accepts an ARN that matches', () => {
      expect(parseRegistryEntry(ENTRY, scope).runtimeArn).toBe(RUNTIME_ARN);
    });

    it('refuses another Region, and another partition for the same Region name', () => {
      const other = JSON.stringify({ runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(() => parseRegistryEntry(other, scope)).toThrow(/Region/);
      const partition = JSON.stringify({ runtimeArn: 'arn:aws-cn:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(() => parseRegistryEntry(partition, scope)).toThrow(/Region/);
      const cn = JSON.stringify({ runtimeArn: 'arn:aws-cn:bedrock-agentcore:cn-north-1:111122223333:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(parseRegistryEntry(cn, { region: 'cn-north-1' }).runtimeArn).toContain('cn-north-1');
      expect(() => parseRegistryEntry(ENTRY, { region: 'cn-north-1' })).toThrow(/Region/);
    });

    it('refuses another account', () => {
      const other = JSON.stringify({ runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:444455556666:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(() => parseRegistryEntry(other, scope)).toThrow(/account/);
    });

    it('an absent account or Region skips that check', () => {
      const other = JSON.stringify({ runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:444455556666:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(parseRegistryEntry(other, { region: 'eu-central-1' }).runtimeArn).toContain('444455556666');
      const elsewhere = JSON.stringify({ runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/ri_x-1', scopes: SCOPES, status: 'active' });
      expect(parseRegistryEntry(elsewhere, { account: '111122223333' }).runtimeArn).toContain('us-east-1');
      expect(parseRegistryEntry(elsewhere).runtimeArn).toContain('us-east-1');
    });
  });

  it('partitionOf derives the partition from the Region', () => {
    expect(partitionOf('eu-central-1')).toBe('aws');
    expect(partitionOf('cn-northwest-1')).toBe('aws-cn');
    expect(partitionOf('us-gov-west-1')).toBe('aws-us-gov');
    expect(partitionOf('us-east-1')).toBe('aws');
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
  it('reads the name before /invocations, with or without a trailing slash or a query string', () => {
    expect(backendFromPath('/agent/invocations')).toBe('agent');
    expect(backendFromPath('agent/invocations/')).toBe('agent');
    expect(backendFromPath('/agent/invocations?x=1')).toBe('agent');
  });

  it('the bare route resolves to the default backend, or to nothing', () => {
    expect(backendFromPath('/invocations', 'agent')).toBe('agent');
    expect(backendFromPath('/invocations/', 'agent')).toBe('agent');
    expect(backendFromPath('/invocations')).toBeUndefined();
    expect(backendFromPath(undefined, 'agent')).toBeUndefined();
  });

  it('a stage prefix is not tolerated: the ingresses hand the path stage-stripped', () => {
    expect(backendFromPath('/prod/agent/invocations')).toBeUndefined();
    // Two segments are always `<name>/invocations`: a stage name in that
    // position is read as a backend called `prod`, which the registry then
    // resolves or refuses; there is no stage to strip here.
    expect(backendFromPath('/prod/invocations', 'agent')).toBe('prod');
  });

  it('an ill-formed name is nothing, even with a default; the route word is not a name', () => {
    expect(backendFromPath('/Agent/invocations', 'agent')).toBeUndefined();
    expect(backendFromPath('/a_b/invocations')).toBeUndefined();
    expect(backendFromPath(`/${'a'.repeat(33)}/invocations`)).toBeUndefined();
    expect(backendFromPath('/invocations/invocations', 'agent')).toBeUndefined();
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
    expect(entry).toEqual({ runtimeArn: RUNTIME_ARN, scopes: SCOPES, status: 'active' });
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
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: SCOPES, status: 'draining' }) } });
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

  it('a failed refresh of a stale entry holds for REFRESH_RETRY_SECONDS: a request storm during an outage does not read SSM per request', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    const first = await r.resolve('agent');
    clock += 61_000;
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    for (let i = 0; i < 10; i += 1) {
      expect(await r.resolve('agent')).toEqual(first);
    }
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
    clock += REFRESH_RETRY_SECONDS * 1000 - 1;
    expect(await r.resolve('agent')).toEqual(first);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 2);
    clock += 1;
    expect(await r.resolve('agent')).toEqual(first);
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 3);
    // Once SSM is back the next retry refreshes and the normal TTL resumes.
    clock += REFRESH_RETRY_SECONDS * 1000;
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: ['default/chat'], status: 'active' }) } });
    expect((await r.resolve('agent')).scopes).toEqual(['default/chat']);
    clock += 59_000;
    await r.resolve('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 4);
  });

  it('the retry hold never exceeds the TTL', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry(2);
    await r.resolve('agent');
    clock += 2_000;
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    await r.resolve('agent');
    clock += 2_000;
    await r.resolve('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 3);
  });

  it(`a stale entry older than ${MAX_STALE_TTL_MULTIPLE} TTLs is dropped: the miss is registry_unavailable, held for one TTL`, async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry();
    const fetchedAt = clock;
    const first = await r.resolve('agent');
    ssm.on(GetParameterCommand).rejects(new Error('ThrottlingException'));
    // Served stale right up to the ceiling.
    clock = fetchedAt + MAX_STALE_TTL_MULTIPLE * 60_000;
    expect(await r.resolve('agent')).toEqual(first);
    clock += REFRESH_RETRY_SECONDS * 1000;
    expect(await miss(r.resolve('agent'))).toBe('registry_unavailable');
    const reads = ssm.commandCalls(GetParameterCommand).length;
    expect(await miss(r.resolve('agent'))).toBe('registry_unavailable');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, reads);
    clock += 60_000;
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    expect(await r.resolve('agent')).toEqual(first);
  });

  it('the Region and account the registry is configured with are applied to every entry', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const scoped = (region: string, account?: string) =>
      new BackendRegistry({ prefix: REGISTRY_PREFIX, ttlSeconds: 60, region, account }, new SSMClient({}), now);
    expect((await scoped('eu-central-1', '111122223333').resolve('agent')).runtimeArn).toBe(RUNTIME_ARN);
    expect(await miss(scoped('us-east-1', '111122223333').resolve('agent'))).toBe('registry_entry_invalid');
    expect(await miss(scoped('eu-central-1', '444455556666').resolve('agent'))).toBe('registry_entry_invalid');
    expect((await scoped('eu-central-1').resolve('agent')).runtimeArn).toBe(RUNTIME_ARN);
  });

  it('refreshes after the TTL and picks up a changed entry; a definite miss replaces a stale entry', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: ENTRY } });
    const r = registry(30);
    expect((await r.resolve('agent')).scopes).toEqual(SCOPES);
    clock += 29_000;
    await r.resolve('agent');
    expect(ssm).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    clock += 2_000;
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ runtimeArn: RUNTIME_ARN, scopes: ['default/chat'], status: 'active' }) } });
    expect((await r.resolve('agent')).scopes).toEqual(['default/chat']);
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
