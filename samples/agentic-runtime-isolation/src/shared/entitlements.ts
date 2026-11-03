// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The entitlement store's rows, keys and access helpers (spec §4.5, C-12;
 * ADR-0030, ADR-0033, ADR-0035, ADR-0036). One table per `SharedIngress`,
 * single-table design:
 *
 * | Row | PK | SK |
 * |---|---|---|
 * | Tenant subscription | `TENANT#<tenantId>` | `#SUB` |
 * | User cut | `TENANT#<tenantId>` | `USER#<sub>` |
 * | Plan | `PLAN#<planName>` | `#PLAN` |
 * | Tool catalogue | `TOOL#<target>` | `TOOL#<tool>` |
 * | Name reservation | `NAME#<name>` | `#NAME` |
 * | Plan listing (index) | `PLANS` | `PLAN#<planName>` |
 * | Plan member (index) | `PLAN#<planName>` | `TENANT#<tenantId>` |
 * | Gateway target count | `GATEWAY#<gateway>` | `TARGET#<target>` |
 *
 * The two plan index rows are written in the same transaction as the plan
 * and tenant rows, so `ListPlans` and `DeletePlan`'s `plan_in_use` check are
 * Queries, never Scans. The table keeps no GSI (spec §4.5): a GSI on the
 * tenant row's `plan` would replicate every tenant write for a lookup made
 * only on a plan delete, and the index rows cost one extra item write on the
 * rare plan change instead. The gateway count rows are written by the
 * `ToolTarget` reservation and let a deploy refuse a target that takes its
 * gateway past `maxToolsPerGateway` or 100 targets (ADR-0040, ADR-0041),
 * whatever stack the other targets came from.
 *
 * The ingress only reads (`EntitlementReader`): one `BatchGetItem` for the
 * tenant row and the user's cut row per request, the plan and the catalogue
 * from a per-process cache. Writes are the entitlement API's (src/entitlements)
 * and the deploy-time custom resources' (src/shared/reservation.function.ts).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { batchGetAll } from './batch';
import type { EntitlementSet, TenantGrant, ToolCatalogue, UserCutGrant } from './grant';
import { sharedHandler } from './http';
import { DEFAULT_TOOLS_GATEWAY, TOOLS_GATEWAY_NAME_PATTERN } from './mint';

/** Key attribute names. */
export const PK = 'PK';
export const SK = 'SK';

export const KEY_PREFIX = {
  tenant: 'TENANT#',
  user: 'USER#',
  plan: 'PLAN#',
  tool: 'TOOL#',
  name: 'NAME#',
  gateway: 'GATEWAY#',
  target: 'TARGET#',
} as const;

/** The partition of the plan listing rows (one per plan). */
export const PLAN_INDEX_PK = 'PLANS';

export const SORT_KEY = {
  subscription: '#SUB',
  plan: '#PLAN',
  name: '#NAME',
} as const;

export interface ItemKey {
  readonly PK: string;
  readonly SK: string;
}

export function tenantKey(tenantId: string): ItemKey {
  return { PK: `${KEY_PREFIX.tenant}${tenantId}`, SK: SORT_KEY.subscription };
}

export function userCutKey(tenantId: string, sub: string): ItemKey {
  return { PK: `${KEY_PREFIX.tenant}${tenantId}`, SK: `${KEY_PREFIX.user}${sub}` };
}

export function planKey(planName: string): ItemKey {
  return { PK: `${KEY_PREFIX.plan}${planName}`, SK: SORT_KEY.plan };
}

/** The plan listing row of `planName` (ListPlans Queries the `PLANS` partition). */
export function planIndexKey(planName: string): ItemKey {
  return { PK: PLAN_INDEX_PK, SK: `${KEY_PREFIX.plan}${planName}` };
}

/** The member row that records `tenantId` naming `planName` (DeletePlan's `plan_in_use`). */
export function planMemberKey(planName: string, tenantId: string): ItemKey {
  return { PK: `${KEY_PREFIX.plan}${planName}`, SK: `${KEY_PREFIX.tenant}${tenantId}` };
}

/** The count row of one target on one tools gateway (ADR-0041). */
export function gatewayTargetKey(gateway: string, target: string): ItemKey {
  return { PK: `${KEY_PREFIX.gateway}${gateway}`, SK: `${KEY_PREFIX.target}${target}` };
}

export function toolKey(target: string, tool: string): ItemKey {
  return { PK: `${KEY_PREFIX.tool}${target}`, SK: `${KEY_PREFIX.tool}${tool}` };
}

export function nameKey(name: string): ItemKey {
  return { PK: `${KEY_PREFIX.name}${name}`, SK: SORT_KEY.name };
}

/** A tenant subscription row (spec §4.5). */
export interface TenantSubscriptionItem extends ItemKey {
  readonly agents: string[];
  readonly tools: string[];
  readonly plan?: string;
  readonly status: 'active' | 'suspended';
  readonly version: number;
  readonly updatedAt: string;
}

/** A user cut row (spec §4.5). No field adds anything (P-12). */
export interface UserCutItem extends ItemKey {
  readonly cutAgents: string[];
  readonly cutTools: string[];
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** A plan row (spec §4.5). */
export interface PlanItem extends ItemKey {
  readonly agents: string[];
  readonly tools: string[];
  readonly version: number;
  readonly updatedAt: string;
}

/** A tool catalogue row (spec §4.5), written by `ToolTarget` at deploy. */
export interface ToolItem extends ItemKey {
  readonly description: string;
  /** (ADR-0041) The tools gateway the target lives on; every row of a target carries the same value. */
  readonly gateway: string;
  /** `<StackId>#<LogicalResourceId>` or the deployer's explicit marker (ADR-0035). */
  readonly owner: string;
  readonly addedAt: string;
}

/** A name reservation row (spec §4.5): agents and tool targets share one namespace (ADR-0035). */
export interface NameItem extends ItemKey {
  readonly kind: 'agent' | 'target';
  readonly owner: string;
}

/** DynamoDB string sets and lists both arrive here as arrays; a missing list is empty. */
export function names(value: unknown): string[] {
  if (value instanceof Set) {
    return [...value].filter((v): v is string => typeof v === 'string');
  }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The grant view of a tenant row. */
export function tenantGrant(item: Record<string, unknown>): TenantGrant & { plan?: string; version: number } {
  return {
    agents: names(item.agents),
    tools: names(item.tools),
    status: item.status === 'suspended' ? 'suspended' : 'active',
    plan: typeof item.plan === 'string' && item.plan.length > 0 ? item.plan : undefined,
    version: typeof item.version === 'number' ? item.version : 0,
  };
}

/** The grant view of a cut row. */
export function cutGrant(item: Record<string, unknown>): UserCutGrant {
  return { cutAgents: names(item.cutAgents), cutTools: names(item.cutTools) };
}

/** What the ingress reads per request (spec §3.6). */
export interface TenantEntitlement {
  /** Undefined when the tenant has no row. */
  readonly tenant?: TenantGrant & { readonly plan?: string; readonly version: number };
  /** Undefined when the user has no cut (the common case). */
  readonly cut?: UserCutGrant;
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

/** One target's catalogue rows, as the ingress caches them. */
interface CataloguedTarget {
  readonly tools: string[];
  /** The rows' `gateway`; `default` for rows written before ADR-0041. */
  readonly gateway: string;
}

/**
 * The ingress's read side. Its role holds `BatchGetItem`, `GetItem` and
 * `Query` on the table, never a write (spec §4.5).
 */
export class EntitlementReader {
  private readonly client: DynamoDBDocumentClient;
  private readonly plans = new Map<string, Cached<(EntitlementSet & { version: number }) | undefined>>();
  private readonly catalogue = new Map<string, Cached<CataloguedTarget>>();

  constructor(
    private readonly tableName: string,
    /** Cache life of plans and catalogue rows: `registryTtl` (spec §3.3). */
    private readonly ttlSeconds: number,
    client?: DynamoDBDocumentClient,
    private readonly now: () => number = Date.now,
    /** The backoff sleep of the batch retry; tests pass a no-op. */
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ requestHandler: sharedHandler() }));
  }

  /** One eventually consistent `BatchGetItem` for the tenant row and the user's cut row. */
  async tenantEntitlement(tenantId: string, sub: string): Promise<TenantEntitlement> {
    const tenant = tenantKey(tenantId);
    const cut = userCutKey(tenantId, sub);
    // Throttled keys come back in UnprocessedKeys, not as an error: they are
    // resent with backoff, and a key still unread after that fails the
    // request (502) rather than reading a cut row as "no cut" (spec §3.6).
    const responses = await batchGetAll(
      this.client,
      { [this.tableName]: { Keys: [tenant, cut], ConsistentRead: false } },
      { maxAttempts: 3, sleep: this.sleep },
    );
    const items = responses[this.tableName] ?? [];
    const tenantItem = items.find((i) => i.SK === tenant.SK);
    const cutItem = items.find((i) => i.SK === cut.SK);
    return {
      tenant: tenantItem === undefined ? undefined : tenantGrant(tenantItem),
      cut: cutItem === undefined ? undefined : cutGrant(cutItem),
    };
  }

  /** A plan row, cached `ttlSeconds`; undefined when the plan does not exist. */
  async plan(planName: string): Promise<(EntitlementSet & { version: number }) | undefined> {
    const hit = this.plans.get(planName);
    if (hit !== undefined && this.now() - hit.at < this.ttlSeconds * 1000) {
      return hit.value;
    }
    const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: planKey(planName) }));
    const value =
      out.Item === undefined
        ? undefined
        : { agents: names(out.Item.agents), tools: names(out.Item.tools), version: typeof out.Item.version === 'number' ? out.Item.version : 0 };
    this.plans.set(planName, { value, at: this.now() });
    return value;
  }

  /** The catalogue rows of `targets` (one `Query` per uncached target), cached `ttlSeconds`. */
  async catalogueFor(targets: readonly string[]): Promise<ToolCatalogue> {
    const result = new Map<string, string[]>();
    await Promise.all(targets.map(async (target) => result.set(target, (await this.catalogued(target)).tools)));
    return result;
  }

  /**
   * (ADR-0041) The tools gateway of each target, from the same cached
   * catalogue Query (no extra read for a target `catalogueFor` just read).
   * A target with no catalogue rows is left out.
   */
  async gatewaysFor(targets: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    await Promise.all(
      targets.map(async (target) => {
        const entry = await this.catalogued(target);
        if (entry.tools.length > 0) {
          result.set(target, entry.gateway);
        }
      }),
    );
    return result;
  }

  private async catalogued(target: string): Promise<CataloguedTarget> {
    const hit = this.catalogue.get(target);
    if (hit !== undefined && this.now() - hit.at < this.ttlSeconds * 1000) {
      return hit.value;
    }
    const tools: string[] = [];
    let gateway: string | undefined;
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': PK, '#sk': SK, '#gw': 'gateway' },
          ExpressionAttributeValues: { ':pk': `${KEY_PREFIX.tool}${target}` },
          ProjectionExpression: '#sk, #gw',
          ExclusiveStartKey: start,
        }),
      );
      for (const item of out.Items ?? []) {
        const sk = typeof item.SK === 'string' ? item.SK : '';
        if (sk.startsWith(KEY_PREFIX.tool)) {
          tools.push(sk.slice(KEY_PREFIX.tool.length));
        }
        if (gateway === undefined && typeof item.gateway === 'string' && TOOLS_GATEWAY_NAME_PATTERN.test(item.gateway)) {
          gateway = item.gateway;
        }
      }
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    tools.sort();
    const value = { tools, gateway: gateway ?? DEFAULT_TOOLS_GATEWAY };
    this.catalogue.set(target, { value, at: this.now() });
    return value;
  }
}
