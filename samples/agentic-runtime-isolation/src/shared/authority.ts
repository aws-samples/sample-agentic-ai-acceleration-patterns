// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The v2 authority step (spec §3.6, P-11, P-14): entitlement read, grant
 * rule, mint. Run by the function that mints (the API Gateway authoriser,
 * or the AgentCore Gateway interceptor), after the v1 checks and before the
 * TVM. A refusal costs no KMS call (spec §5.1 check order).
 */

import type { DelegationCaller } from './delegation';
import { type EntitlementReader } from './entitlements';
import { grantFor, targetsOf } from './grant';
import { type DelegationInput, type MintedToken, type TokenMinter, TokenTooLargeError } from './mint';
import type { RegistryEntry } from './registry';

/** The reasons the authority step refuses with (spec §5.1, §5.1.1). */
export type AuthorityRefusal =
  | 'agent_not_subscribed'
  | 'tenant_suspended'
  | 'grant_too_large'
  | 'entitlements_unavailable'
  | 'mint_failed'
  | 'delegation_not_declared'
  | 'delegation_depth'
  | 'delegation_loop';

/** Why the authority step refused, with the status the ingress answers (spec §5.1). */
export class AuthorityError extends Error {
  constructor(
    readonly status: 403 | 502,
    readonly reason: AuthorityRefusal,
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

/**
 * (ADR-0048, spec §5.1.1) The three delegation checks, which need only the
 * caller's registry entry and cost nothing: the entry names the target
 * (`delegation_not_declared`), the chain after the hop fits `maxDepth`
 * (`delegation_depth`), the target is neither the caller nor already in the
 * chain (`delegation_loop`). Run before the target is looked up, so an
 * undeclared target is refused without revealing whether it exists.
 */
export function checkDelegation(caller: DelegationCaller, target: string, callerEntry: RegistryEntry, maxDepth: number): void {
  if (!callerEntry.delegatesTo.includes(target)) {
    throw new AuthorityError(403, 'delegation_not_declared');
  }
  // The chain after the hop holds the caller's chain plus the caller.
  if (caller.chain.length + 1 > maxDepth) {
    throw new AuthorityError(403, 'delegation_depth');
  }
  if (target === caller.agent || caller.chain.includes(target)) {
    throw new AuthorityError(403, 'delegation_loop');
  }
}

export class AuthorityResolver {
  constructor(
    private readonly reader: Pick<EntitlementReader, 'tenantEntitlement' | 'plan' | 'catalogueFor' | 'gatewaysFor'>,
    private readonly minter: Pick<TokenMinter, 'mint'>,
  ) {}

  /** Reads, decides and mints for one (tenant, user, agent). Throws AuthorityError. */
  async resolve(tenantId: string, sub: string, agent: string, entry: RegistryEntry): Promise<Authority> {
    return this.grant(tenantId, sub, agent, entry);
  }

  /**
   * (ADR-0048, spec §3.7) Decides a delegation from `caller` to `target` and
   * mints the replacement token. The three delegation checks run first and
   * cost nothing: the caller's registry entry must name the target
   * (`delegation_not_declared`), the chain after the hop must fit `maxDepth`
   * (`delegation_depth`), and the target must be neither the caller nor an
   * agent already in the chain (`delegation_loop`). Then the target is
   * granted exactly as a direct call by the same tenant and user would be,
   * and the token is minted with the caller nested in `act` and the caller's
   * `txn`, uncached.
   */
  async delegate(
    caller: DelegationCaller,
    target: string,
    targetEntry: RegistryEntry,
    callerEntry: RegistryEntry,
    maxDepth: number,
  ): Promise<Authority> {
    checkDelegation(caller, target, callerEntry, maxDepth);
    return this.grant(caller.tenantId, caller.sub, target, targetEntry, { from: caller.agent, act: caller.act, txn: caller.txn });
  }

  private async grant(tenantId: string, sub: string, agent: string, entry: RegistryEntry, delegation?: DelegationInput): Promise<Authority> {
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
      minted = await this.minter.mint({
        tenantId,
        sub,
        agent,
        scope: decision.scope,
        gateways,
        versions,
        ...(delegation === undefined ? {} : { delegation }),
      });
    } catch (error) {
      // A token over MAX_TOKEN_BYTES (ADR-0045) is the same refusal as a scope
      // over MAX_SCOPE_BYTES: the grant is too large to carry.
      throw new AuthorityError(502, error instanceof TokenTooLargeError ? 'grant_too_large' : 'mint_failed');
    }
    return { ...minted, grantSize: decision.entries.length, noToolsGranted: decision.noToolsGranted };
  }
}
