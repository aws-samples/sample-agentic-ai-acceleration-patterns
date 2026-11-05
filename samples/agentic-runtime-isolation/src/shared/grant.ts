// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The grant rule (spec P-11, §3.6; ADR-0030, ADR-0032, ADR-0033): the one
 * place that decides what an agent may do for one tenant and one user. Pure,
 * so it is unit-tested exhaustively and exported for consumers that test
 * their own data (spec §6.4, `grantFor`).
 *
 * ```
 * T(tenant)       = tenant.agents ∪ plan.agents, tenant.tools ∪ plan.tools
 * U(tenant, user) = T minus the admin's cuts
 * A(agent)        = agent.needs, agent.tools
 * granted         = A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)
 *                   only if agent ∈ T.agents ∩ U.agents, else agent_not_subscribed
 * ```
 *
 * Every tool set is normalised first: each `<target>/*` is expanded against
 * the catalogue, names not in the catalogue are dropped. The result is
 * compressed back to `<target>/*` only for a target that every contributing
 * set held as `<target>/*` itself: A.tools, T.tools (the tenant row or the
 * plan) and U.tools (no cut names any tool of the target). An explicit list
 * stays explicit even when it happens to cover the whole catalogue today, so
 * a tool added to the target later is not granted by a token minted from it
 * (`<target>/*` in `scope` admits every tool of the target, catalogued or
 * not, at the interceptor and in Policy). The result is sorted, so the same
 * inputs always give the same `scope` string (and the same mint cache
 * entry). `needs` are not expanded or compressed.
 */

/**
 * The `scope` claim bound (spec §3.6): a longer compressed grant is refused
 * with 502 `grant_too_large`, before any KMS call. ADR-0041 raised it from
 * 4,096 to 8,192; ADR-0045 lowered it to 6,144 because the encoded token,
 * not the scope, is what the Runtime bounds (spec V-17: `InvokeAgentRuntime`
 * refuses a custom header value over 10,240 bytes, MAX_TOKEN_BYTES in
 * src/shared/mint.ts). The token is about 4/3 of the scope plus 1.3 KB of
 * the other claims, header and RS256 signature (test/shared/mint.test.ts
 * measures it): a 6,144-byte scope gives a token of about 9.7 KB with long
 * claims, at least 400 bytes under the cap. The mint checks the token
 * itself after signing; this check is the cheap one before it.
 */
export const MAX_SCOPE_BYTES = 6144;

/** The wildcard tool of a target. */
export const TARGET_WILDCARD = '*';

/** Agents and tools, as a tenant row, a plan row or a product definition holds them. */
export interface EntitlementSet {
  readonly agents: readonly string[];
  readonly tools: readonly string[];
}

/** A tenant subscription row's grant-relevant fields (spec §4.5). */
export interface TenantGrant extends EntitlementSet {
  readonly status: 'active' | 'suspended';
}

/** A user cut row's grant-relevant fields (spec §4.5). Absent means "no cut". */
export interface UserCutGrant {
  readonly cutAgents: readonly string[];
  readonly cutTools: readonly string[];
}

/** The agent product (spec §4.3): its name, needs and tools. */
export interface AgentDefinition {
  readonly name: string;
  readonly needs: readonly string[];
  readonly tools: readonly string[];
}

/** Target name to the names of its catalogued tools (the `TOOL#<target>` rows, spec §4.5). */
export type ToolCatalogue = ReadonlyMap<string, readonly string[]>;

export interface GrantInputs {
  /** The tenant row; undefined when the tenant has none (every agent is then `agent_not_subscribed`). */
  readonly tenant?: TenantGrant;
  /** The plan the tenant row names, when it names one and the plan exists. */
  readonly plan?: EntitlementSet;
  /** The user's cut row; undefined when there is none (the common case). */
  readonly cut?: UserCutGrant;
  readonly agent: AgentDefinition;
  /** The catalogue rows of at least every target the agent's tools name. */
  readonly catalogue: ToolCatalogue;
}

export type GrantRefusal = 'agent_not_subscribed' | 'tenant_suspended' | 'grant_too_large';

export type GrantResult =
  | {
    readonly granted: true;
    /** The granted entries, needs and compressed tools together, sorted. */
    readonly entries: readonly string[];
    /** The space-separated `scope` claim. */
    readonly scope: string;
    /** True when the grant holds only the agent's needs (`no_tools_granted`, not an error). */
    readonly noToolsGranted: boolean;
    /** The targets of the granted tools, sorted: what the token's `aud` is resolved from (ADR-0041). */
    readonly toolTargets: readonly string[];
  }
  | { readonly granted: false; readonly reason: GrantRefusal };

function splitTool(name: string): [string, string] | undefined {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) {
    return undefined;
  }
  return [name.slice(0, slash), name.slice(slash + 1)];
}

/**
 * Expands tool names to the full set of catalogued `<target>/<tool>` names:
 * `<target>/*` becomes every catalogued tool of the target; a named tool
 * stays only if catalogued; anything else is dropped.
 */
export function expandTools(names: Iterable<string>, catalogue: ToolCatalogue): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const parts = splitTool(name);
    if (parts === undefined) {
      continue;
    }
    const [target, tool] = parts;
    const known = catalogue.get(target);
    if (known === undefined) {
      continue;
    }
    if (tool === TARGET_WILDCARD) {
      for (const t of known) {
        out.add(`${target}/${t}`);
      }
    } else if (known.includes(tool)) {
      out.add(name);
    }
  }
  return out;
}

/**
 * Compresses a set of full tool names back to `<target>/*` for each target
 * in `wildcardTargets` whose every catalogued tool is in the set, and sorts
 * the result. A target not in `wildcardTargets` keeps its tools named one
 * by one, however many of them there are.
 */
export function compressTools(tools: ReadonlySet<string>, catalogue: ToolCatalogue, wildcardTargets: ReadonlySet<string>): string[] {
  const byTarget = new Map<string, string[]>();
  for (const name of tools) {
    const parts = splitTool(name);
    if (parts === undefined) {
      continue;
    }
    const list = byTarget.get(parts[0]) ?? [];
    list.push(name);
    byTarget.set(parts[0], list);
  }
  const out: string[] = [];
  for (const [target, names] of byTarget) {
    const known = catalogue.get(target) ?? [];
    if (wildcardTargets.has(target) && known.length > 0 && known.every((t) => tools.has(`${target}/${t}`))) {
      out.push(`${target}/${TARGET_WILDCARD}`);
    } else {
      out.push(...names);
    }
  }
  return out.sort();
}

/** The targets a list of tool names refers to: what the catalogue must cover before `grantFor` runs. */
export function targetsOf(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const parts = splitTool(name);
    if (parts !== undefined) {
      out.add(parts[0]);
    }
  }
  return [...out].sort();
}

/** The targets a list of tool names holds as `<target>/*`. */
function wildcardTargetsOf(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const parts = splitTool(name);
    if (parts !== undefined && parts[1] === TARGET_WILDCARD) {
      out.add(parts[0]);
    }
  }
  return out;
}

/** The grant rule (P-11). Pure; never throws for well-formed inputs. */
export function grantFor(inputs: GrantInputs): GrantResult {
  const { tenant, plan, cut, agent, catalogue } = inputs;
  if (tenant === undefined) {
    return { granted: false, reason: 'agent_not_subscribed' };
  }
  if (tenant.status === 'suspended') {
    return { granted: false, reason: 'tenant_suspended' };
  }
  // T
  const tenantAgents = new Set([...tenant.agents, ...(plan?.agents ?? [])]);
  const tenantTools = expandTools([...tenant.tools, ...(plan?.tools ?? [])], catalogue);
  // U = T minus the cuts
  const cutAgents = new Set(cut?.cutAgents ?? []);
  const cutTools = expandTools(cut?.cutTools ?? [], catalogue);
  if (!tenantAgents.has(agent.name) || cutAgents.has(agent.name)) {
    return { granted: false, reason: 'agent_not_subscribed' };
  }
  // A.tools ∩ T.tools ∩ U.tools
  const tools = new Set<string>();
  for (const tool of expandTools(agent.tools, catalogue)) {
    if (tenantTools.has(tool) && !cutTools.has(tool)) {
      tools.add(tool);
    }
  }
  // Compress a target only when A, T and U each held it as `<target>/*`: U
  // does when T does and no cut names the target (a cut of an uncatalogued
  // tool counts, so a tool added later is never let back in by a wildcard).
  const agentWild = wildcardTargetsOf(agent.tools);
  const tenantWild = wildcardTargetsOf([...tenant.tools, ...(plan?.tools ?? [])]);
  const cutTargets = new Set(targetsOf(cut?.cutTools ?? []));
  const wildcards = new Set([...agentWild].filter((t) => tenantWild.has(t) && !cutTargets.has(t)));
  const entries = [...new Set([...agent.needs, ...compressTools(tools, catalogue, wildcards)])].sort();
  const scope = entries.join(' ');
  if (Buffer.byteLength(scope, 'utf8') > MAX_SCOPE_BYTES) {
    return { granted: false, reason: 'grant_too_large' };
  }
  return { granted: true, entries, scope, noToolsGranted: tools.size === 0, toolTargets: targetsOf(tools) };
}

/**
 * Whether a tool (`<target>/<tool>`) is granted by a `scope` claim: the
 * claim holds `<target>/*` or the tool itself as a whole space-separated
 * entry. The interceptor's recheck (C-15a) uses this; Policy applies the
 * same rule in Cedar (src/shared/cedar.ts).
 */
export function scopeGrantsTool(scope: string, tool: string): boolean {
  const parts = splitTool(tool);
  if (parts === undefined || parts[1] === TARGET_WILDCARD) {
    return false;
  }
  const entries = scope.split(' ').filter((s) => s.length > 0);
  return entries.includes(`${parts[0]}/${TARGET_WILDCARD}`) || entries.includes(tool);
}
