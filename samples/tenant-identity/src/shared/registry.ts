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

// ADR-0021: a tenant is PROVISIONING from the registry-first write until its
// Cognito half is built and the row is flipped to ACTIVE (spec §5.1,
// ADR-0021 'registry row before provisioning'). DELETING is offboarding.
export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'DELETING';

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
  /**
   * Every topology: the tenant's API Gateway key (ADR-0025), set by
   * activate(). The value is what the authoriser returns as
   * `usageIdentifierKey`. It is a throttling identifier, not a credential:
   * the API's key source is AUTHORIZER, so API Gateway ignores any
   * `x-api-key` header a caller sends, and the key admits nothing on its own
   * (R-10 allows it: a tenant field, not user data).
   */
  readonly apiKeyId?: string;
  readonly apiKeyValue?: string;
  /**
   * ADR-0032: the tenant's single first-admin slot, claimed by a conditional
   * write before the admin's Cognito user is created and released when that
   * user leaves the tenant. The value is the admin's E-MAIL, not the Cognito
   * username: in pool-per-tenant the pool uses the e-mail as an alias and
   * Cognito generates a UUID username, so the two differ there. The service
   * compares on `UserView.email`, never on the username. This is a tenant
   * fact (which user holds the slot), the one place a user's address
   * reaches the registry; it never leaves through the API (`GetTenant`
   * omits it).
   */
  readonly firstAdminEmail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The fields `activate` writes: the Cognito half, the API key (ADR-0021,
 * ADR-0025) and, for CreateTenant, the first-admin slot (ADR-0032).
 */
export interface ActivatedFields {
  readonly userPoolId?: string;
  readonly appClientId?: string;
  readonly issuer?: string;
  readonly groupName?: string;
  readonly apiKeyId?: string;
  readonly apiKeyValue?: string;
  /**
   * CreateTenant only: the admin's e-mail, written in the same conditional
   * update that flips the row to ACTIVE, so the slot is never empty on an
   * ACTIVE row that CreateTenant is still building. A `CreateUser
   * {firstAdmin: true}` racing the tail of CreateTenant therefore gets a
   * 409 from the claim, never CreateTenant from its own admin step. No
   * guard is needed on the write: a PROVISIONING row refuses CreateUser
   * (P-2), so nothing else can hold the slot before activation.
   */
  readonly firstAdminEmail?: string;
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
   * ADR-0021: flip a PROVISIONING row to ACTIVE, writing the provisioned Cognito
   * fields in the same conditional update (spec §5.1, ADR-0021), and for
   * CreateTenant the first-admin slot too (ADR-0032): the row is never ACTIVE
   * with an empty slot while its admin is still being created. Only the
   * DEFINED fields are written — undefined ones are never set.
   * Returns the ACTIVE record. ConflictError if the row is not PROVISIONING.
   */
  activate(
    tenantId: string,
    provisioned: ActivatedFields,
  ): Promise<TenantRecord>;
  /**
   * R-11: conditional flip to DELETING. Returns the record as it is after
   * the write. Idempotent: an already DELETING tenant is returned as is.
   * Throws NotFoundError if the tenant does not exist.
   */
  markDeleting(tenantId: string): Promise<TenantRecord>;
  /**
   * ADR-0032 (mounting spec M-R-8): claims the tenant's first-admin slot
   * with one conditional write (`attribute_not_exists(firstAdminEmail)`).
   * ConflictError when the slot is held; NotFoundError when the row is gone
   * (the tenant was deleted under the caller). Either way nothing changes.
   */
  claimFirstAdmin(tenantId: string, email: string): Promise<void>;
  /**
   * ADR-0032: re-asserts a claim after the Cognito user exists. One
   * conditional write, `attribute_not_exists(firstAdminEmail) OR
   * firstAdminEmail = :email`: a slot that is still ours, or that a stale
   * release emptied while Cognito ran, is (re)written to `email`; a slot
   * another e-mail took in between is a ConflictError, a vanished row a
   * NotFoundError. Nothing changes on either error.
   */
  confirmFirstAdmin(tenantId: string, email: string): Promise<void>;
  /**
   * ADR-0032 (M-R-8, M-R-9): releases the slot only if `email` holds it
   * (`firstAdminEmail = :email`). A slot held by someone else, or
   * already empty, is left alone and is not an error.
   */
  releaseFirstAdmin(tenantId: string, email: string): Promise<void>;
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

/**
 * Whether a failed condition found a row at all. With
 * `ReturnValuesOnConditionCheckFailure: ALL_OLD` DynamoDB attaches the
 * existing item to the exception; a missing `Item` means the key does not
 * exist (DynamoDB has no old item to return), so the `attribute_exists(PK)`
 * half of the condition is what failed. Presence is all that is read here:
 * the item's shape (marshalled or not) does not matter.
 */
function conditionFailedOnMissingRow(error: unknown): boolean {
  return (error as { Item?: unknown }).Item === undefined;
}

/** batchGet retry backoff: ~25 ms * 2^attempt, capped, with full jitter. */
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 400;
const MAX_BATCH_ATTEMPTS = 6;

/** The real sleep; tests inject an instant one. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter delay before retry `attempt` (1-based). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export class DynamoDBRegistry implements Registry {
  constructor(
    private readonly tableName: string,
    private readonly client: DynamoDBDocumentClient,
    private readonly poolIndexName: string = POOL_INDEX_NAME,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
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
      // Retry unprocessed keys; DynamoDB returns them under throttling, so
      // back off exponentially with jitter between rounds (AWS guidance for
      // UnprocessedKeys) rather than re-sending at once.
      for (let attempt = 0; keys !== undefined && keys.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) {
          throw new Error('Registry batch read did not complete');
        }
        if (attempt > 0) {
          await this.sleep(backoffDelay(attempt));
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
    // The GSI carries tenantId but not status; read the item for its current status.
    return this.get(String(items[0].tenantId));
  }

  async list(nextToken?: string, limit = 50): Promise<Page<TenantRecord>> {
    const result = await this.client.send(
      // A Scan with a filter: Limit counts items read before the filter, so a
      // page can be short (or empty) and still carry a nextToken. The table
      // holds one item type today, so pages are full; keep the filter so a
      // second item type could never leak into ListTenants. A larger registry
      // would list from a GSI instead.
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

  async activate(
    tenantId: string,
    provisioned: ActivatedFields,
  ): Promise<TenantRecord> {
    // ADR-0021: a single conditional update flips PROVISIONING -> ACTIVE and writes
    // the provisioned Cognito fields atomically (spec §5.1, ADR-0021). The
    // condition guards against activating a row that is not PROVISIONING (a
    // concurrent DeleteTenant, or a double activate). Only DEFINED provisioned
    // fields join the SET clause — an undefined attribute is never written.
    const names: Record<string, string> = { '#s': 'status' };
    const values: Record<string, unknown> = {
      ':provisioning': 'PROVISIONING',
      ':active': 'ACTIVE',
      ':now': this.now().toISOString(),
    };
    const sets = ['#s = :active', 'updatedAt = :now'];
    for (const [field, value] of Object.entries(provisioned)) {
      if (value !== undefined) {
        names[`#${field}`] = field;
        values[`:${field}`] = value;
        sets.push(`#${field} = :${field}`);
      }
    }
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(tenantId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK) AND #s = :provisioning',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return fromItem(result.Attributes ?? {});
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new ConflictError(`Tenant ${tenantId} is not PROVISIONING`);
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

  async claimFirstAdmin(tenantId: string, email: string): Promise<void> {
    // ADR-0032: the slot is decided by this conditional write, never by a
    // read (control-plane P-5): two racing claims get one success and one
    // ConflictError whatever order Cognito later sees them in. The
    // attribute_exists(PK) guard keeps an UpdateItem on a vanished row from
    // creating a stub item. ALL_OLD on failure tells the two apart: a row
    // came back, so the slot is held (409); no row, so the tenant is gone
    // (404), which is what the caller would have read had it looked.
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(tenantId),
          UpdateExpression: 'SET firstAdminEmail = :u, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(firstAdminEmail)',
          ExpressionAttributeValues: { ':u': email, ':now': this.now().toISOString() },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        throw this.slotConditionError(tenantId, error);
      }
      throw error;
    }
  }

  async confirmFirstAdmin(tenantId: string, email: string): Promise<void> {
    // ADR-0032: the re-assertion after the Cognito user exists. The claim
    // that preceded createUser can have been released under it by a stale-
    // slot DeleteUser of the same e-mail (the holder was not in Cognito yet,
    // so it looked stale). Writing `email` again when the slot is empty OR
    // still ours closes that window; a slot now held by another e-mail is
    // the one case the caller must undo (the user it just made). Same
    // ALL_OLD split as claimFirstAdmin for a vanished row.
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(tenantId),
          UpdateExpression: 'SET firstAdminEmail = :u, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(firstAdminEmail) OR firstAdminEmail = :u)',
          ExpressionAttributeValues: { ':u': email, ':now': this.now().toISOString() },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        throw this.slotConditionError(tenantId, error);
      }
      throw error;
    }
  }

  /** The modelled error for a failed slot condition: 404 for a missing row, else 409. */
  private slotConditionError(tenantId: string, error: unknown): Error {
    if (conditionFailedOnMissingRow(error)) {
      return new NotFoundError(`Tenant ${tenantId} not found`);
    }
    return new ConflictError(`Tenant ${tenantId} already has a first admin`);
  }

  async releaseFirstAdmin(tenantId: string, email: string): Promise<void> {
    // ADR-0032: the conditional delete of the attribute (M-R-8). Only the
    // holder's e-mail releases the slot, so a release that runs after a new
    // claim (a lost race, or a stale retry) cannot free the newer holder.
    // A failed condition means there is nothing to release: already gone is
    // success (mounting spec M-P-3).
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(tenantId),
          UpdateExpression: 'REMOVE firstAdminEmail SET updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND firstAdminEmail = :u',
          ExpressionAttributeValues: { ':u': email, ':now': this.now().toISOString() },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        return;
      }
      throw error;
    }
  }

  async delete(tenantId: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: key(tenantId) }));
  }
}
