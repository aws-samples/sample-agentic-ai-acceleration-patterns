// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The entitlement API service (spec §5.3, C-14; ADR-0030, ADR-0033). It
 * implements the Smithy-generated `EntitlementsService` for both doors:
 *
 * - vendor (SigV4): tenant subscriptions and plans, written with the
 *   function's own role, which may write `TENANT#*` and `PLAN#*` rows;
 * - tenant admin (identity token with the admin scope): cuts, written with
 *   a DynamoDB client built from credentials vended for the caller's tenant
 *   (`TenantId` session tag), whose role allows item calls only on
 *   `TENANT#${aws:PrincipalTag/TenantId}` (M-45). Name validation reads
 *   plans and the catalogue with the function's own read-only role.
 *
 * A cut may name only something the tenant holds; anything else is 400
 * `not_subscribed` (ADR-0033). No operation adds to a user's set (P-12).
 * Each door refuses the other's operations with 403.
 */

import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { batchGetAll, batchWriteAll } from '../shared/batch';
import {
  KEY_PREFIX,
  nameKey,
  names,
  PLAN_INDEX_PK,
  planIndexKey,
  planKey,
  planMemberKey,
  SORT_KEY,
  tenantKey,
  userCutKey,
} from '../shared/entitlements';
import { expandTools, targetsOf, type ToolCatalogue } from '../shared/grant';
import { errorName, log } from '../shared/logger';
import {
  ConflictError,
  type EntitlementsService,
  ForbiddenError,
  type PlanRow,
  ResourceNotFoundError,
  type TenantSubscriptionRow,
  UpstreamError,
  type UserCutRow,
  ValidationError,
} from '../smithy/entitlements/typescript-ssdk-codegen/src';

/** Who is calling, set by the Lambda before dispatch. */
export interface EntitlementContext {
  readonly side: 'vendor' | 'tenant-admin';
  /** Vendor: the SigV4 caller ARN, for audit. */
  readonly callerArn?: string;
  /** Tenant admin: the selected tenant and the admin's own `sub`. */
  readonly tenantId?: string;
  readonly adminSub?: string;
  /** Tenant admin: a client whose credentials are scoped to `tenantId` (M-45). */
  readonly tenantClient?: DynamoDBDocumentClient;
}

export interface EntitlementServiceOptions {
  readonly tableName: string;
  /** The function's own client: vendor writes, or catalogue reads on the tenant-admin side. */
  readonly client: DynamoDBDocumentClient;
  readonly maxAgentsPerTenant: number;
  readonly maxToolsPerTenant: number;
  readonly now?: () => Date;
  /** The backoff sleep of the batch retries; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function invalid(reason: 'unknown_name' | 'not_subscribed' | 'too_many' | 'invalid_input', message: string): never {
  throw new ValidationError({ message, reason });
}

function rethrow(error: unknown, operation: string): never {
  if (
    error instanceof ValidationError ||
    error instanceof ForbiddenError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ConflictError
  ) {
    throw error;
  }
  log.error('entitlement operation failed', { operation, error: errorName(error) });
  throw new UpstreamError({ message: 'upstream error' });
}

export class EntitlementServiceImpl implements EntitlementsService<EntitlementContext> {
  constructor(private readonly options: EntitlementServiceOptions) {}

  private get table(): string {
    return this.options.tableName;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private requireSide(context: EntitlementContext, side: EntitlementContext['side']): void {
    if (context.side !== side) {
      throw new ForbiddenError({ message: 'forbidden', reason: side === 'vendor' ? 'vendor_only' : 'tenant_admin_only' });
    }
  }

  private tenantSide(context: EntitlementContext): { tenantId: string; adminSub: string; client: DynamoDBDocumentClient } {
    this.requireSide(context, 'tenant-admin');
    if (context.tenantId === undefined || context.adminSub === undefined || context.tenantClient === undefined) {
      throw new ForbiddenError({ message: 'forbidden', reason: 'tenant_required' });
    }
    return { tenantId: context.tenantId, adminSub: context.adminSub, client: context.tenantClient };
  }

  // -------------------------------------------------------------------------
  // Name validation (spec §5.3)
  // -------------------------------------------------------------------------

  /** The catalogue of `targets` (function role: TOOL# reads only). */
  async catalogue(targets: readonly string[]): Promise<ToolCatalogue> {
    const result = new Map<string, string[]>();
    for (const target of targets) {
      const tools: string[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await this.options.client.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `${KEY_PREFIX.tool}${target}` },
            ExclusiveStartKey: start,
          }),
        );
        for (const item of out.Items ?? []) {
          if (typeof item.SK === 'string') {
            tools.push(item.SK.slice(KEY_PREFIX.tool.length));
          }
        }
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      result.set(target, tools);
    }
    return result;
  }

  /** Every agent is a reserved agent name and every tool resolves against the catalogue, else 400 `unknown_name`. */
  async validateVendorNames(agents: readonly string[], tools: readonly string[]): Promise<void> {
    if (agents.length > this.options.maxAgentsPerTenant || tools.length > this.options.maxToolsPerTenant) {
      invalid('too_many', 'too many names');
    }
    if (agents.length > 0) {
      // BatchGetItem takes 100 keys a call; throttled keys are resent (src/shared/batch.ts).
      const found = new Set<string>();
      const unique = [...new Set(agents)];
      for (let i = 0; i < unique.length; i += 100) {
        const out = await batchGetAll(
          this.options.client,
          { [this.table]: { Keys: unique.slice(i, i + 100).map((a) => nameKey(a)) } },
          { sleep: this.options.sleep },
        );
        for (const item of out[this.table] ?? []) {
          if (item.kind === 'agent') {
            found.add(String(item.PK));
          }
        }
      }
      for (const agent of agents) {
        if (!found.has(nameKey(agent).PK)) {
          invalid('unknown_name', 'unknown name');
        }
      }
    }
    const catalogue = await this.catalogue(targetsOf(tools));
    for (const tool of tools) {
      if (expandTools([tool], catalogue).size === 0) {
        invalid('unknown_name', 'unknown name');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Vendor side
  // -------------------------------------------------------------------------

  async PutTenantSubscription(
    input: { tenantId?: string; agents?: string[]; tools?: string[]; plan?: string; status?: 'active' | 'suspended' },
    context: EntitlementContext,
  ): Promise<{ subscription: TenantSubscriptionRow }> {
    this.requireSide(context, 'vendor');
    try {
      const tenantId = input.tenantId!;
      const agents = input.agents ?? [];
      const tools = input.tools ?? [];
      await this.validateVendorNames(agents, tools);
      const key = tenantKey(tenantId);
      // The plan member index (PLAN#<plan> / TENANT#<id>) moves with the row's
      // `plan`, in one transaction conditioned on the plan the row named when
      // it was read, so a concurrent write cannot leave a stale member row.
      const current = await this.options.client.send(
        new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true, ProjectionExpression: '#p', ExpressionAttributeNames: { '#p': 'plan' } }),
      );
      const oldPlan = typeof current.Item?.plan === 'string' && current.Item.plan.length > 0 ? current.Item.plan : undefined;
      const updatedAt = this.now().toISOString();
      const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Update: {
            TableName: this.table,
            Key: key,
            UpdateExpression:
              input.plan === undefined
                ? 'SET agents = :a, tools = :t, #s = :s, updatedAt = :u REMOVE #p ADD version :one'
                : 'SET agents = :a, tools = :t, #s = :s, updatedAt = :u, #p = :p ADD version :one',
            ConditionExpression: oldPlan === undefined ? 'attribute_not_exists(#p)' : '#p = :old',
            ExpressionAttributeNames: { '#s': 'status', '#p': 'plan' },
            ExpressionAttributeValues: {
              ':a': agents,
              ':t': tools,
              ':s': input.status ?? 'active',
              ':u': updatedAt,
              ':one': 1,
              ...(input.plan === undefined ? {} : { ':p': input.plan }),
              ...(oldPlan === undefined ? {} : { ':old': oldPlan }),
            },
          },
        },
      ];
      if (input.plan !== undefined) {
        items.push({ ConditionCheck: { TableName: this.table, Key: planKey(input.plan), ConditionExpression: 'attribute_exists(PK)' } });
        if (input.plan !== oldPlan) {
          items.push({ Put: { TableName: this.table, Item: { ...planMemberKey(input.plan, tenantId), updatedAt } } });
        }
      }
      if (oldPlan !== undefined && oldPlan !== input.plan) {
        items.push({ Delete: { TableName: this.table, Key: planMemberKey(oldPlan, tenantId) } });
      }
      try {
        await this.options.client.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (error) {
        if (error instanceof TransactionCanceledException) {
          const reasons = error.CancellationReasons ?? [];
          if (input.plan !== undefined && reasons[1]?.Code === 'ConditionalCheckFailed') {
            invalid('unknown_name', 'unknown plan');
          }
          throw new ConflictError({ message: 'conflict', reason: 'concurrent_write' });
        }
        throw error;
      }
      const out = await this.options.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
      log.info('entitlement written', { operation: 'PutTenantSubscription', tenantId });
      return { subscription: tenantRow(tenantId, out.Item ?? {}) };
    } catch (error) {
      return rethrow(error, 'PutTenantSubscription');
    }
  }

  async GetTenantSubscription(input: { tenantId?: string }, context: EntitlementContext): Promise<{ subscription: TenantSubscriptionRow }> {
    this.requireSide(context, 'vendor');
    try {
      const out = await this.options.client.send(new GetCommand({ TableName: this.table, Key: tenantKey(input.tenantId!) }));
      if (out.Item === undefined) {
        throw new ResourceNotFoundError({ message: 'not found' });
      }
      return { subscription: tenantRow(input.tenantId!, out.Item) };
    } catch (error) {
      return rethrow(error, 'GetTenantSubscription');
    }
  }

  async DeleteTenantSubscription(input: { tenantId?: string }, context: EntitlementContext): Promise<Record<string, never>> {
    this.requireSide(context, 'vendor');
    try {
      // The tenant row and every cut row of the tenant (one partition).
      let start: Record<string, unknown> | undefined;
      do {
        const out = await this.options.client.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': tenantKey(input.tenantId!).PK },
            ProjectionExpression: 'PK, SK, #p',
            ExpressionAttributeNames: { '#p': 'plan' },
            ExclusiveStartKey: start,
          }),
        );
        const keys: Record<string, unknown>[] = (out.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK }));
        // The tenant row's plan member index row lives in the plan's partition.
        for (const item of out.Items ?? []) {
          if (item.SK === SORT_KEY.subscription && typeof item.plan === 'string' && item.plan.length > 0) {
            keys.push({ ...planMemberKey(item.plan, input.tenantId!) });
          }
        }
        for (let i = 0; i < keys.length; i += 25) {
          // Throttled deletes come back in UnprocessedItems; resent with backoff (src/shared/batch.ts).
          await batchWriteAll(
            this.options.client,
            { [this.table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
            { sleep: this.options.sleep },
          );
        }
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      log.info('entitlement deleted', { operation: 'DeleteTenantSubscription', tenantId: input.tenantId });
      return {};
    } catch (error) {
      return rethrow(error, 'DeleteTenantSubscription');
    }
  }

  async PutPlan(input: { planName?: string; agents?: string[]; tools?: string[] }, context: EntitlementContext): Promise<{ plan: PlanRow }> {
    this.requireSide(context, 'vendor');
    try {
      const planName = input.planName!;
      const agents = input.agents ?? [];
      const tools = input.tools ?? [];
      await this.validateVendorNames(agents, tools);
      const updatedAt = this.now().toISOString();
      // The plan row and its listing row (PLANS / PLAN#<name>) in one transaction.
      await this.options.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: planKey(planName),
                UpdateExpression: 'SET agents = :a, tools = :t, updatedAt = :u ADD version :one',
                ExpressionAttributeValues: { ':a': agents, ':t': tools, ':u': updatedAt, ':one': 1 },
              },
            },
            { Put: { TableName: this.table, Item: { ...planIndexKey(planName), updatedAt } } },
          ],
        }),
      );
      const out = await this.options.client.send(new GetCommand({ TableName: this.table, Key: planKey(planName), ConsistentRead: true }));
      return { plan: planRow(planName, out.Item ?? {}) };
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        return rethrow(new ConflictError({ message: 'conflict', reason: 'concurrent_write' }), 'PutPlan');
      }
      return rethrow(error, 'PutPlan');
    }
  }

  async GetPlan(input: { planName?: string }, context: EntitlementContext): Promise<{ plan: PlanRow }> {
    this.requireSide(context, 'vendor');
    try {
      const out = await this.options.client.send(new GetCommand({ TableName: this.table, Key: planKey(input.planName!) }));
      if (out.Item === undefined) {
        throw new ResourceNotFoundError({ message: 'not found' });
      }
      return { plan: planRow(input.planName!, out.Item) };
    } catch (error) {
      return rethrow(error, 'GetPlan');
    }
  }

  async DeletePlan(input: { planName?: string }, context: EntitlementContext): Promise<Record<string, never>> {
    this.requireSide(context, 'vendor');
    try {
      const planName = input.planName!;
      // plan_in_use: one member row in the plan's own partition is enough (a Query, never a Scan).
      const inUse = await this.options.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tenant)',
          ExpressionAttributeValues: { ':pk': planKey(planName).PK, ':tenant': KEY_PREFIX.tenant },
          ProjectionExpression: 'SK',
          ConsistentRead: true,
          Limit: 1,
        }),
      );
      if ((inUse.Items ?? []).length > 0) {
        throw new ConflictError({ message: 'conflict', reason: 'plan_in_use' });
      }
      await this.options.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: this.table, Key: planKey(planName) } },
            { Delete: { TableName: this.table, Key: planIndexKey(planName) } },
          ],
        }),
      );
      return {};
    } catch (error) {
      return rethrow(error, 'DeletePlan');
    }
  }

  async ListPlans(input: { nextToken?: string }, context: EntitlementContext): Promise<{ plans: PlanRow[]; nextToken?: string }> {
    this.requireSide(context, 'vendor');
    try {
      // The listing rows name the plans, a page at a time; one BatchGetItem reads the rows themselves.
      const page = await this.options.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': PLAN_INDEX_PK },
          ProjectionExpression: 'SK',
          ExclusiveStartKey: decodeToken(input.nextToken, PLAN_INDEX_PK),
          Limit: 100,
        }),
      );
      const planNames = (page.Items ?? []).map((i) => String(i.SK).slice(KEY_PREFIX.plan.length));
      const rows =
        planNames.length === 0
          ? []
          : ((await batchGetAll(this.options.client, { [this.table]: { Keys: planNames.map((n) => planKey(n)) } }, { sleep: this.options.sleep }))[
            this.table
          ] ?? []);
      const byName = new Map(rows.map((i) => [String(i.PK).slice(KEY_PREFIX.plan.length), i]));
      return {
        plans: planNames.filter((n) => byName.has(n)).map((n) => planRow(n, byName.get(n)!)),
        nextToken: encodeToken(page.LastEvaluatedKey),
      };
    } catch (error) {
      return rethrow(error, 'ListPlans');
    }
  }

  // -------------------------------------------------------------------------
  // Tenant-admin side (ADR-0033)
  // -------------------------------------------------------------------------

  /**
   * Every cut name must be something the tenant holds (T = tenant row and
   * its plan), else 400 `not_subscribed` (ADR-0033): an agent the tenant
   * does not hold, a tool outside the catalogue, a `<target>/*` the tenant
   * does not hold whole, or any tool the tenant does not hold. A cut can
   * only remove, so naming anything else is a client error, never a no-op.
   * Returns the tenant row's version.
   */
  async validateCut(tenantId: string, client: DynamoDBDocumentClient, cutAgents: readonly string[], cutTools: readonly string[]): Promise<number> {
    if (cutAgents.length > this.options.maxAgentsPerTenant || cutTools.length > this.options.maxToolsPerTenant) {
      invalid('too_many', 'too many names');
    }
    const tenant = await client.send(new GetCommand({ TableName: this.table, Key: tenantKey(tenantId) }));
    if (tenant.Item === undefined) {
      throw new ResourceNotFoundError({ message: 'not found' });
    }
    const plan =
      typeof tenant.Item.plan === 'string' && tenant.Item.plan.length > 0
        ? (await this.options.client.send(new GetCommand({ TableName: this.table, Key: planKey(tenant.Item.plan) }))).Item
        : undefined;
    const heldAgents = new Set([...names(tenant.Item.agents), ...names(plan?.agents)]);
    const heldToolNames = [...names(tenant.Item.tools), ...names(plan?.tools)];
    if (cutAgents.some((a) => !heldAgents.has(a))) {
      invalid('not_subscribed', 'not subscribed');
    }
    if (cutTools.length > 0) {
      const catalogue = await this.catalogue(targetsOf([...heldToolNames, ...cutTools]));
      const held = expandTools(heldToolNames, catalogue);
      for (const tool of cutTools) {
        const expanded = expandTools([tool], catalogue);
        if (expanded.size === 0 || [...expanded].some((t) => !held.has(t))) {
          invalid('not_subscribed', 'not subscribed');
        }
      }
    }
    return typeof tenant.Item.version === 'number' ? tenant.Item.version : 0;
  }

  async PutUserCut(
    input: { sub?: string; cutAgents?: string[]; cutTools?: string[] },
    context: EntitlementContext,
  ): Promise<{ cut: UserCutRow }> {
    const { tenantId, adminSub, client } = this.tenantSide(context);
    try {
      const cutAgents = input.cutAgents ?? [];
      const cutTools = input.cutTools ?? [];
      await this.validateCut(tenantId, client, cutAgents, cutTools);
      const updatedAt = this.now().toISOString();
      // M-47: the cut and the tenant's version bump are one transaction, conditioned on the tenant row.
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: userCutKey(tenantId, input.sub!),
                UpdateExpression: 'SET cutAgents = :a, cutTools = :t, updatedBy = :by, updatedAt = :u ADD version :one',
                ExpressionAttributeValues: { ':a': cutAgents, ':t': cutTools, ':by': adminSub, ':u': updatedAt, ':one': 1 },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: tenantKey(tenantId),
                UpdateExpression: 'ADD version :one',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeValues: { ':one': 1 },
              },
            },
          ],
        }),
      );
      const out = await client.send(new GetCommand({ TableName: this.table, Key: userCutKey(tenantId, input.sub!), ConsistentRead: true }));
      log.info('entitlement written', { operation: 'PutUserCut', tenantId, cutAgents: cutAgents.length, cutTools: cutTools.length });
      return { cut: cutRow(tenantId, input.sub!, out.Item ?? {}) };
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        throw new ResourceNotFoundError({ message: 'not found' });
      }
      return rethrow(error, 'PutUserCut');
    }
  }

  async GetUserCut(input: { sub?: string }, context: EntitlementContext): Promise<{ cut: UserCutRow }> {
    const { tenantId, client } = this.tenantSide(context);
    try {
      const out = await client.send(new GetCommand({ TableName: this.table, Key: userCutKey(tenantId, input.sub!) }));
      if (out.Item === undefined) {
        throw new ResourceNotFoundError({ message: 'not found' });
      }
      return { cut: cutRow(tenantId, input.sub!, out.Item) };
    } catch (error) {
      return rethrow(error, 'GetUserCut');
    }
  }

  async DeleteUserCut(input: { sub?: string }, context: EntitlementContext): Promise<Record<string, never>> {
    const { tenantId, client } = this.tenantSide(context);
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: this.table, Key: userCutKey(tenantId, input.sub!) } },
            {
              Update: {
                TableName: this.table,
                Key: tenantKey(tenantId),
                UpdateExpression: 'ADD version :one',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeValues: { ':one': 1 },
              },
            },
          ],
        }),
      );
      return {};
    } catch (error) {
      if (error instanceof TransactionCanceledException || error instanceof ConditionalCheckFailedException) {
        return {};
      }
      return rethrow(error, 'DeleteUserCut');
    }
  }

  async ListUserCuts(input: { nextToken?: string }, context: EntitlementContext): Promise<{ cuts: UserCutRow[]; nextToken?: string }> {
    const { tenantId, client } = this.tenantSide(context);
    try {
      const out = await client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :user)',
          ExpressionAttributeValues: { ':pk': tenantKey(tenantId).PK, ':user': KEY_PREFIX.user },
          ExclusiveStartKey: decodeToken(input.nextToken, tenantKey(tenantId).PK),
          Limit: 100,
        }),
      );
      return {
        cuts: (out.Items ?? []).map((i) => cutRow(tenantId, String(i.SK).slice(KEY_PREFIX.user.length), i)),
        nextToken: encodeToken(out.LastEvaluatedKey),
      };
    } catch (error) {
      return rethrow(error, 'ListUserCuts');
    }
  }
}

function version(item: Record<string, unknown>): number {
  return typeof item.version === 'number' ? item.version : 1;
}

function updatedAtOf(item: Record<string, unknown>): Date {
  return typeof item.updatedAt === 'string' ? new Date(item.updatedAt) : new Date(0);
}

export function tenantRow(tenantId: string, item: Record<string, unknown>): TenantSubscriptionRow {
  return {
    tenantId,
    agents: names(item.agents),
    tools: names(item.tools),
    plan: typeof item.plan === 'string' ? item.plan : undefined,
    status: item.status === 'suspended' ? 'suspended' : 'active',
    version: version(item),
    updatedAt: updatedAtOf(item),
  };
}

export function planRow(planName: string, item: Record<string, unknown>): PlanRow {
  return { planName, agents: names(item.agents), tools: names(item.tools), version: version(item), updatedAt: updatedAtOf(item) };
}

export function cutRow(tenantId: string, sub: string, item: Record<string, unknown>): UserCutRow {
  return {
    sub,
    tenantId,
    cutAgents: names(item.cutAgents),
    cutTools: names(item.cutTools),
    version: version(item),
    updatedBy: typeof item.updatedBy === 'string' ? item.updatedBy : 'unknown',
    updatedAt: updatedAtOf(item),
  };
}

/** Pagination tokens are the base64url of the DynamoDB key; opaque to the caller. */
export function encodeToken(key: Record<string, unknown> | undefined): string | undefined {
  return key === undefined ? undefined : Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeToken(token: string | undefined, partition?: string): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    const pk = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).PK : undefined;
    // A token is a key of the partition being listed; anything else is refused, never followed.
    if (typeof pk === 'string' && (partition === undefined || pk === partition)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return invalid('invalid_input', 'invalid nextToken');
}
