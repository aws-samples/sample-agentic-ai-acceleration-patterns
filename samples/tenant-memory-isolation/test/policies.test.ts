// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Cedar policies (src/policies.ts) evaluated by the real Cedar evaluator
 * (M-1, M-2, M-3). Local evaluation proves the policy logic; the integration
 * test proves the Gateway maps the token and the request the same way.
 */

import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { ACTION_IDS, type ClaimNames, type ConnectorOperation, DEFAULT_CLAIMS, eventWritePolicy, sharedRecallPolicy, TARGET_NAME } from '../src/policies';

const GATEWAY = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/memory-gw-abcdefghij';
const MEMORY = 'TenantMemory-abcdefghij';
const A_USER = '11111111-2222-3333-4444-555555555555';
const OTHER_USER = '66666666-7777-8888-9999-000000000000';
const TOKEN = { tenant_id: 'tenant-a', sub: A_USER, token_use: 'access', client_id: 'demo-client' };

function policySet(claims: ClaimNames = DEFAULT_CLAIMS): string {
  return eventWritePolicy(GATEWAY, claims) + sharedRecallPolicy(GATEWAY, claims);
}

function decide(
  operation: ConnectorOperation,
  input: Record<string, unknown>,
  tags: Record<string, string> = TOKEN,
  options: { gateway?: string; principalType?: string; policies?: string } = {},
): string {
  const principal = { type: options.principalType ?? 'AgentCore::OAuthUser', id: 'synthetic-caller' };
  const answer = cedar.isAuthorized({
    principal,
    action: { type: 'AgentCore::Action', id: `${TARGET_NAME}___${ACTION_IDS[operation]}` },
    resource: { type: 'AgentCore::Gateway', id: options.gateway ?? GATEWAY },
    context: { input } as unknown as Record<string, cedar.CedarValueJson>,
    policies: { staticPolicies: options.policies ?? policySet() },
    entities: [{ uid: principal, attrs: {}, parents: [], tags }],
  });
  if (answer.type !== 'success') {
    throw new Error(JSON.stringify(answer));
  }
  expect(answer.response.diagnostics.errors).toEqual([]);
  return answer.response.decision;
}

const write = { memoryId: MEMORY, actorId: 'tenant-a', sessionId: A_USER, payload: [] };
const recall = { memoryId: MEMORY, namespace: 'tenant-a', searchCriteria: { searchQuery: 'warehouse' } };

describe('policy text', () => {
  it('parses in the Cedar evaluator', () => {
    expect(cedar.checkParsePolicySet({ staticPolicies: policySet() }).type).toBe('success');
  });
});

describe('event writes', () => {
  it('permit the token tenant as actor and the token subject as session', () => {
    expect(decide('CreateEvent', write)).toBe('allow');
  });
  it.each([
    ['another tenant actor', { actorId: 'tenant-b' }],
    ['a tenant whose id extends this one', { actorId: 'tenant-ab' }],
    ['another user session in the same tenant', { sessionId: OTHER_USER }],
    ['a caller-supplied extraction override', { extractionConfig: { namespaceVariables: { tenant: 'tenant-b' } } }],
  ])('deny %s', (_name, change) => {
    expect(decide('CreateEvent', { ...write, ...change })).toBe('deny');
  });
  it('deny a request without actorId or sessionId', () => {
    expect(decide('CreateEvent', { memoryId: MEMORY, sessionId: A_USER })).toBe('deny');
    expect(decide('CreateEvent', { memoryId: MEMORY, actorId: 'tenant-a' })).toBe('deny');
  });
});

describe('shared recall', () => {
  it.each(['RetrieveMemoryRecords', 'ListMemoryRecords'] as const)('%s permits the exact tenant namespace for every user of the tenant', (op) => {
    expect(decide(op, recall)).toBe('allow');
    expect(decide(op, recall, { ...TOKEN, sub: OTHER_USER })).toBe('allow');
  });
  it.each(['RetrieveMemoryRecords', 'ListMemoryRecords'] as const)('%s denies other namespaces and any hierarchy', (op) => {
    for (const change of [
      { namespace: 'tenant-b' },
      { namespace: 'tenant-ab' },
      { namespace: 'tenant' },
      { namespace: '*' },
      { namespace: '/' },
      { namespacePath: 'tenant-a' },
      { namespacePath: '/' },
    ]) {
      expect(decide(op, { ...recall, ...change })).toBe('deny');
    }
    const withoutNamespace: Record<string, unknown> = { ...recall };
    delete withoutNamespace.namespace;
    expect(decide(op, { ...withoutNamespace, namespacePath: '/' })).toBe('deny');
  });
});

describe('the token', () => {
  it.each([
    ['an ID token', { ...TOKEN, token_use: 'id' }],
    ['no token_use', (({ token_use: _u, ...rest }) => rest)(TOKEN)],
    ['no tenant', (({ tenant_id: _t, ...rest }) => rest)(TOKEN)],
    ['no subject', (({ sub: _s, ...rest }) => rest)(TOKEN)],
  ])('%s is denied', (_name, tags) => {
    expect(decide('CreateEvent', write, tags as Record<string, string>)).toBe('deny');
  });
  it.each(['tenant-a/shared', 'tenant-a:x', 'tenant-*', '*'])('a tenant claim with path, scope or wildcard characters (%s) is denied', (tenant) => {
    expect(decide('CreateEvent', { ...write, actorId: tenant }, { ...TOKEN, tenant_id: tenant })).toBe('deny');
    expect(decide('RetrieveMemoryRecords', { ...recall, namespace: tenant }, { ...TOKEN, tenant_id: tenant })).toBe('deny');
  });
  it('another Gateway is denied', () => {
    expect(decide('RetrieveMemoryRecords', recall, TOKEN, { gateway: `${GATEWAY}x` })).toBe('deny');
  });
  it('an IAM principal does not match the OAuth permits', () => {
    expect(decide('RetrieveMemoryRecords', recall, TOKEN, { principalType: 'AgentCore::IamEntity' })).toBe('deny');
  });
});

describe('default deny', () => {
  const others = (Object.keys(ACTION_IDS) as ConnectorOperation[]).filter(
    (op) => !['CreateEvent', 'RetrieveMemoryRecords', 'ListMemoryRecords'].includes(op),
  );
  it('covers the nine other connector operations', () => {
    expect(others).toHaveLength(9);
  });
  it.each(others)('%s has no permit', (op) => {
    expect(decide(op, { ...write, ...recall, eventId: 'e-1', memoryRecordId: 'mem-1' })).toBe('deny');
  });
});

describe('claim options', () => {
  it('an issuer without token_use (audience-bound) is matched on tenant and session alone', () => {
    const claims: ClaimNames = { tenant: 'tenant_id', session: 'agent' };
    const policies = policySet(claims);
    expect(policies).not.toContain('token_use');
    const tags = { tenant_id: 'tenant-a', agent: 'support' };
    expect(decide('CreateEvent', { ...write, sessionId: 'support' }, tags, { policies })).toBe('allow');
    expect(decide('CreateEvent', { ...write, sessionId: 'shopping' }, tags, { policies })).toBe('deny');
  });
  it('custom claim names are read as given', () => {
    const policies = policySet({ tenant: 'org', session: 'sub', tokenUse: 'access' });
    expect(decide('RetrieveMemoryRecords', recall, { org: 'tenant-a', sub: A_USER, token_use: 'access' }, { policies })).toBe('allow');
    expect(decide('RetrieveMemoryRecords', recall, TOKEN, { policies })).toBe('deny');
  });
});
