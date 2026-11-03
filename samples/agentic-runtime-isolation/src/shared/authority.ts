// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The v2 authority step (spec §3.6, P-11, P-14): entitlement read, grant
 * rule, mint. Run by the function that mints (the API Gateway authoriser,
 * or the AgentCore Gateway interceptor), after the v1 checks and before the
 * TVM. A refusal costs no KMS call (spec §5.1 check order).
 */

import { type EntitlementReader } from './entitlements';
import { grantFor, targetsOf } from './grant';
import type { MintedToken, TokenMinter } from './mint';
import type { RegistryEntry } from './registry';

/** Why the authority step refused, with the status the ingress answers (spec §5.1). */
export class AuthorityError extends Error {
  constructor(
    readonly status: 403 | 502,
    readonly reason: 'agent_not_subscribed' | 'tenant_suspended' | 'grant_too_large' | 'entitlements_unavailable' | 'mint_failed',
  ) {
    super(reason);
    this.name = 'AuthorityError';
  }
}

export interface Authority extends MintedToken {
  /** Entries in `scope` (P-9 `grantSize`). */
  readonly grantSize: number;
  /** The agent holds only its needs: served, any tool call refused at the tools gateway (spec §5.1). */
  readonly noToolsGranted: boolean;
}

export class AuthorityResolver {
  constructor(
    private readonly reader: Pick<EntitlementReader, 'tenantEntitlement' | 'plan' | 'catalogueFor' | 'gatewaysFor'>,
    private readonly minter: Pick<TokenMinter, 'mint'>,
  ) {}

  /** Reads, decides and mints for one (tenant, user, agent). Throws AuthorityError. */
  async resolve(tenantId: string, sub: string, agent: string, entry: RegistryEntry): Promise<Authority> {
    let decision;
    let versions;
    let gateways: string[] = [];
    try {
      const { tenant, cut } = await this.reader.tenantEntitlement(tenantId, sub);
      const plan = tenant?.plan === undefined ? undefined : await this.reader.plan(tenant.plan);
      // The catalogue of every target the agent, the tenant, the plan or the cut names.
      const targets = targetsOf([...entry.tools, ...(tenant?.tools ?? []), ...(plan?.tools ?? []), ...(cut?.cutTools ?? [])]);
      const catalogue = await this.reader.catalogueFor(targets);
      decision = grantFor({ tenant, plan, cut, agent: { name: agent, needs: entry.needs, tools: entry.tools }, catalogue });
      versions = { tenant: tenant?.version ?? 0, agent: entry.version, plan: plan?.version };
      // ADR-0041: aud names the gateway of every granted tool's target, read from the
      // catalogue rows the Query above already cached (no further read).
      if (decision.granted) {
        gateways = [...new Set((await this.reader.gatewaysFor(decision.toolTargets)).values())].sort();
      }
    } catch {
      throw new AuthorityError(502, 'entitlements_unavailable');
    }
    if (!decision.granted) {
      throw new AuthorityError(decision.reason === 'grant_too_large' ? 502 : 403, decision.reason);
    }
    let minted: MintedToken;
    try {
      minted = await this.minter.mint({ tenantId, sub, agent, scope: decision.scope, gateways, versions });
    } catch {
      throw new AuthorityError(502, 'mint_failed');
    }
    return { ...minted, grantSize: decision.entries.length, noToolsGranted: decision.noToolsGranted };
  }
}
