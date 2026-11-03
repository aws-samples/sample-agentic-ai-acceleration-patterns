// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { AuthorityResolver } from '../../src/shared/authority';
import { EntitlementReader } from '../../src/shared/entitlements';
import type { MintInput } from '../../src/shared/mint';
import type { RegistryEntry } from '../../src/shared/registry';

/** The authority step resolves the token's tools gateways from the catalogue rows (ADR-0041). */
type Reader = Pick<EntitlementReader, 'tenantEntitlement' | 'plan' | 'catalogueFor' | 'gatewaysFor'>;

const catalogue = new Map([
  ['crm', ['get_account', 'update_case']],
  ['invoices', ['get_invoice']],
]);
const gatewayOf = new Map([
  ['crm', 'default'],
  ['invoices', 'finance'],
]);

function reader(tools: string[]): Reader & { gatewayCalls: string[][] } {
  const gatewayCalls: string[][] = [];
  return {
    gatewayCalls,
    tenantEntitlement: async () => ({ tenant: { status: 'active', agents: ['default'], tools, version: 4 } }),
    plan: async () => undefined,
    catalogueFor: async (targets) => new Map(targets.filter((t) => catalogue.has(t)).map((t) => [t, catalogue.get(t)!])),
    gatewaysFor: async (targets) => {
      gatewayCalls.push([...targets]);
      return new Map(targets.filter((t) => gatewayOf.has(t)).map((t) => [t, gatewayOf.get(t)!]));
    },
  };
}

function minter() {
  const inputs: MintInput[] = [];
  return {
    inputs,
    mint: async (input: MintInput) => {
      inputs.push(input);
      return { token: 't', txn: 'x', exp: 1, mint: 'miss' as const };
    },
  };
}

const entry = (tools: string[]): RegistryEntry => ({ runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/r-1', needs: ['default/chat'], tools, version: 2, status: 'active' }) as RegistryEntry;

describe('AuthorityResolver gateways (ADR-0041)', () => {
  it('names the gateway of every granted tool, once each, sorted', async () => {
    const r = reader(['crm/*', 'invoices/*']);
    const m = minter();
    await new AuthorityResolver(r, m).resolve('t-a', 'user-1', 'default', entry(['crm/get_account', 'invoices/*']));
    expect(m.inputs[0].gateways).toEqual(['default', 'finance']);
    expect(r.gatewayCalls).toEqual([['crm', 'invoices']]);
  });

  it('a gateway is named only for the targets actually granted, not for those the agent asks for', async () => {
    const m = minter();
    await new AuthorityResolver(reader(['crm/*']), m).resolve('t-a', 'user-1', 'default', entry(['crm/*', 'invoices/*']));
    expect(m.inputs[0].gateways).toEqual(['default']);
  });

  it('no granted tool: no gateway, so aud will be the agent alone', async () => {
    const m = minter();
    await new AuthorityResolver(reader([]), m).resolve('t-a', 'user-1', 'default', entry(['crm/*']));
    expect(m.inputs[0].gateways).toEqual([]);
    expect(m.inputs[0].scope).toBe('default/chat');
  });

  it('a failed gateway read is entitlements_unavailable, never a token without its gateways', async () => {
    const r = reader(['crm/*']);
    const m = minter();
    const failing: Reader = { ...r, gatewaysFor: async () => { throw new Error('throttled'); } };
    await expect(new AuthorityResolver(failing, m).resolve('t-a', 'user-1', 'default', entry(['crm/*']))).rejects.toMatchObject({ status: 502, reason: 'entitlements_unavailable' });
    expect(m.inputs).toHaveLength(0);
  });
});

describe('EntitlementReader.gatewaysFor (ADR-0041)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  afterEach(() => ddb.reset());

  it('reads the gateway from the same cached catalogue Query; old rows without one are on default', async () => {
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'TOOL#invoices' } }).resolves({ Items: [{ SK: 'TOOL#get_invoice', gateway: 'finance' }] });
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'TOOL#crm' } }).resolves({ Items: [{ SK: 'TOOL#get_account' }] });
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'TOOL#gone' } }).resolves({ Items: [] });
    const store = new EntitlementReader('table', 60, undefined, () => 1000);
    expect(await store.catalogueFor(['crm', 'invoices', 'gone'])).toEqual(new Map([['crm', ['get_account']], ['invoices', ['get_invoice']], ['gone', []]]));
    expect(await store.gatewaysFor(['crm', 'invoices', 'gone'])).toEqual(new Map([['crm', 'default'], ['invoices', 'finance']]));
    // One Query per target, shared by both reads.
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(3);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ProjectionExpression).toBe('#sk, #gw');
  });

  it('ignores a malformed gateway value', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ SK: 'TOOL#a', gateway: 'Bad Name' }] });
    const store = new EntitlementReader('table', 60, undefined, () => 1000);
    expect(await store.gatewaysFor(['x'])).toEqual(new Map([['x', 'default']]));
  });
});
