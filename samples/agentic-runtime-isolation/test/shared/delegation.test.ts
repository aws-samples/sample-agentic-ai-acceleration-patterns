// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createLocalJWKSet } from 'jose';
import { AuthorityError, AuthorityResolver } from '../../src/shared/authority';
import { type DelegationCaller, DELEGATION_EXP_MARGIN_SECONDS, delegationTokenVerifierFor } from '../../src/shared/delegation';
import { publicJwk, signJws } from '../../src/shared/jws';
import {
  type ActClaim,
  agentChainOf,
  MAX_DELEGATION_DEPTH,
  type MintConfig,
  type MintInput,
  TokenMinter,
  TRANSACTION_TOKEN_TYPE,
  transactionClaims,
} from '../../src/shared/mint';
import { backendDelegatesToProblem, DELEGATION_ROUTE, parseRegistryEntry, type RegistryEntry, ROUTE, routeFromPath } from '../../src/shared/registry';
import { IngressPipeline, pipelineFor, RequestError } from '../../src/shared/request';
import { verifyTransactionToken } from '../../src/tools/transaction-token';
import { baseConfig, FIXTURE_ENTRIES, RUNTIME_ARN, stubRegistry, TXN_TOKEN } from '../helpers';
import { localRsaKey } from '../jws-helpers';

/** Delegation between agents (ADR-0048, spec §3.7, §5.1.1, §6.2.2). */
const INGRESS_ROLE = 'arn:aws:iam::111122223333:role/IngressRole';
const ISSUER = 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod';
const ROOT: ActClaim = { sub: INGRESS_ROLE };
const config: MintConfig = { issuer: ISSUER, keyId: 'key-1', algorithm: 'RS256', ttlSeconds: 300, reuseMarginSeconds: 180, ingressRoleArn: INGRESS_ROLE };
const direct: MintInput = { tenantId: 't-a', sub: 'user-1', agent: 'billing', scope: 'billing/read invoices/*', gateways: ['finance'], versions: { tenant: 1, agent: 1 } };

describe('agentChainOf', () => {
  it('a first-hop act is an empty chain; each nested level adds its agent, outermost first', () => {
    expect(agentChainOf(ROOT, INGRESS_ROLE)).toEqual([]);
    expect(agentChainOf({ sub: 'agent:default', act: ROOT }, INGRESS_ROLE)).toEqual(['default']);
    expect(agentChainOf({ sub: 'agent:planner', act: { sub: 'agent:default', act: ROOT } }, INGRESS_ROLE)).toEqual(['planner', 'default']);
  });

  it('refuses a chain that does not end in the ingress role, an outer level that is not an agent, a malformed level, or one past the depth bound', () => {
    expect(agentChainOf({ sub: 'arn:aws:iam::111122223333:role/Other' }, INGRESS_ROLE)).toBeUndefined();
    expect(agentChainOf({ sub: 'agent:default', act: { sub: 'arn:aws:iam::111122223333:role/Other' } }, INGRESS_ROLE)).toBeUndefined();
    expect(agentChainOf({ sub: INGRESS_ROLE, act: ROOT }, INGRESS_ROLE)).toBeUndefined(); // the role is not an agent
    expect(agentChainOf({ sub: 'agent:', act: ROOT }, INGRESS_ROLE)).toBeUndefined();
    expect(agentChainOf(undefined, INGRESS_ROLE)).toBeUndefined();
    expect(agentChainOf({ act: ROOT }, INGRESS_ROLE)).toBeUndefined();
    expect(agentChainOf([ROOT], INGRESS_ROLE)).toBeUndefined();
    let deep: ActClaim = ROOT;
    for (let i = 0; i <= MAX_DELEGATION_DEPTH; i += 1) {
      deep = { sub: `agent:a${i}`, act: deep };
    }
    expect(agentChainOf(deep, INGRESS_ROLE)).toBeUndefined();
  });
});

describe('transactionClaims for a delegation', () => {
  it('nests the caller over the caller act and copies the caller txn; everything else is the direct call', () => {
    const callerAct: ActClaim = { sub: 'agent:default', act: ROOT };
    const claims = transactionClaims({ ...direct, delegation: { from: 'planner', act: callerAct, txn: 'txn-caller' } }, config, 1_000, { txn: 'txn-fresh', jti: 'jti-1' });
    expect(claims.act).toEqual({ sub: 'agent:planner', act: callerAct });
    expect(claims.txn).toBe('txn-caller');
    expect(claims.jti).toBe('jti-1');
    const asDirect = transactionClaims(direct, config, 1_000, { txn: 'txn-fresh', jti: 'jti-1' });
    expect({ ...claims, act: undefined, txn: undefined }).toEqual({ ...asDirect, act: undefined, txn: undefined });
    expect(asDirect.act).toEqual(ROOT);
  });
});

describe('TokenMinter for a delegation', () => {
  it('signs every delegation (no cache) while direct mints of the same key are cached', async () => {
    const key = localRsaKey();
    const minter = new TokenMinter(config, { signer: key.signer, now: () => 1_000_000 });
    const delegated: MintInput = { ...direct, delegation: { from: 'default', act: ROOT, txn: 'txn-caller' } };
    const first = await minter.mint(delegated);
    const second = await minter.mint(delegated);
    expect(first.mint).toBe('miss');
    expect(second.mint).toBe('miss');
    expect(first.txn).toBe('txn-caller');
    expect(key.calls).toHaveLength(2);
    expect(minter.size).toBe(0);
    await minter.mint(direct);
    await minter.mint(direct);
    expect(key.calls).toHaveLength(3);
  });
});

describe('routeFromPath', () => {
  it('reads the backend and the route; the bare route is invocations only', () => {
    expect(routeFromPath('/billing/invocations')).toEqual({ backend: 'billing', route: ROUTE });
    expect(routeFromPath('/billing/delegations')).toEqual({ backend: 'billing', route: DELEGATION_ROUTE });
    expect(routeFromPath('/billing/delegations/?x=1')).toEqual({ backend: 'billing', route: DELEGATION_ROUTE });
    expect(routeFromPath('/invocations', 'default')).toEqual({ backend: 'default', route: ROUTE });
    expect(routeFromPath('/invocations')).toBeUndefined();
    expect(routeFromPath('/delegations', 'default')).toBeUndefined();
    expect(routeFromPath('/delegations/delegations')).toBeUndefined();
    expect(routeFromPath('/invocations/delegations')).toBeUndefined();
    expect(routeFromPath('/a/b/delegations')).toBeUndefined();
    expect(routeFromPath('/Bad_Name/delegations')).toBeUndefined();
  });
});

describe('delegatesTo', () => {
  it('backendDelegatesToProblem: shape, bound, self and duplicates', () => {
    expect(backendDelegatesToProblem('default', [])).toBeUndefined();
    expect(backendDelegatesToProblem('default', ['billing', 'planner'])).toBeUndefined();
    expect(backendDelegatesToProblem('default', ['default'])).toMatch(/must not name this agent itself/);
    expect(backendDelegatesToProblem('default', ['billing', 'billing'])).toMatch(/must not repeat/);
    expect(backendDelegatesToProblem('default', ['Billing'])).toMatch(/must match/);
    expect(backendDelegatesToProblem('default', Array.from({ length: 33 }, (_, i) => `a${i}`))).toMatch(/at most 32/);
    expect(backendDelegatesToProblem('default', 'billing' as unknown as string[])).toMatch(/must be a list/);
  });

  it('parseRegistryEntry: an absent field reads as empty (entries written before ADR-0048 stay valid); a malformed one is refused', () => {
    const base = { runtimeArn: RUNTIME_ARN, needs: ['default/chat'], tools: [], version: 1, status: 'active' };
    expect(parseRegistryEntry(JSON.stringify(base)).delegatesTo).toEqual([]);
    expect(parseRegistryEntry(JSON.stringify({ ...base, delegatesTo: ['billing'] })).delegatesTo).toEqual(['billing']);
    expect(() => parseRegistryEntry(JSON.stringify({ ...base, delegatesTo: 'billing' }))).toThrow(/delegatesTo/);
    expect(() => parseRegistryEntry(JSON.stringify({ ...base, delegatesTo: ['Bad Name'] }))).toThrow(/delegatesTo/);
  });
});

/** A caller token signed by the test key, as the ingress would have minted it. */
async function callerToken(
  key: ReturnType<typeof localRsaKey>,
  overrides: Record<string, unknown> = {},
  header: Record<string, string> = {},
): Promise<string> {
  const now = 1_000_000;
  const claims = {
    iss: ISSUER,
    sub: 't-a#user-1',
    user: 'user-1',
    tenant_id: 't-a',
    agent: 'default',
    scope: 'default/chat crm/*',
    aud: ['agent:default', 'tools-gateway:default'],
    act: ROOT,
    txn: 'txn-caller',
    iat: now,
    exp: now + 300,
    jti: 'jti-caller',
    ...overrides,
  };
  return signJws({ alg: 'RS256', typ: TRANSACTION_TOKEN_TYPE, kid: 'key-1', ...header }, claims, key.signer);
}

describe('delegationTokenVerifierFor', () => {
  const key = localRsaKey();
  const jwks = JSON.stringify({ keys: [publicJwk(key.publicKey, 'key-1')] });
  const verify = delegationTokenVerifierFor({ issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, jwks, now: () => 1_000_000 * 1000 });

  it('returns the tenant, the user, the agent, the chain, the act and the txn of a well-formed caller token', async () => {
    const caller = await verify(await callerToken(key));
    expect(caller).toEqual({ tenantId: 't-a', sub: 'user-1', agent: 'default', chain: [], act: ROOT, txn: 'txn-caller' });
    const nested = await verify(await callerToken(key, { agent: 'planner', aud: ['agent:planner'], act: { sub: 'agent:default', act: ROOT } }));
    expect(nested.chain).toEqual(['default']);
  });

  it('refuses: no token, an identity token (other iss or typ), a wrong signature, too little life, aud without the agent, a broken chain', async () => {
    const refuse = async (token: string | undefined) => expect(verify(token)).rejects.toThrow('token_invalid');
    await refuse(undefined);
    await refuse('');
    await refuse(await callerToken(key, { iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00' }));
    await refuse(await callerToken(key, {}, { typ: 'JWT' }));
    await refuse(await callerToken(localRsaKey()));
    await refuse(await callerToken(key, { exp: 1_000_000 + DELEGATION_EXP_MARGIN_SECONDS }));
    await expect(verify(await callerToken(key, { exp: 1_000_000 + DELEGATION_EXP_MARGIN_SECONDS + 1 }))).resolves.toBeDefined();
    await refuse(await callerToken(key, { aud: ['agent:billing'] }));
    await refuse(await callerToken(key, { act: { sub: 'arn:aws:iam::111122223333:role/Other' } }));
    await refuse(await callerToken(key, { act: undefined }));
    await refuse(await callerToken(key, { user: undefined }));
  });
});

const entry = (name: string, delegatesTo: string[] = [], tools: string[] = []): RegistryEntry => ({
  runtimeArn: RUNTIME_ARN,
  needs: [`${name}/chat`],
  tools,
  delegatesTo,
  version: 1,
  status: 'active',
});
const caller = (agent = 'default', chain: string[] = []): DelegationCaller => {
  let act: ActClaim = ROOT;
  for (const name of [...chain].reverse()) {
    act = { sub: `agent:${name}`, act };
  }
  return { tenantId: 't-a', sub: 'user-1', agent, chain, act, txn: 'txn-caller' };
};

describe('AuthorityResolver.delegate', () => {
  const reader = {
    tenantEntitlement: async () => ({ tenant: { status: 'active' as const, agents: ['default', 'billing'], tools: ['invoices/*'], version: 2 } }),
    plan: async () => undefined,
    catalogueFor: async (targets: readonly string[]) => new Map(targets.filter((t) => t === 'invoices').map((t) => [t, ['get_invoice']])),
    gatewaysFor: async (targets: readonly string[]) => new Map(targets.map((t) => [t, 'finance'])),
  };
  const minter = () => {
    const inputs: MintInput[] = [];
    const mint = async (input: MintInput) => {
      inputs.push(input);
      return { token: 't', txn: input.delegation?.txn ?? 'x', exp: 1, mint: 'miss' as const };
    };
    return { inputs, mint };
  };

  it('grants the target as a direct call would, with the caller nested in act and the caller txn copied', async () => {
    const m = minter();
    const resolver = new AuthorityResolver(reader, m);
    const delegated = await resolver.delegate(caller(), 'billing', entry('billing', [], ['invoices/*']), entry('default', ['billing']), 1);
    const directCall = await resolver.resolve('t-a', 'user-1', 'billing', entry('billing', [], ['invoices/*']));
    expect(m.inputs[0].scope).toBe(m.inputs[1].scope);
    expect(m.inputs[0].gateways).toEqual(m.inputs[1].gateways);
    expect(m.inputs[0].delegation).toEqual({ from: 'default', act: ROOT, txn: 'txn-caller' });
    expect(m.inputs[1].delegation).toBeUndefined();
    expect(delegated.txn).toBe('txn-caller');
    expect(directCall.grantSize).toBe(delegated.grantSize);
  });

  it('refuses, before any mint: an undeclared target, a chain at the depth bound, a loop back or to self', async () => {
    const m = minter();
    const resolver = new AuthorityResolver(reader, m);
    const refuse = async (p: Promise<unknown>, reason: string) => {
      await expect(p).rejects.toMatchObject({ status: 403, reason });
      await expect(p).rejects.toBeInstanceOf(AuthorityError);
    };
    await refuse(resolver.delegate(caller(), 'billing', entry('billing'), entry('default', []), 1), 'delegation_not_declared');
    await refuse(resolver.delegate(caller('planner', ['default']), 'billing', entry('billing'), entry('planner', ['billing']), 1), 'delegation_depth');
    await expect(resolver.delegate(caller('planner', ['default']), 'billing', entry('billing'), entry('planner', ['billing']), 2)).resolves.toBeDefined();
    await refuse(resolver.delegate(caller('billing', ['default']), 'default', entry('default'), entry('billing', ['default']), 3), 'delegation_loop');
    await refuse(resolver.delegate(caller(), 'default', entry('default'), entry('default', ['default']), 3), 'delegation_loop');
    expect(m.inputs).toHaveLength(1);
  });

  it('a target the tenant does not hold is agent_not_subscribed, as for a direct call', async () => {
    const resolver = new AuthorityResolver(reader, minter());
    await expect(resolver.delegate(caller(), 'planner', entry('planner'), entry('default', ['planner']), 1)).rejects.toMatchObject({ status: 403, reason: 'agent_not_subscribed' });
  });
});

describe('IngressPipeline on /{backend}/delegations', () => {
  const key = localRsaKey();
  const jwks = JSON.stringify({ keys: [publicJwk(key.publicKey, 'key-1')] });
  const now = () => 1_000_000 * 1000;
  const verifyCaller = delegationTokenVerifierFor({ issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, jwks, now });
  const cfg = (delegation?: { maxDepth: number }) => baseConfig({ issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, delegation });
  const authority = () => {
    const calls: Array<{ caller: DelegationCaller; target: string; maxDepth: number }> = [];
    return {
      calls,
      resolve: async () => ({ token: TXN_TOKEN, txn: 'txn-1', exp: 1, mint: 'miss' as const, grantSize: 1, noToolsGranted: true }),
      delegate: async (c: DelegationCaller, target: string, _t: RegistryEntry, _c: RegistryEntry, maxDepth: number) => {
        calls.push({ caller: c, target, maxDepth });
        return { token: 'replacement', txn: c.txn, exp: 1, mint: 'miss' as const, grantSize: 3, noToolsGranted: false };
      },
    };
  };
  const registry = () => stubRegistry({ billing: FIXTURE_ENTRIES.billing }).registry;

  it('mints the replacement token here when no authoriser context is given, and attributes the request to the token tenant', async () => {
    const a = authority();
    const pipeline = pipelineFor(cfg({ maxDepth: 2 }), { registry: registry(), authority: a, delegationVerifier: verifyCaller });
    const request = await pipeline.validate({ authorization: `Bearer ${await callerToken(key)}`, body: '{"prompt":"hi"}', path: '/billing/delegations' });
    expect(request).toMatchObject({ tenantId: 't-a', sub: 'user-1', backend: 'billing', transactionToken: 'replacement', txn: 'txn-caller', delegatedFrom: 'default', depth: 1 });
    expect(a.calls[0]).toMatchObject({ target: 'billing', maxDepth: 2, caller: { agent: 'default', chain: [] } });
  });

  it('takes the authoriser token once it verifies for this tenant and target; a mismatch is tenant_not_allowed', async () => {
    const forwarded = async (token: string) => (token === 'ok' ? { tenantId: 't-a', agent: 'billing' } : { tenantId: 't-a', agent: 'default' });
    const pipeline = pipelineFor(cfg({ maxDepth: 1 }), { registry: registry(), forwarded, delegationVerifier: verifyCaller });
    const authorized = { tenantId: 't-a', backend: 'billing', transactionToken: 'ok', txn: 'txn-caller', grantSize: 3, mint: 'miss' as const };
    const token = await callerToken(key);
    const request = await pipeline.validate({ authorization: `Bearer ${token}`, body: '{"prompt":"hi"}', path: '/billing/delegations', authorized });
    expect(request).toMatchObject({ backend: 'billing', transactionToken: 'ok', delegatedFrom: 'default', depth: 1 });
    await expect(pipeline.validate({ authorization: `Bearer ${token}`, body: '{"prompt":"hi"}', path: '/billing/delegations', authorized: { ...authorized, transactionToken: 'other' } })).rejects.toMatchObject({ status: 403, reason: 'tenant_not_allowed' });
    await expect(pipeline.validate({ authorization: `Bearer ${token}`, body: '{"prompt":"hi"}', path: '/billing/delegations', authorized: { ...authorized, backend: 'default' } })).rejects.toMatchObject({ status: 403, reason: 'tenant_not_allowed' });
  });

  it('refuses an identity token or no bearer with 401, an unknown target with 404, and a transaction token on /invocations is still 401', async () => {
    const pipeline = pipelineFor(cfg({ maxDepth: 1 }), { registry: registry(), authority: authority(), delegationVerifier: verifyCaller });
    await expect(pipeline.validate({ body: '{"prompt":"hi"}', path: '/billing/delegations' })).rejects.toMatchObject({ status: 401, reason: 'token_invalid' });
    await expect(pipeline.validate({ authorization: 'Bearer not-a-token', body: '{"prompt":"hi"}', path: '/billing/delegations' })).rejects.toMatchObject({ status: 401 });
    await expect(pipeline.validate({ authorization: `Bearer ${await callerToken(key)}`, body: '{"prompt":"hi"}', path: '/nobody/delegations' })).rejects.toMatchObject({ status: 404, reason: 'unknown_backend' });
    await expect(pipeline.validate({ authorization: `Bearer ${await callerToken(key)}`, body: '{"prompt":"hi"}', path: '/billing/invocations' })).rejects.toMatchObject({ status: 401 });
  });

  it('without the module the route is an unknown route (404), whatever the bearer', async () => {
    const pipeline = pipelineFor(cfg(), { registry: registry(), authority: authority() });
    await expect(pipeline.validate({ authorization: `Bearer ${await callerToken(key)}`, body: '{"prompt":"hi"}', path: '/billing/delegations' })).rejects.toMatchObject({ status: 404, reason: 'unknown_backend' });
  });

  it('a refusal from the authority step keeps its status and reason', async () => {
    const refusing = { resolve: authority().resolve, delegate: async () => { throw new AuthorityError(403, 'delegation_loop'); } };
    const pipeline = pipelineFor(cfg({ maxDepth: 1 }), { registry: registry(), authority: refusing, delegationVerifier: verifyCaller });
    await expect(pipeline.validate({ authorization: `Bearer ${await callerToken(key)}`, body: '{"prompt":"hi"}', path: '/billing/delegations' })).rejects.toMatchObject({ status: 403, reason: 'delegation_loop', tenantId: 't-a' });
  });

  it('is a plain IngressPipeline construction: the delegation verifier is optional and only read on the route', () => {
    expect(() => new IngressPipeline(cfg(), undefined as never, registry())).not.toThrow();
    expect(RequestError).toBeDefined();
  });
});

describe('tools interceptor act chain', () => {
  it('accepts a replacement token whose innermost act.sub is the ingress role and reports the chain; refuses a chain ending elsewhere', async () => {
    const key = localRsaKey();
    const getKey = createLocalJWKSet({ keys: [publicJwk(key.publicKey, 'key-1') as never] });
    const deps = { config: { issuer: ISSUER, ingressRoleArn: INGRESS_ROLE, gatewayName: 'default' }, getKey, now: () => 1_000_000 * 1000 };
    const nested = await callerToken(key, { agent: 'billing', aud: ['agent:billing', 'tools-gateway:default'], act: { sub: 'agent:default', act: ROOT } });
    await expect(verifyTransactionToken(nested, deps)).resolves.toMatchObject({ agent: 'billing', chain: ['default'] });
    const plain = await callerToken(key);
    await expect(verifyTransactionToken(plain, deps)).resolves.toMatchObject({ agent: 'default', chain: [] });
    const broken = await callerToken(key, { act: { sub: 'agent:default', act: { sub: 'arn:aws:iam::111122223333:role/Other' } } });
    await expect(verifyTransactionToken(broken, deps)).rejects.toMatchObject({ reason: 'act_missing' });
  });
});
