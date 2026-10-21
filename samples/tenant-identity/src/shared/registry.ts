// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { POOL_INDEX_NAME, Topology } from './constants';
import { ConflictError, InvalidInputError, NotFoundError } from './errors';

/**
 * The tenant registry (spec §4). It holds tenants only: no user,
 * membership, credential, or token is ever written here (R-10, ADR-0002).
 */

export type TenantStatus = 'ACTIVE' | 'DELETING';

export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly topology: Topology;
  /** pool-per-tenant only. */
  readonly userPoolId?: string;
  readonly appClientId?: string;
  readonly issuer?: string;
  /** shared-pool-multi-tenant only: `t-<tenantId>`. */
  readonly groupName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextToken?: string;
}

/** Read side: everything the trigger and the authoriser may call (R-14). */
export interface RegistryReader {
  get(tenantId: string): Promise<TenantRecord | undefined>;
  /** Missing ids are omitted from the result. */
  batchGet(tenantIds: readonly string[]): Promise<TenantRecord[]>;
  /** pool-per-tenant: the tenant that owns a pool (spec §4.2). */
  getByUserPoolId(userPoolId: string): Promise<TenantRecord | undefined>;
}

export interface Registry extends RegistryReader {
  list(nextToken?: string, limit?: number): Promise<Page<TenantRecord>>;
  /** Fails with ConflictError if the id exists. */
  create(record: TenantRecord): Promise<void>;
  /**
   * R-11: conditional flip to DELETING. Returns the record as it is after
   * the write. Idempotent: an already DELETING tenant is returned as is.
   * Throws NotFoundError if the tenant does not exist.
   */
  markDeleting(tenantId: string): Promise<TenantRecord>;
  /** Removes the item. A missing item is not an error. */
  delete(tenantId: string): Promise<void>;
}

const KEY_PREFIX = 'TENANT#';
const SORT_KEY = 'META';
const MAX_BATCH = 100;

interface TenantItem extends TenantRecord {
  readonly PK: string;
  readonly SK: string;
}

function key(tenantId: string): { PK: string; SK: string } {
  return { PK: `${KEY_PREFIX}${tenantId}`, SK: SORT_KEY };
}

function toItem(record: TenantRecord): TenantItem {
  return { ...key(record.tenantId), ...record };
}

function fromItem(item: Record<string, unknown>): TenantRecord {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as unknown as TenantRecord;
}

function encodeToken(lastKey: Record<string, unknown> | undefined): string | undefined {
  return lastKey === undefined ? undefined : Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64url');
}

function decodeToken(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof parsed?.PK === 'string' && typeof parsed?.SK === 'string' && parsed.PK.startsWith(KEY_PREFIX)) {
      return { PK: parsed.PK, SK: parsed.SK };
    }
  } catch {
    // fall through
  }
  throw new InvalidInputError('Invalid nextToken');
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export class DynamoDBRegistry implements Registry {
  constructor(
    private readonly tableName: string,
    private readonly client: DynamoDBDocumentClient,
    private readonly poolIndexName: string = POOL_INDEX_NAME,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(tenantId: string): Promise<TenantRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key(tenantId), ConsistentRead: true }),
    );
    return result.Item === undefined ? undefined : fromItem(result.Item);
  }

  async batchGet(tenantIds: readonly string[]): Promise<TenantRecord[]> {
    const unique = [...new Set(tenantIds)];
    const records: TenantRecord[] = [];
    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      let keys: Record<string, unknown>[] | undefined = unique.slice(i, i + MAX_BATCH).map(key);
      // Retry unprocessed keys; DynamoDB returns them under throttling.
      for (let attempt = 0; keys !== undefined && keys.length > 0; attempt++) {
        if (attempt > 5) {
          throw new Error('Registry batch read did not complete');
        }
        const result = await this.client.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } },
          }),
        );
        for (const item of result.Responses?.[this.tableName] ?? []) {
          records.push(fromItem(item));
        }
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, unknown>[] | undefined;
      }
    }
    return records;
  }

  async getByUserPoolId(userPoolId: string): Promise<TenantRecord | undefined> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: this.poolIndexName,
        KeyConditionExpression: 'userPoolId = :p',
        ExpressionAttributeValues: { ':p': userPoolId },
        Limit: 2,
      }),
    );
    const items = result.Items ?? [];
    if (items.length > 1) {
      // Pools are created per tenant; two tenants on one pool is corruption.
      throw new Error('Registry maps one user pool to more than one tenant');
    }
    if (items.length === 0) {
      return undefined;
    }
    // The GSI projects keys only; read the item for its current status.
    return this.get(String(items[0].tenantId));
  }

  async list(nextToken?: string, limit = 50): Promise<Page<TenantRecord>> {
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: limit,
        ExclusiveStartKey: decodeToken(nextToken),
        FilterExpression: 'SK = :meta',
        ExpressionAttributeValues: { ':meta': SORT_KEY },
      }),
    );
    return {
      items: (result.Items ?? []).map(fromItem),
      nextToken: encodeToken(result.LastEvaluatedKey),
    };
  }

  async create(record: TenantRecord): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(record),
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new ConflictError(`Tenant ${record.tenantId} already exists`);
      }
      throw error;
    }
  }

  async markDeleting(tenantId: string): Promise<TenantRecord> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(tenantId),
          UpdateExpression: 'SET #s = :deleting, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':deleting': 'DELETING', ':now': this.now().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return fromItem(result.Attributes ?? {});
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }
      throw error;
    }
  }

  async delete(tenantId: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: key(tenantId) }));
  }
}
