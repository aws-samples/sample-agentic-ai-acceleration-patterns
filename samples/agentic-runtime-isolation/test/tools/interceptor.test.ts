// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createLocalJWKSet } from 'jose';
import { argsHash, CONTEXT_ARGUMENT, decodeJws, publicJwk, signJws, verifyJws } from '../../src/shared/jws';
import { TRANSACTION_TOKEN_TYPE, transactionClaims } from '../../src/shared/mint';
import { CONTEXT_TYPE } from '../../src/tools/context';
import { interceptTool, ToolInterceptorDependencies, ToolInterceptorEvent } from '../../src/tools/interceptor.function';
import { localRsaKey } from '../jws-helpers';

/** The tools gateway REQUEST interceptor (spec C-15a, §3.6, P-15, ADR-0034, ADR-0040). */
const NOW = 1_000_000_000;
const ISSUER = 'https://example.execute-api.eu-central-1.amazonaws.com/prod';
const INGRESS_ROLE = 'arn:aws:iam::111122223333:role/IngressRole';
const ingressKey = localRsaKey();
const contextKey = localRsaKey();
const rogueKey = localRsaKey();

const deps: ToolInterceptorDependencies = {
  config: { issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, contextKeyId: 'ctx-key', contextLifetimeSeconds: 60 },
  getKey: createLocalJWKSet({ keys: [publicJwk(ingressKey.publicKey, 'ingress-key')] }) as ToolInterceptorDependencies['getKey'],
  contextSigner: contextKey.signer,
  now: () => NOW,
};

interface TokenOptions {
  readonly scope?: string;
  readonly agent?: string;
  readonly claims?: Record<string, unknown>;
  readonly typ?: string;
  readonly kid?: string;
  readonly signer?: typeof ingressKey.signer;
}

async function transactionToken(options: TokenOptions = {}): Promise<string> {
  const claims = transactionClaims(
    { tenantId: 't-a', sub: 'user-1', agent: options.agent ?? 'default', scope: options.scope ?? 'crm/* default/chat', versions: { tenant: 1, agent: 1 } },
    { issuer: ISSUER, ttlSeconds: 300, ingressRoleArn: INGRESS_ROLE },
    Math.floor(NOW / 1000),
    { txn: 'txn-1', jti: 'jti-1' },
  );
  return signJws(
    { alg: 'RS256', typ: options.typ ?? TRANSACTION_TOKEN_TYPE, kid: options.kid ?? 'ingress-key' },
    { ...claims, ...options.claims },
    options.signer ?? ingressKey.signer,
  );
}

function event(token: string | undefined, method: string, params?: Record<string, unknown>): ToolInterceptorEvent {
  return {
    interceptorInputVersion: '1.0',
    mcp: {
      gatewayRequest: {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
        body: { jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) },
      },
    },
  };
}

const call = (args: Record<string, unknown>, name = 'crm___get_account') => ({ name, arguments: args });

function refusalOf(output: Awaited<ReturnType<typeof interceptTool>>): { statusCode: number; message: string } {
  const mcp = output.mcp as { transformedGatewayResponse?: { statusCode: number; body: { error: { message: string } } } };
  expect(mcp.transformedGatewayResponse).toBeDefined();
  return { statusCode: mcp.transformedGatewayResponse!.statusCode, message: mcp.transformedGatewayResponse!.body.error.message };
}

function passedBody(output: Awaited<ReturnType<typeof interceptTool>>): any {
  const mcp = output.mcp as { transformedGatewayRequest?: { body: unknown } };
  expect(mcp.transformedGatewayRequest).toBeDefined();
  return mcp.transformedGatewayRequest!.body;
}

describe('interceptTool', () => {
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

  it('tools/list: verifies the token and passes the request unchanged (Policy filters the list)', async () => {
    const token = await transactionToken();
    const output = await interceptTool(event(token, 'tools/list'), deps);
    expect(passedBody(output)).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(contextKey.calls.length).toBe(0);
  });

  it('tools/call of a granted tool: signs the tenant context into _ri_ctx with ToolContextKey', async () => {
    const token = await transactionToken();
    const output = await interceptTool(event(token, 'tools/call', call({ accountId: 'acc-1' })), deps);
    const body = passedBody(output);
    const ctx = body.params.arguments[CONTEXT_ARGUMENT];
    expect(body.params.arguments.accountId).toBe('acc-1');
    const decoded = verifyJws(ctx, contextKey.publicKey, ['RS256']);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: CONTEXT_TYPE, kid: 'ctx-key' });
    expect(decoded.payload).toEqual({
      tenant_id: 't-a',
      sub: 't-a#user-1',
      user: 'user-1',
      agent: 'default',
      tool: 'crm/get_account',
      argsHash: argsHash({ accountId: 'acc-1' }),
      txn: 'txn-1',
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 60,
    });
    expect(lines.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'tool admitted', tenantId: 't-a', tool: 'crm/get_account' })]));
  });

  it('overwrites a client _ri_ctx and a client tenantId argument with the token\'s', async () => {
    const token = await transactionToken();
    const output = await interceptTool(event(token, 'tools/call', call({ accountId: 'acc-1', tenantId: 't-b', [CONTEXT_ARGUMENT]: 'forged' })), deps);
    const args = passedBody(output).params.arguments;
    expect(args.tenantId).toBe('t-a');
    expect(args[CONTEXT_ARGUMENT]).not.toBe('forged');
    expect(decodeJws(args[CONTEXT_ARGUMENT]).payload.argsHash).toBe(argsHash({ accountId: 'acc-1', tenantId: 't-a' }));
    expect(lines.map((l) => JSON.parse(l))).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'tool admitted', clientContextOverwritten: true, clientTenantOverwritten: true })]),
    );
    expect(lines.join('')).not.toContain(token);
  });

  it('refuses a tool the scope does not grant', async () => {
    const token = await transactionToken({ scope: 'default/chat crm/get_account' });
    expect(refusalOf(await interceptTool(event(token, 'tools/call', call({}, 'crm___update_case')), deps))).toEqual({ statusCode: 403, message: 'forbidden: tool_not_granted' });
    expect(refusalOf(await interceptTool(event(token, 'tools/call', call({}, 'invoices___get_invoice')), deps)).message).toBe('forbidden: tool_not_granted');
    expect(refusalOf(await interceptTool(event(token, 'tools/call', call({}, 'not-a-tool')), deps)).message).toBe('forbidden: tool_not_granted');
  });

  it('refuses a missing, unsigned, foreign-key, wrong-issuer or expired token as token_invalid', async () => {
    const bad = [
      undefined,
      'not-a-token',
      await transactionToken({ signer: rogueKey.signer }),
      await transactionToken({ claims: { iss: 'https://other.example.com' } }),
      await transactionToken({ claims: { exp: Math.floor(NOW / 1000) - 10 } }),
      await transactionToken({ claims: { aud: ['agent:default'] } }),
      await transactionToken({ claims: { tenant_id: 42 } }),
    ];
    for (const token of bad) {
      expect(refusalOf(await interceptTool(event(token, 'tools/call', call({})), deps)).message).toBe('forbidden: token_invalid');
    }
  });

  it('refuses a token of another typ (the Gateway does not check typ, spike V-8)', async () => {
    const token = await transactionToken({ typ: 'JWT' });
    expect(refusalOf(await interceptTool(event(token, 'tools/list'), deps)).message).toBe('forbidden: aud_mismatch');
  });

  it('refuses a token whose aud does not name its own agent', async () => {
    const token = await transactionToken({ claims: { aud: ['agent:billing', 'tools-gateway'] } });
    expect(refusalOf(await interceptTool(event(token, 'tools/call', call({})), deps)).message).toBe('forbidden: aud_mismatch');
  });

  it('refuses a token whose act is not the ingress role', async () => {
    for (const act of [undefined, { sub: 'arn:aws:iam::111122223333:role/Other' }, 'x']) {
      const token = await transactionToken({ claims: { act } });
      expect(refusalOf(await interceptTool(event(token, 'tools/call', call({})), deps)).message).toBe('forbidden: act_missing');
    }
  });

  it('fails closed (throws) when the context signer fails', async () => {
    const token = await transactionToken();
    const failing: ToolInterceptorDependencies = { ...deps, contextSigner: async () => { throw new Error('kms down'); } };
    await expect(interceptTool(event(token, 'tools/call', call({})), failing)).rejects.toThrow('kms down');
  });
});
