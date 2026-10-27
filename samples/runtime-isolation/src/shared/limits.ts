// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant limits (ADR-0020): a fixed one-minute window per tenant, kept
 * in one DynamoDB table shared by every ingress instance, so the limit holds
 * fleet-wide rather than per Lambda environment.
 *
 * - Requests: before the TVM and the backend, one conditional `UpdateItem`
 *   adds 1 to the tenant's request count for the current minute and fails
 *   when the count has reached the limit. The caller gets 429; no STS call,
 *   no Runtime session and no model call is made for that request.
 * - Output tokens (api-gateway only): the same update also fails when the
 *   tenant's output tokens for the minute have reached their limit. After
 *   the stream, the ingress adds the tokens the agent reported. A request
 *   that starts under the limit may finish over it: the limit stops the next
 *   request, not the current stream.
 *
 * The tenant comes from the verified token only. Items expire through TTL
 * two minutes after their window. A window boundary lets a tenant make up
 * to twice the limit across two adjacent minutes; the limit bounds a noisy
 * tenant, it is not an exact rate.
 *
 * Failure mode: if DynamoDB itself errors (not a limit hit), the request is
 * admitted and the error is logged. The limit protects availability; turning
 * a DynamoDB fault into a total outage would defeat it (ADR-0020).
 */

import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { errorName, log } from './logger';

export interface TenantLimitsConfig {
  readonly tableName: string;
  /** Requests per tenant per minute; 0 means no request limit. */
  readonly requestsPerMinute: number;
  /** Output tokens per tenant per minute; undefined means no token limit. */
  readonly outputTokensPerMinute?: number;
}

/** The outcome of an admission check. */
export type Admission = 'admitted' | 'limited';

export interface TenantLimiterDependencies {
  readonly dynamo?: Pick<DynamoDBClient, 'send'>;
  readonly now?: () => number;
}

const WINDOW_MS = 60_000;
/** Items live two windows past their own, then TTL removes them. */
const TTL_SECONDS = 180;

/** The item key for a tenant's window: `TENANT#<id>#<epoch minute>`. */
export function windowKey(tenantId: string, nowMs: number): string {
  return `TENANT#${tenantId}#${Math.floor(nowMs / WINDOW_MS)}`;
}

export class TenantLimiter {
  private readonly dynamo: Pick<DynamoDBClient, 'send'>;
  private readonly now: () => number;

  constructor(private readonly config: TenantLimitsConfig, deps: TenantLimiterDependencies = {}) {
    this.dynamo = deps.dynamo ?? new DynamoDBClient({});
    this.now = deps.now ?? Date.now;
  }

  /** Counts one request for the tenant and says whether it may proceed. */
  async admit(tenantId: string): Promise<Admission> {
    const conditions: string[] = [];
    const values: Record<string, { N: string }> = {
      ':one': { N: '1' },
      ':ttl': { N: String(Math.floor(this.now() / 1000) + TTL_SECONDS) },
    };
    if (this.config.requestsPerMinute > 0) {
      conditions.push('(attribute_not_exists(requests) OR requests < :maxRequests)');
      values[':maxRequests'] = { N: String(this.config.requestsPerMinute) };
    }
    if (this.config.outputTokensPerMinute !== undefined) {
      conditions.push('(attribute_not_exists(outputTokens) OR outputTokens < :maxTokens)');
      values[':maxTokens'] = { N: String(this.config.outputTokensPerMinute) };
    }
    if (conditions.length === 0) {
      return 'admitted';
    }
    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.config.tableName,
          Key: { PK: { S: windowKey(tenantId, this.now()) } },
          UpdateExpression: 'ADD requests :one SET expiresAt = :ttl',
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeValues: values,
        }),
      );
      return 'admitted';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || errorName(error) === 'ConditionalCheckFailedException') {
        return 'limited';
      }
      log.error('tenant limit check failed; admitting', { tenantId, error: errorName(error) });
      return 'admitted';
    }
  }

  /** Adds the output tokens a finished request used to the tenant's current window. */
  async recordOutputTokens(tenantId: string, outputTokens: number): Promise<void> {
    if (this.config.outputTokensPerMinute === undefined || !(outputTokens > 0)) {
      return;
    }
    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.config.tableName,
          Key: { PK: { S: windowKey(tenantId, this.now()) } },
          UpdateExpression: 'ADD outputTokens :n SET expiresAt = :ttl',
          ExpressionAttributeValues: {
            ':n': { N: String(Math.floor(outputTokens)) },
            ':ttl': { N: String(Math.floor(this.now() / 1000) + TTL_SECONDS) },
          },
        }),
      );
    } catch (error) {
      log.error('tenant token record failed', { tenantId, error: errorName(error) });
    }
  }
}
