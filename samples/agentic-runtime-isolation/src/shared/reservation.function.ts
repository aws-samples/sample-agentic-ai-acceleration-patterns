// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The owner-marked rows custom resource (spec §4.5, C-16, C-17; ADR-0035,
 * the ADR-0025 owner rule moved to the entitlement store). One resource
 * writes a fixed set of rows: an agent's `NAME#<name>` reservation, or a
 * tool target's `NAME#<target>` reservation plus one `TOOL#<target>` /
 * `TOOL#<tool>` catalogue row per tool. Every row carries `owner`.
 *
 * - Create puts each row with `attribute_not_exists(PK) OR owner = :owner`:
 *   a row another stack holds fails the deploy with
 *   `name <name> already registered by another stack`, never a takeover.
 * - Update does the same for the new set and deletes the old set's rows the
 *   new one dropped, each only while it still carries this owner.
 * - Delete removes each row under `owner = :owner`; a row another stack has
 *   since claimed is left alone.
 *
 * - (ADR-0040, ADR-0041) With `GatewayLimit`, a `ToolTarget`'s resource also
 *   owns a `GATEWAY#<gateway>` / `TARGET#<target>` count row holding its
 *   tool count. Before any write, Create and Update Query that gateway's
 *   count rows, from every stack, and fail the deploy when this target
 *   would take the gateway past `MaxTools` catalogued tools or `MaxTargets`
 *   targets. Synth counts only the targets of its own app; this counts all.
 *   Two deploys racing on one gateway can both pass; the Policy engine's
 *   own schema bound is then the backstop (V-16a).
 *
 * The handler writes no log on success (ADR-0019) and always answers
 * CloudFormation.
 */

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { respond } from './cfn-response';
import { KEY_PREFIX } from './entitlements';
import { errorName, log } from './logger';

/** One row to own: its key and its non-key attributes (never `owner`, which the handler adds). */
export interface OwnedRow {
  readonly PK: string;
  readonly SK: string;
  readonly attributes?: Record<string, string>;
}

/**
 * The per-gateway bound a `ToolTarget` checks at deploy (ADR-0041). Numbers
 * arrive as strings: CloudFormation passes custom resource properties so.
 */
export interface GatewayLimit {
  /** The gateway's name, for the message. */
  readonly Gateway: string;
  /** The target this resource registers. */
  readonly Target: string;
  /** The target's catalogued tools. */
  readonly Tools: string | number;
  readonly MaxTools: string | number;
  readonly MaxTargets: string | number;
}

export interface ReservationProperties {
  readonly TableName: string;
  readonly Rows: OwnedRow[];
  readonly GatewayLimit?: GatewayLimit;
  /** An explicit owner marker; absent, `<StackId>#<LogicalResourceId>`. */
  readonly Owner?: string;
  readonly ServiceToken?: string;
}

export interface ReservationEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResponseURL: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: ReservationProperties;
  readonly OldResourceProperties?: ReservationProperties;
}

export interface ReservationOutcome {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly physicalResourceId: string;
  readonly reason?: string;
}

/** The owner marker (ADR-0035): the explicit `Owner`, else `<StackId>#<LogicalResourceId>`. */
export function ownerMarker(event: Pick<ReservationEvent, 'StackId' | 'LogicalResourceId'>, owner?: string): string {
  return typeof owner === 'string' && owner.length > 0 ? owner : `${event.StackId}#${event.LogicalResourceId}`;
}

/** The name a row reserves, for the deploy-time message: `crm`, or `crm/get_account`. */
export function rowName(row: Pick<OwnedRow, 'PK' | 'SK'>): string {
  if (row.PK.startsWith(KEY_PREFIX.tool)) {
    return `${row.PK.slice(KEY_PREFIX.tool.length)}/${row.SK.slice(KEY_PREFIX.tool.length)}`;
  }
  return row.PK.startsWith(KEY_PREFIX.name) ? row.PK.slice(KEY_PREFIX.name.length) : row.PK;
}

const keyOf = (row: Pick<OwnedRow, 'PK' | 'SK'>) => `${row.PK}\u0000${row.SK}`;

async function claim(client: DynamoDBDocumentClient, table: string, row: OwnedRow, owner: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: { ...(row.attributes ?? {}), PK: row.PK, SK: row.SK, owner },
      ConditionExpression: 'attribute_not_exists(PK) OR #owner = :owner',
      ExpressionAttributeNames: { '#owner': 'owner' },
      ExpressionAttributeValues: { ':owner': owner },
    }),
  );
}

async function release(client: DynamoDBDocumentClient, table: string, row: OwnedRow, owner: string): Promise<void> {
  try {
    await client.send(
      new DeleteCommand({
        TableName: table,
        Key: { PK: row.PK, SK: row.SK },
        ConditionExpression: '#owner = :owner',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': owner },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return; // gone, or another stack's: leave it
    }
    throw error;
  }
}

/**
 * Why `limit` refuses this target, or undefined: the gateway's count rows of
 * every other target, plus this one, against the bounds (ADR-0040, ADR-0041).
 */
export async function gatewayLimitProblem(client: DynamoDBDocumentClient, table: string, limit: GatewayLimit): Promise<string | undefined> {
  const tools = Number(limit.Tools);
  const maxTools = Number(limit.MaxTools);
  const maxTargets = Number(limit.MaxTargets);
  if (![tools, maxTools, maxTargets].every((n) => Number.isInteger(n) && n >= 0)) {
    return 'GatewayLimit must carry whole numbers';
  }
  const ownSk = `${KEY_PREFIX.target}${limit.Target}`;
  let otherTools = 0;
  let otherTargets = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `${KEY_PREFIX.gateway}${limit.Gateway}` },
        ProjectionExpression: 'SK, tools',
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of out.Items ?? []) {
      if (item.SK !== ownSk) {
        otherTargets += 1;
        otherTools += Number(item.tools ?? 0) || 0;
      }
    }
    start = out.LastEvaluatedKey;
  } while (start !== undefined);
  if (otherTargets + 1 > maxTargets) {
    return `tools gateway '${limit.Gateway}' holds at most ${maxTargets} tool targets; target '${limit.Target}' would be number ${otherTargets + 1} (ADR-0040)`;
  }
  if (otherTools + tools > maxTools) {
    return `target '${limit.Target}' would bring tools gateway '${limit.Gateway}' to ${otherTools + tools} catalogued tools, over maxToolsPerGateway ${maxTools} (ADR-0041); put the target on another tools gateway`;
  }
  return undefined;
}

/** Handles one event and returns what to tell CloudFormation. */
export async function handleEvent(event: ReservationEvent, client: DynamoDBDocumentClient): Promise<ReservationOutcome> {
  const properties = event.ResourceProperties;
  const rows = Array.isArray(properties.Rows) ? properties.Rows : [];
  const physicalResourceId = event.PhysicalResourceId ?? `reservation:${rows[0]?.PK ?? 'none'}`;
  if (typeof properties.TableName !== 'string' || properties.TableName.length === 0 || rows.length === 0) {
    return { status: 'FAILED', physicalResourceId, reason: 'TableName and at least one row are required' };
  }
  const owner = ownerMarker(event, properties.Owner);
  try {
    if (event.RequestType === 'Delete') {
      for (const row of rows) {
        await release(client, properties.TableName, row, owner);
      }
      return { status: 'SUCCESS', physicalResourceId };
    }
    if (properties.GatewayLimit !== undefined) {
      const problem = await gatewayLimitProblem(client, properties.TableName, properties.GatewayLimit);
      if (problem !== undefined) {
        return { status: 'FAILED', physicalResourceId, reason: problem };
      }
    }
    for (const row of rows) {
      try {
        await claim(client, properties.TableName, row, owner);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          return { status: 'FAILED', physicalResourceId, reason: `name ${rowName(row)} already registered by another stack` };
        }
        throw error;
      }
    }
    if (event.RequestType === 'Update' && event.OldResourceProperties !== undefined) {
      const kept = new Set(rows.map(keyOf));
      const oldOwner = ownerMarker(event, event.OldResourceProperties.Owner);
      for (const row of event.OldResourceProperties.Rows ?? []) {
        if (!kept.has(keyOf(row))) {
          await release(client, event.OldResourceProperties.TableName ?? properties.TableName, row, oldOwner);
        }
      }
    }
    return { status: 'SUCCESS', physicalResourceId };
  } catch (error) {
    log.error('reservation write failed', { error: errorName(error) });
    return { status: 'FAILED', physicalResourceId, reason: `DynamoDB call failed: ${errorName(error)}` };
  }
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The Lambda entry point. */
export const handler = async (event: ReservationEvent): Promise<void> => {
  let outcome: ReservationOutcome;
  try {
    outcome = await handleEvent(event, client);
  } catch (error) {
    outcome = { status: 'FAILED', physicalResourceId: event.PhysicalResourceId ?? 'reservation', reason: errorName(error) };
  }
  await respond(event, outcome);
};
