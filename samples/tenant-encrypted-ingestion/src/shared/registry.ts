// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry's data model (spec §4, ADR-0010) and its write rules
 * (spec §7.1, M-23).
 *
 * Key rows (`SK = KEY`) and delivery rows (`SK = DELIVERY#<id>`) share each
 * tenant partition, and IAM has no sort-key condition key, so they are kept
 * apart by ATTRIBUTE NAME: the key row's protected attributes (`keyArn`,
 * `tier`, `keyStatus`) appear on no delivery row, and each tenant role may
 * write only its allowlist. The lists below are the ones the construct puts
 * into the tenant roles' `dynamodb:Attributes` conditions
 * (src/construct/roles.ts), and a unit test asserts the two row schemas
 * share no name outside them.
 *
 * Tenant-role code writes with `UpdateItem` only (never `PutItem` or
 * `DeleteItem`, which replace or remove a whole item), names every
 * attribute through a `#name` placeholder, and checks the names against its
 * role's allowlist before sending, so a code change that names a protected
 * attribute fails here, in a unit test, before IAM refuses it.
 */

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const KEY_SK = 'KEY';
export const SYSTEM_PK = 'SYSTEM';

export function tenantPk(tenantId: string): string {
  return `TENANT#${tenantId}`;
}

export function deliverySk(deliveryId: string): string {
  return `DELIVERY#${deliveryId}`;
}

export function keyRowKey(tenantId: string): { PK: string; SK: string } {
  return { PK: tenantPk(tenantId), SK: KEY_SK };
}

export function deliveryRowKey(tenantId: string, deliveryId: string): { PK: string; SK: string } {
  return { PK: tenantPk(tenantId), SK: deliverySk(deliveryId) };
}

/** `KEYARN#<keyArn>`: one key never serves two tenants (spec §4.1). */
export function keyArnItemKey(keyArn: string): { PK: string; SK: string } {
  return { PK: `KEYARN#${keyArn}`, SK: KEY_SK };
}

/** The registry watch's tombstone for a removed tenant (M-24). */
export function tombstoneKey(tenantId: string): { PK: string; SK: string } {
  return { PK: SYSTEM_PK, SK: `TOMBSTONE#${tenantId}` };
}

/** The tenant id of a `TENANT#<id>` partition key, or undefined. */
export function tenantOfPk(pk: unknown): string | undefined {
  return typeof pk === 'string' && pk.startsWith('TENANT#') ? pk.slice('TENANT#'.length) : undefined;
}

/** The delivery id of a `DELIVERY#<id>` sort key, or undefined. */
export function deliveryOfSk(sk: unknown): string | undefined {
  return typeof sk === 'string' && sk.startsWith('DELIVERY#') ? sk.slice('DELIVERY#'.length) : undefined;
}

// ---------------------------------------------------------------------------
// Row schemas (spec §4.1, §4.2)
// ---------------------------------------------------------------------------

export type KeyTier = 'vendor-key' | 'tenant-key';
export type KeyStatus = 'CREATING' | 'ACTIVE' | 'REVOKED' | 'DELETING';
export type DeliveryStatus = 'AWAITING_UPLOAD' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED' | 'KEY_UNAVAILABLE' | 'EXPIRED';

export const OPEN_STATUSES: readonly DeliveryStatus[] = ['AWAITING_UPLOAD', 'PROCESSING'];
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ['ACCEPTED', 'REJECTED', 'KEY_UNAVAILABLE', 'EXPIRED'];

/**
 * `statusBucket` values: `OPEN` while `AWAITING_UPLOAD` or `PROCESSING`
 * (spec §4.2), and `OWED` on a terminal row whose event is not yet on the
 * bus, so the sweep can find and publish it (spec §6.2 "published at least
 * once"); removed once `eventPublishedAt` is set. `EXPIRED` publishes no
 * event and drops the attribute at once (ADR-0021).
 */
export const STATUS_BUCKET = { open: 'OPEN', owed: 'OWED' } as const;

export interface KeyRow {
  readonly PK: string;
  readonly SK: string;
  readonly tier: KeyTier;
  readonly keyArn: string;
  readonly keyAlias?: string;
  readonly keyStatus: KeyStatus;
  readonly apiKeyId?: string;
  readonly inFlight?: number;
  readonly bytesStored?: number;
  readonly deliveriesAccepted?: number;
  readonly deliveriesRejected?: number;
  readonly kmsRequests?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastKeyCheckAt?: string;
}

export interface ValidatorRecord {
  readonly validator: string;
  readonly verdict: 'ACCEPT' | 'REJECT' | 'ERROR';
  readonly code?: string;
  readonly durationMs: number;
}

export interface DeliveryRow {
  readonly PK: string;
  readonly SK: string;
  readonly objectKey: string;
  readonly landedKey?: string;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly declaredSizeBytes: number;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly dropEtag?: string;
  readonly dropVersionId?: string;
  readonly status: DeliveryStatus;
  readonly statusBucket?: string;
  /** Epoch seconds: the GSI sort key. */
  readonly urlExpiresAt: number;
  /** Epoch seconds, DynamoDB TTL. */
  readonly ttl?: number;
  readonly eventPublishedAt?: string;
  readonly reason?: string;
  readonly reasonMessage?: string;
  readonly validators?: ValidatorRecord[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The SQS message id holding the lease. */
  readonly leaseOwner?: string;
  /** Epoch milliseconds. */
  readonly leaseUntil?: number;
}

/** Every attribute name a key row may carry (spec §4.1). */
export const KEY_ROW_ATTRIBUTES = [
  'PK', 'SK', 'tier', 'keyArn', 'keyAlias', 'keyStatus', 'apiKeyId', 'inFlight', 'bytesStored',
  'deliveriesAccepted', 'deliveriesRejected', 'kmsRequests', 'createdAt', 'updatedAt', 'lastKeyCheckAt',
] as const;

/** Every attribute name a delivery row may carry (spec §4.2). */
export const DELIVERY_ROW_ATTRIBUTES = [
  'PK', 'SK', 'objectKey', 'landedKey', 'fileName', 'declaredContentType', 'declaredSizeBytes', 'sizeBytes',
  'sha256', 'dropEtag', 'dropVersionId', 'status', 'statusBucket', 'urlExpiresAt', 'ttl', 'eventPublishedAt',
  'reason', 'reasonMessage', 'validators', 'createdBy', 'createdAt', 'updatedAt', 'leaseOwner', 'leaseUntil',
] as const;

/**
 * Names no tenant role may name in any request (spec §7.1 ProtectKeyBinding).
 * `apiKeyValue` is on no row: naming it keeps code from ever storing a usage
 * key value beside the binding.
 */
export const PROTECTED_ATTRIBUTES = ['keyArn', 'tier', 'apiKeyValue', 'keyStatus'] as const;

/** `tenantUploadRole` (spec §7.1): creates the delivery row and counts it. */
export const UPLOAD_ROLE_ATTRIBUTES = [
  'PK', 'SK', 'objectKey', 'fileName', 'declaredContentType', 'declaredSizeBytes', 'status', 'statusBucket',
  'urlExpiresAt', 'createdBy', 'createdAt', 'updatedAt', 'inFlight',
] as const;

/** `tenantProcessRole` (spec §7.1, the JSON policy verbatim). */
export const PROCESS_ROLE_ATTRIBUTES = [
  'PK', 'SK', 'status', 'statusBucket', 'leaseOwner', 'leaseUntil', 'sizeBytes', 'sha256', 'dropEtag',
  'dropVersionId', 'landedKey', 'reason', 'reasonMessage', 'validators', 'ttl', 'eventPublishedAt', 'updatedAt',
  'inFlight', 'bytesStored', 'deliveriesAccepted', 'deliveriesRejected', 'kmsRequests',
] as const;

/** `processorRole` on a key row: sets `REVOKED` and nothing else (spec §7.1). */
export const PROCESSOR_KEY_ROW_ATTRIBUTES = ['PK', 'SK', 'keyStatus', 'lastKeyCheckAt', 'updatedAt'] as const;

/** `platformRole` and `sweepRole` may never name these in an update (spec §7.1). */
export const BASE_ROLE_DENIED_UPDATE_ATTRIBUTES = ['keyArn', 'tier'] as const;

/** The names both row schemas carry by design: keys and timestamps. */
export const SHARED_ROW_ATTRIBUTES = ['PK', 'SK', 'createdAt', 'updatedAt'] as const;

// ---------------------------------------------------------------------------
// Update builders
// ---------------------------------------------------------------------------

export interface UpdateSpec {
  /** `SET #name = :value` for each entry. */
  readonly set?: Record<string, unknown>;
  /** `ADD #name :value` for each entry (counters). */
  readonly add?: Record<string, number>;
  /** `REMOVE #name` for each entry. */
  readonly remove?: readonly string[];
  /** A condition written with `#name` placeholders for attribute names and `:value` tokens. */
  readonly condition?: string;
  /** Values for the condition's `:value` tokens. */
  readonly values?: Record<string, unknown>;
}

/** An `UpdateItem` input without `TableName`. */
export interface RegistryUpdate {
  readonly Key: { PK: string; SK: string };
  readonly UpdateExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
  readonly ConditionExpression?: string;
  readonly ReturnValues: 'NONE';
}

export class AttributeNotAllowedError extends Error {
  constructor(readonly attribute: string) {
    super(`attribute ${attribute} is outside this role's allowlist`);
    this.name = 'AttributeNotAllowedError';
  }
}

const NAME_TOKEN = /#([A-Za-z][A-Za-z0-9]*)/g;

/** True when `text` holds `placeholder` as a whole token (not as a prefix of a longer name); a plain scan, no dynamic RegExp. */
function mentionsPlaceholder(text: string, placeholder: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(placeholder, from);
    if (at < 0) {
      return false;
    }
    const next = text.charAt(at + placeholder.length);
    if (next === '' || !/[A-Za-z0-9]/.test(next)) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * An `UpdateItem` input (without `TableName`) for `spec`. Every attribute
 * name is a `#name` placeholder, so `ExpressionAttributeNames` is exactly the
 * set of names the request touches, which is what IAM's
 * `dynamodb:Attributes` evaluates. With `allowlist`, a name outside it
 * throws before the request is sent.
 */
export function updateExpression(
  key: { PK: string; SK: string },
  spec: UpdateSpec,
  allowlist?: readonly string[],
): RegistryUpdate {
  const names: Record<string, string> = { '#PK': 'PK', '#SK': 'SK' };
  const values: Record<string, unknown> = { ...(spec.values ?? {}) };
  const clauses: string[] = [];

  const setEntries = Object.entries(spec.set ?? {}).filter(([, v]) => v !== undefined);
  if (setEntries.length > 0) {
    clauses.push(
      'SET ' +
        setEntries
          .map(([name, value]) => {
            names[`#${name}`] = name;
            values[`:set_${name}`] = value;
            return `#${name} = :set_${name}`;
          })
          .join(', '),
    );
  }
  const addEntries = Object.entries(spec.add ?? {});
  if (addEntries.length > 0) {
    clauses.push(
      'ADD ' +
        addEntries
          .map(([name, value]) => {
            names[`#${name}`] = name;
            values[`:add_${name}`] = value;
            return `#${name} :add_${name}`;
          })
          .join(', '),
    );
  }
  if ((spec.remove ?? []).length > 0) {
    clauses.push(
      'REMOVE ' +
        (spec.remove ?? [])
          .map((name) => {
            names[`#${name}`] = name;
            return `#${name}`;
          })
          .join(', '),
    );
  }
  for (const match of (spec.condition ?? '').matchAll(NAME_TOKEN)) {
    names[`#${match[1]}`] = match[1];
  }
  // PK and SK are always placeholders so the name map is the full set, but
  // a request that does not use them must not declare them (DynamoDB
  // refuses unused names).
  const used = `${clauses.join(' ')} ${spec.condition ?? ''}`;
  for (const placeholder of Object.keys(names)) {
    if (!mentionsPlaceholder(used, placeholder)) {
      delete names[placeholder];
    }
  }
  if (allowlist !== undefined) {
    for (const name of Object.values(names)) {
      if (!allowlist.includes(name)) {
        throw new AttributeNotAllowedError(name);
      }
    }
  }
  return {
    Key: key,
    UpdateExpression: clauses.join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    ...(spec.condition !== undefined ? { ConditionExpression: spec.condition } : {}),
    ReturnValues: 'NONE',
  };
}

/** A `TransactWriteItems` Update entry for `spec` (no `ReturnValues`, which transactions refuse). */
export function transactUpdate(
  tableName: string,
  key: { PK: string; SK: string },
  spec: UpdateSpec,
  allowlist?: readonly string[],
): { Update: Omit<RegistryUpdate, 'ReturnValues'> & { TableName: string } } {
  const { ReturnValues: _ignored, ...rest } = updateExpression(key, spec, allowlist);
  return { Update: { TableName: tableName, ...rest } };
}

/** An `UpdateCommand` input for `spec`. */
export function updateInput(
  tableName: string,
  key: { PK: string; SK: string },
  spec: UpdateSpec,
  allowlist?: readonly string[],
): RegistryUpdate & { TableName: string } {
  return { TableName: tableName, ...updateExpression(key, spec, allowlist) };
}

/** The attribute names an update input touches (for tests and the allowlist check). */
export function attributeNames(input: { ExpressionAttributeNames?: Record<string, string> }): string[] {
  return Object.values(input.ExpressionAttributeNames ?? {});
}

/** ISO timestamp now. */
export function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** A terminal row's TTL: 30 days on (spec §4.2). */
export function terminalTtl(now: number = Date.now()): number {
  return Math.floor(now / 1000) + 30 * 24 * 3600;
}
