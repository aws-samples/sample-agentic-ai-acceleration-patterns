// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import { DataModel, DynamoDBItem } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { ItemKey } from '../shared/repository';

/** Composite key prefix for idempotency items. */
export const IDEMPOTENCY_KEY_PREFIX = 'IDEMPOTENCY';
/** Fixed sort key — one record per client token. */
export const IDEMPOTENCY_SORT_KEY = 'META';
/**
 * How long a `clientToken` is honoured (ADR-017). The record's `expiresAt`
 * drives DynamoDB TTL garbage collection; because TTL deletion is lazy, a
 * token is honoured for AT LEAST this long — replay handling deliberately
 * ignores `expiresAt` and treats any surviving record as authoritative.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * The CreateDeployment idempotency record (ADR-017): written in the same
 * `TransactWriteItems` as the placement, conditional on
 * `attribute_not_exists(PK)`. A cancelled write on this item marks the
 * request as a replay of an earlier CreateDeployment with the same
 * `clientToken`.
 */
export interface IdempotencyRecord {
  /** The client-supplied token — the item's identity. */
  readonly clientToken: string;
  /** The deployment the original request created: its tenant ... */
  readonly tenantId: string;
  /** ... and its application. */
  readonly applicationId: string;
  /**
   * SHA-256 over the original request parameters. A replay whose hash
   * differs is a token reuse with different input — rejected with the 409.
   */
  readonly requestHash: string;
  readonly createdAt: Date;
  /** Epoch seconds — the DynamoDB TTL attribute. */
  readonly expiresAt: number;
}

/** DynamoDB item representation of an {@link IdempotencyRecord}. */
export interface IdempotencyItem extends DynamoDBItem {
  readonly clientToken: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly requestHash: string;
  readonly createdAt: string;
  readonly expiresAt: number;
}

/** Builds the composite base-table key for an idempotency record. */
export function idempotencyKey(clientToken: string): ItemKey {
  return { PK: KeyBuilder.build(IDEMPOTENCY_KEY_PREFIX, clientToken), SK: IDEMPOTENCY_SORT_KEY };
}

/**
 * Canonical hash over the CreateDeployment parameters that define the
 * request's identity (spec §7.3). Positional array form — key order cannot
 * vary; an absent accountId hashes as null, distinct from an empty string.
 * tenantId, applicationId and accountId are all part of the identity: the
 * same token with a different tenant, application or target account is a
 * different request and must be refused (409), not replayed.
 *
 * The parameter values (ADR-039) are part of it too, as name-sorted
 * `[name, value]` pairs appended to the array — but only when there is at
 * least one: an absent map and `{}` are the same request and hash exactly
 * as a request did before parameters existed, so a token issued before the
 * upgrade still replays inside its window (§7.3).
 */
export function createDeploymentRequestHash(params: {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly adminEmail: string;
  readonly accountId?: string;
  readonly parameters?: Readonly<Record<string, string>>;
}): string {
  const identity: unknown[] = [params.tenantId, params.applicationId, params.adminEmail, params.accountId ?? null];
  const parameters = Object.entries(params.parameters ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (parameters.length > 0) {
    identity.push(parameters);
  }
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

/** Converts between {@link IdempotencyRecord} and its DynamoDB item. */
export class IdempotencyDataModel implements DataModel<IdempotencyRecord, IdempotencyItem> {
  toItem(record: IdempotencyRecord): IdempotencyItem {
    return {
      ...idempotencyKey(record.clientToken),
      clientToken: record.clientToken,
      tenantId: record.tenantId,
      applicationId: record.applicationId,
      requestHash: record.requestHash,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt,
    };
  }

  fromItem(item: IdempotencyItem): IdempotencyRecord {
    return {
      clientToken: item.clientToken,
      tenantId: item.tenantId,
      applicationId: item.applicationId,
      requestHash: item.requestHash,
      createdAt: new Date(item.createdAt),
      expiresAt: item.expiresAt,
    };
  }
}
