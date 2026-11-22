// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The per-tenant rate limit at the origin (spec §3.6 `tenantRequestsPer5Min`,
 * §6.1, ADR-0009 Option 2). In `single` mode WAF cannot read the tenant from
 * the token, so the cell counts each verified tenant itself. ADR-0009 names
 * no mechanism; this follows `agentic-runtime-isolation`'s ADR-0020: a fixed
 * window per tenant in one DynamoDB table shared by every container, so the
 * limit holds across the cell rather than per Lambda environment.
 *
 * One conditional `UpdateItem` adds 1 to the tenant's count for the current
 * 5-minute window and fails when the count has reached the limit. Items
 * expire through TTL one window after their own. A window boundary lets a
 * tenant make up to twice the limit across two adjacent windows; the limit
 * bounds a noisy tenant, it is not an exact rate.
 *
 * Fail-open: when DynamoDB itself errors (not a limit hit) the request is
 * admitted and the error is logged. The limit protects availability; turning
 * a table fault into an outage for every tenant would defeat it. The client
 * makes two attempts with short timeouts, so an impaired table adds about
 * three seconds at most before the request is admitted.
 */

import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/** The window `tenantRequestsPer5Min` counts over. */
export const WINDOW_SECONDS = 300;

export interface TenantLimiterOptions {
  readonly tableName: string;
  /** Requests per tenant per window; 0 turns the limit off. */
  readonly requestsPer5Min: number;
}

export interface TenantLimiterDependencies {
  readonly dynamo?: Pick<DynamoDBClient, 'send'>;
  readonly now?: () => number;
  /** Where a fail-open is reported; never passed the token. */
  readonly onError?: (tenantId: string, error: unknown) => void;
}

export type Admission = { readonly admitted: true } | { readonly admitted: false; readonly retryAfterSeconds: number };

/** The item key of a tenant's window: `PK=TENANT#<id>`, `SK=WINDOW#<epoch window>` (repo service patterns). */
export function windowKey(tenantId: string, nowMs: number): { PK: string; SK: string } {
  return { PK: `TENANT#${tenantId}`, SK: `WINDOW#${Math.floor(nowMs / 1000 / WINDOW_SECONDS)}` };
}

export class TenantLimiter {
  private readonly dynamo: Pick<DynamoDBClient, 'send'>;
  private readonly now: () => number;

  constructor(private readonly options: TenantLimiterOptions, private readonly deps: TenantLimiterDependencies = {}) {
    this.dynamo =
      deps.dynamo ??
      new DynamoDBClient({ maxAttempts: 2, requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 1000 }) });
    this.now = deps.now ?? Date.now;
  }

  /** Counts one request for the verified tenant and says whether it may proceed. */
  async admit(tenantId: string): Promise<Admission> {
    if (this.options.requestsPer5Min <= 0) {
      return { admitted: true };
    }
    const nowMs = this.now();
    const key = windowKey(tenantId, nowMs);
    const windowEnd = (Math.floor(nowMs / 1000 / WINDOW_SECONDS) + 1) * WINDOW_SECONDS;
    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.options.tableName,
          Key: { PK: { S: key.PK }, SK: { S: key.SK } },
          UpdateExpression: 'ADD requests :one SET expiresAt = :ttl',
          ConditionExpression: 'attribute_not_exists(requests) OR requests < :max',
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':max': { N: String(this.options.requestsPer5Min) },
            ':ttl': { N: String(windowEnd + WINDOW_SECONDS) },
          },
        }),
      );
      return { admitted: true };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (error as { name?: unknown })?.name === 'ConditionalCheckFailedException') {
        return { admitted: false, retryAfterSeconds: Math.max(1, windowEnd - Math.floor(nowMs / 1000)) };
      }
      this.deps.onError?.(tenantId, error);
      return { admitted: true };
    }
  }
}
