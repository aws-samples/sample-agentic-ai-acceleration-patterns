// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createLocalJWKSet } from 'jose';
import { publicJwk, signJws } from '../../src/shared/jws';
import { TRANSACTION_TOKEN_TYPE, transactionClaims } from '../../src/shared/mint';
import type { TokenVerification } from '../../src/tools/interceptor.function';
import { filterToolsResponse, RESPONSE_FILTER_FORCE_ERROR_ENV, type ToolResponseEvent } from '../../src/tools/response-filter.function';
import { localRsaKey } from '../jws-helpers';

/** The tools gateway RESPONSE interceptor (spec §3.3 `responseFilter`, ADR-0041). */
const NOW = 1_000_000_000;
const ISSUER = 'https://example.execute-api.eu-central-1.amazonaws.com/prod';
const INGRESS_ROLE = 'arn:aws:iam::111122223333:role/IngressRole';
const ingressKey = localRsaKey();
const rogueKey = localRsaKey();

const deps: TokenVerification = {
  config: { issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, gatewayName: 'finance' },
  getKey: createLocalJWKSet({ keys: [publicJwk(ingressKey.publicKey, 'ingress-key')] }) as TokenVerification['getKey'],
  now: () => NOW,
};

async function token(scope: string, options: { gateways?: string[]; signer?: typeof ingressKey.signer } = {}): Promise<string> {
  const claims = transactionClaims(
    { tenantId: 't-a', sub: 'user-1', agent: 'billing', scope, gateways: options.gateways ?? ['finance'], versions: { tenant: 1, agent: 1 } },
    { issuer: ISSUER, ttlSeconds: 300, ingressRoleArn: INGRESS_ROLE },
    Math.floor(NOW / 1000),
    { txn: 'txn-1', jti: 'jti-1' },
  );
  return signJws({ alg: 'RS256', typ: TRANSACTION_TOKEN_TYPE, kid: 'ingress-key' }, claims, options.signer ?? ingressKey.signer);
}

/** One `tools/list` page as the Gateway returns it after Policy (target grain). */
const PAGE = {
  jsonrpc: '2.0',
  id: 3,
  result: {
    tools: [
      { name: 'invoices___get_invoice', description: 'Reads one invoice', inputSchema: { type: 'object' } },
      { name: 'invoices___list_invoices', description: 'Lists invoices', inputSchema: { type: 'object' } },
      { name: 'invoices___void_invoice', description: 'Voids an invoice', inputSchema: { type: 'object' } },
      { name: 'x-amz-bedrock-agentcore-search', description: 'search', inputSchema: { type: 'object' } },
      { description: 'no name' },
    ],
    nextCursor: 'cursor-2',
  },
};

function event(bearer: string | undefined, method = 'tools/list', body: unknown = PAGE, statusCode = 200): ToolResponseEvent {
  return {
    interceptorInputVersion: '1.0',
    mcp: {
      gatewayRequest: { headers: bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }, body: { jsonrpc: '2.0', id: 3, method } },
      gatewayResponse: { statusCode, headers: {}, body },
    },
  };
}

const namesOf = (output: Awaited<ReturnType<typeof filterToolsResponse>>): string[] =>
  ((output.mcp.transformedGatewayResponse.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name);

describe('filterToolsResponse', () => {
  let lines: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((l: unknown) => {
      lines.push(String(l));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  it('keeps only the granted tools of a partial-target grant, and the rest of the page as it was', async () => {
    const bearer = await token('billing/chat invoices/get_invoice');
    const output = await filterToolsResponse(event(bearer), deps);
    expect(output.mcp.transformedGatewayResponse.statusCode).toBe(200);
    expect(namesOf(output)).toEqual(['invoices___get_invoice']);
    const body = output.mcp.transformedGatewayResponse.body as { id: number; result: { nextCursor: string } };
    expect(body.id).toBe(3);
    expect(body.result.nextCursor).toBe('cursor-2');
    expect(lines.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'tools list filtered', listed: 5, kept: 1 })]));
    expect(lines.join('')).not.toContain(bearer);
  });

  it('expands <target>/* and never adds a tool the page did not list', async () => {
    const output = await filterToolsResponse(event(await token('invoices/* crm/*')), deps);
    expect(namesOf(output)).toEqual(['invoices___get_invoice', 'invoices___list_invoices', 'invoices___void_invoice']);
  });

  it('removes everything when scope grants nothing on the page', async () => {
    expect(namesOf(await filterToolsResponse(event(await token('billing/chat crm/*')), deps))).toEqual([]);
  });

  it('forceError (integ step 24) fails every listing closed, and leaves other methods alone', async () => {
    const granted = await token('billing/read invoices/*');
    const output = await filterToolsResponse(event(granted), deps, { forceError: true });
    expect(namesOf(output)).toEqual([]);
    expect(output.mcp.transformedGatewayResponse.statusCode).toBe(200);
    const call = { jsonrpc: '2.0', id: 3, result: { content: [] } };
    expect((await filterToolsResponse(event(granted, 'tools/call', call), deps, { forceError: true })).mcp.transformedGatewayResponse.body).toEqual(call);
    expect(RESPONSE_FILTER_FORCE_ERROR_ENV).toBe('RI_RESPONSE_FILTER_FORCE_ERROR');
  });

  it('passes a response to any other method unchanged', async () => {
    const call = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'ok' }] } };
    const output = await filterToolsResponse(event(undefined, 'tools/call', call), deps);
    expect(output.mcp.transformedGatewayResponse).toEqual({ statusCode: 200, body: call });
  });

  it('passes a JSON-RPC error page unchanged (nothing to filter)', async () => {
    const error = { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'forbidden: token_invalid' } };
    const output = await filterToolsResponse(event(await token('invoices/*'), 'tools/list', error, 403), deps);
    expect(output.mcp.transformedGatewayResponse).toEqual({ statusCode: 403, body: error });
  });

  it('fails closed with an empty tools array on a missing, foreign or other-gateway token, or an unreadable page', async () => {
    const cases: ToolResponseEvent[] = [
      event(undefined),
      event('not-a-token'),
      event(await token('invoices/*', { signer: rogueKey.signer })),
      event(await token('invoices/*', { gateways: ['default'] })),
      event(await token('invoices/*'), 'tools/list', { jsonrpc: '2.0', id: 3, result: { tools: 'nope' } }),
    ];
    const noBody = event(await token('invoices/*'));
    cases.push({ mcp: { gatewayRequest: noBody.mcp!.gatewayRequest, gatewayResponse: { statusCode: 200 } } });
    for (const e of cases) {
      const output = await filterToolsResponse(e, deps);
      expect(output.mcp.transformedGatewayResponse).toEqual({ statusCode: 200, body: { jsonrpc: '2.0', id: 3, result: { tools: [] } } });
    }
    const failures = lines.map((l) => JSON.parse(l)).filter((l) => l.message === 'response_filter_failed');
    expect(failures).toHaveLength(cases.length);
  });
});
