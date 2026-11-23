// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DataModel, DynamoDBItem } from './data-model';
import {
  AmbiguousTransactionError,
  cancellationCodes,
  ConditionFailedError,
  defaultDocumentClient,
  ItemKey,
  sendTransactionWithRaceRetry,
  TransactionRaceError,
} from './repository';

/**
 * A hook-create transaction was cancelled because the hook `Put`'s
 * `attribute_not_exists(PK)` condition failed: a concurrent create of the
 * same hook won (spec R-39). A retry becomes a replace, so the service maps
 * it to a retryable 409.
 */
export class HookExistsError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'HookExistsError';
  }
}

/**
 * A hook-create transaction was cancelled because the hook counter refused
 * the claim: the maximum number of global hooks is registered (spec R-39).
 * The remedy is `DeleteHook`, so the service maps it to a 409 without a
 * retry hint.
 */
export class HookLimitError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'HookLimitError';
  }
}

/**
 * A hook-delete transaction was cancelled because the hook's
 * `attribute_exists(PK)` condition failed: the hook is not registered, or a
 * concurrent delete won. The service maps it to the 404.
 */
export class HookGoneError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'HookGoneError';
  }
}

/**
 * The two code paths that touch the hook counter (spec P-6, R-39): a global
 * hook is created and the counter claimed in one `TransactWriteItems`, and
 * deleted and the counter released in another. `hookCount` is the
 * authoritative count of global hooks; no other code writes it. Replacing a
 * hook is a single conditional update on the hook item
 * (`DynamoDBRepository.updateExisting`) and never touches the counter.
 *
 * @typeParam THookSchema / THookItem - the hook record and its item shape
 */
export class HookTransactions<THookSchema, THookItem extends DynamoDBItem> {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly hookDataModel: DataModel<THookSchema, THookItem>,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? defaultDocumentClient();
  }

  /**
   * Creates a hook and claims a counter slot, atomically:
   *
   * - `Put` hook, condition `attribute_not_exists(PK)` - the FIRST item
   * - `Update` counter: `SET hookCount = if_not_exists(hookCount, 0) + 1`,
   *   condition `attribute_not_exists(hookCount) OR hookCount < maxHooks`;
   *   the counter item is created by its first claim
   *
   * A failed hook condition throws {@link HookExistsError} (a concurrent
   * create won; it takes precedence over the counter, because the retry is
   * then a replace); a failed counter condition alone throws
   * {@link HookLimitError}. A cancellation by races alone (concurrent writes
   * on the shared counter) is sent again and then is a
   * {@link TransactionRaceError} (ADR-0050). Anything else is an
   * {@link AmbiguousTransactionError}.
   */
  async createHook(params: {
    readonly hook: THookSchema;
    readonly counterKey: ItemKey;
    readonly maxHooks: number;
    /** ISO-8601 timestamp written to the counter's `updatedAt`. */
    readonly updatedAt: string;
  }): Promise<void> {
    try {
      await sendTransactionWithRaceRetry(this.client, 'Hook create transaction', () =>
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: this.hookDataModel.toItem(params.hook),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: params.counterKey,
                UpdateExpression: 'SET #hookCount = if_not_exists(#hookCount, :zero) + :one, #updatedAt = :updatedAt',
                ConditionExpression: 'attribute_not_exists(#hookCount) OR #hookCount < :max',
                ExpressionAttributeNames: { '#hookCount': 'hookCount', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: {
                  ':zero': 0,
                  ':one': 1,
                  ':max': params.maxHooks,
                  ':updatedAt': params.updatedAt,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionRaceError) {
        throw error;
      }
      const codes = cancellationCodes(error);
      if (codes?.[0] === 'ConditionalCheckFailed') {
        throw new HookExistsError('The hook was created concurrently');
      }
      if (codes?.[1] === 'ConditionalCheckFailed') {
        throw new HookLimitError('The maximum number of global hooks is registered');
      }
      throw new AmbiguousTransactionError('Hook create transaction failed', error);
    }
  }

  /**
   * Deletes a hook and releases its counter slot, atomically:
   *
   * - `Delete` hook, condition `attribute_exists(PK)` - the FIRST item
   * - `Update` counter: `SET hookCount = hookCount - 1`, condition
   *   `hookCount > 0`
   *
   * A failed hook condition throws {@link HookGoneError}. A failed counter
   * condition alone means a hook exists that the counter does not count, an
   * invariant violation: an {@link AmbiguousTransactionError}, never a silent
   * success. A cancellation by races alone is sent again and then is a
   * {@link TransactionRaceError} (ADR-0050).
   */
  async deleteHook(params: {
    readonly hookKey: ItemKey;
    readonly counterKey: ItemKey;
    readonly updatedAt: string;
  }): Promise<void> {
    try {
      await sendTransactionWithRaceRetry(this.client, 'Hook delete transaction', () =>
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: params.hookKey,
                ConditionExpression: 'attribute_exists(PK)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: params.counterKey,
                UpdateExpression: 'SET #hookCount = #hookCount - :one, #updatedAt = :updatedAt',
                ConditionExpression: '#hookCount > :zero',
                ExpressionAttributeNames: { '#hookCount': 'hookCount', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':updatedAt': params.updatedAt },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionRaceError) {
        throw error;
      }
      const codes = cancellationCodes(error);
      if (codes?.[0] === 'ConditionalCheckFailed') {
        throw new HookGoneError('The hook is not registered');
      }
      throw new AmbiguousTransactionError('Hook delete transaction failed', error);
    }
  }
}
