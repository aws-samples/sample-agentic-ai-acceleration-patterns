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
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { KEY_PREFIX, nameKey, names, planKey, SORT_KEY, tenantKey, userCutKey } from '../shared/entitlements';
import { expandTools, targetsOf, TARGET_WILDCARD, type ToolCatalogue } from '../shared/grant';
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
      // BatchGetItem takes 100 keys; the agent bound is 100.
      const out = await this.options.client.send(
        new BatchGetCommand({ RequestItems: { [this.table]: { Keys: agents.map((a) => nameKey(a)) } } }),
      );
      const found = new Set((out.Responses?.[this.table] ?? []).filter((i) => i.kind === 'agent').map((i) => String(i.PK)));
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
      const agents = input.agents ?? [];
      const tools = input.tools ?? [];
      await this.validateVendorNames(agents, tools);
      if (input.plan !== undefined) {
        const plan = await this.options.client.send(new GetCommand({ TableName: this.table, Key: planKey(input.plan) }));
        if (plan.Item === undefined) {
          invalid('unknown_name', 'unknown plan');
        }
      }
      const updatedAt = this.now().toISOString();
      const out = await this.options.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: tenantKey(input.tenantId!),
          UpdateExpression:
            input.plan === undefined
              ? 'SET agents = :a, tools = :t, #s = :s, updatedAt = :u REMOVE #p ADD version :one'
              : 'SET agents = :a, tools = :t, #s = :s, updatedAt = :u, #p = :p ADD version :one',
          ExpressionAttributeNames: { '#s': 'status', '#p': 'plan' },
          ExpressionAttributeValues: {
            ':a': agents,
            ':t': tools,
            ':s': input.status ?? 'active',
            ':u': updatedAt,
            ':one': 1,
            ...(input.plan === undefined ? {} : { ':p': input.plan }),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info('entitlement written', { operation: 'PutTenantSubscription', tenantId: input.tenantId });
      return { subscription: tenantRow(input.tenantId!, out.Attributes ?? {}) };
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
            ProjectionExpression: 'PK, SK',
            ExclusiveStartKey: start,
          }),
        );
        const keys = (out.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK }));
        for (let i = 0; i < keys.length; i += 25) {
          // TODO(v2): retry UnprocessedItems.
          await this.options.client.send(
            new BatchWriteCommand({ RequestItems: { [this.table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }),
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
      const agents = input.agents ?? [];
      const tools = input.tools ?? [];
      await this.validateVendorNames(agents, tools);
      const out = await this.options.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: planKey(input.planName!),
          UpdateExpression: 'SET agents = :a, tools = :t, updatedAt = :u ADD version :one',
          ExpressionAttributeValues: { ':a': agents, ':t': tools, ':u': this.now().toISOString(), ':one': 1 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { plan: planRow(input.planName!, out.Attributes ?? {}) };
    } catch (error) {
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
      // TODO(v2): a Scan per delete is fine for tens of plans and a sample; a GSI on `plan` would make it a Query.
      const inUse = await this.options.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'SK = :sub AND #p = :plan',
          ExpressionAttributeNames: { '#p': 'plan' },
          ExpressionAttributeValues: { ':sub': SORT_KEY.subscription, ':plan': input.planName! },
          ProjectionExpression: 'PK',
        }),
      );
      if ((inUse.Items ?? []).length > 0) {
        throw new ConflictError({ message: 'conflict', reason: 'plan_in_use' });
      }
      await this.options.client.send(new DeleteCommand({ TableName: this.table, Key: planKey(input.planName!) }));
      return {};
    } catch (error) {
      return rethrow(error, 'DeletePlan');
    }
  }

  async ListPlans(input: { nextToken?: string }, context: EntitlementContext): Promise<{ plans: PlanRow[]; nextToken?: string }> {
    this.requireSide(context, 'vendor');
    try {
      // TODO(v2): Scan with a filter; tens of plans. A GSI or a `PLANS` index row would make it a Query.
      const out = await this.options.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'SK = :plan',
          ExpressionAttributeValues: { ':plan': SORT_KEY.plan },
          ExclusiveStartKey: decodeToken(input.nextToken),
        }),
      );
      return {
        plans: (out.Items ?? []).map((i) => planRow(String(i.PK).slice(KEY_PREFIX.plan.length), i)),
        nextToken: encodeToken(out.LastEvaluatedKey),
      };
    } catch (error) {
      return rethrow(error, 'ListPlans');
    }
  }

  // -------------------------------------------------------------------------
  // Tenant-admin side (ADR-0033)
  // -------------------------------------------------------------------------

  /** Every cut name must be something the tenant holds (T), else 400 `not_subscribed`. */
  async validateCut(tenantId: string, client: DynamoDBDocumentClient, cutAgents: readonly string[], cutTools: readonly string[]): Promise<number> {
    const tenant = await client.send(new GetCommand({ TableName: this.table, Key: tenantKey(tenantId) }));
    if (tenant.Item === undefined) {
      throw new ResourceNotFoundError({ message: 'not found' });
    }
    const plan =
      typeof tenant.Item.plan === 'string'
        ? (await this.options.client.send(new GetCommand({ TableName: this.table, Key: planKey(tenant.Item.plan) }))).Item
        : undefined;
    const heldAgents = new Set([...names(tenant.Item.agents), ...names(plan?.agents)]);
    const heldToolNames = [...names(tenant.Item.tools), ...names(plan?.tools)];
    if (cutAgents.some((a) => !heldAgents.has(a))) {
      invalid('not_subscribed', 'not subscribed');
    }
    const catalogue = await this.catalogue(targetsOf([...heldToolNames, ...cutTools]));
    const held = expandTools(heldToolNames, catalogue);
    for (const tool of cutTools) {
      const expanded = expandTools([tool], catalogue);
      const wildcard = tool.endsWith(`/${TARGET_WILDCARD}`);
      if (expanded.size === 0 || [...expanded].some((t) => !held.has(t)) || (wildcard && expanded.size === 0)) {
        invalid('not_subscribed', 'not subscribed');
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
          ExclusiveStartKey: decodeToken(input.nextToken),
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

export function decodeToken(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).PK === 'string') {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return invalid('invalid_input', 'invalid nextToken');
}
