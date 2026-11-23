// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { DataModel, DynamoDBItem } from './data-model';
import { LifecycleStatus, ValidationException } from '../smithy/source/typescript-ssdk-codegen/src';
import { LIVE_STATUSES, readRecordStatus } from '../tenant/record-event.types';

/** A composite primary key locating one item. */
export interface ItemKey {
  readonly PK: string;
  readonly SK: string;
}

/** Optional condition applied to a write. */
export interface WriteCondition {
  readonly conditionExpression: string;
  readonly expressionAttributeNames?: Record<string, string>;
  readonly expressionAttributeValues?: Record<string, unknown>;
}

/** Field-level update applied to one item. */
export interface ItemUpdate {
  readonly updateExpression: string;
  readonly expressionAttributeNames?: Record<string, string>;
  readonly expressionAttributeValues: Record<string, unknown>;
  readonly conditionExpression?: string;
}

/**
 * A compare-and-set lifecycle status transition. The condition checks the
 * exact expected status or the operation's accepted status set — this is
 * both the concurrency guard and an existence check (a missing item cannot
 * match any status), per §7 of the architecture.
 */
export interface StatusTransition {
  /** Accepted current status(es) — the compare of the compare-and-set. */
  readonly fromAnyOf: readonly string[];
  /** The status written on success. */
  readonly to: string;
  /** ISO-8601 timestamp written to `updatedAt`. */
  readonly updatedAt: string;
  /**
   * Additional owned fields to set alongside the transition (e.g.
   * `statusReason`, `lastBuildId`). Must not include `status`/`updatedAt`.
   */
  readonly setFields?: Record<string, unknown>;
  /** Owned fields to remove (e.g. clearing `statusReason` on a retry). */
  readonly removeFields?: readonly string[];
  /**
   * Extra condition ANDed with the status check — e.g. the DeleteCell
   * transition's `tenantCount = 0` emptiness guard (ADR-014).
   */
  readonly extraCondition?: WriteCondition;
  /**
   * Read an absent `status` as `ACTIVE` (R-47): when `fromAnyOf` holds
   * `ACTIVE`, the status check becomes `(attribute_not_exists(#status) OR
   * #status IN (...))`, so an application, tenant or account stored before
   * these records had a status still matches. Ignored when `ACTIVE` is not
   * accepted.
   */
  readonly absentStatusIsActive?: boolean;
  /**
   * Ask DynamoDB for the item as it was when the condition failed
   * (`ReturnValuesOnConditionCheckFailure: ALL_OLD`) and carry it on the
   * {@link StaleTransitionError} as `current` (`undefined` when there was
   * no item), so the service classifies the failure from the state that
   * actually failed it, never from a second read (spec R-14).
   */
  readonly returnCurrentOnFailure?: boolean;
}

/** A paginated query against a GSI partition. */
export interface GsiQuery {
  /** The index to query (see `GSI1_INDEX_NAME` / `GSI2_INDEX_NAME` / `GSI3_INDEX_NAME`). */
  readonly indexName: string;
  /** The index partition key attribute name and value to match. */
  readonly partitionKey: { readonly name: string; readonly value: string };
  /**
   * Optional `begins_with` on the index sort key, for partitions shared by
   * two item types (GSI-3's `APPLICATION#<id>` holds cells and deployments).
   * The sort key attribute is the index name with `SK` in place of `PK`.
   */
  readonly sortKeyPrefix?: string;
}

/**
 * A paginated query against one base-table partition, selecting items by
 * sort-key prefix — a tenant's deployments (`PK = TENANT#<id>`,
 * `SK begins_with DEPLOYMENT#`), spec §4.7.
 */
export interface PartitionQuery {
  readonly partitionKey: string;
  readonly sortKeyPrefix: string;
  /**
   * Ask DynamoDB for a strongly consistent read. The hook queries set it:
   * hook resolution at accept time reads the global hooks this way (spec
   * 4.7, R-40), so a hook put a moment ago is seen.
   */
  readonly consistentRead?: boolean;
}

/** One page of a paginated read. */
export interface Page<TSchema> {
  readonly items: TSchema[];
  /** Opaque token for the next page; absent on the last page. */
  readonly nextToken?: string;
}

/** Thrown when a conditional write fails (state conflict or duplicate). */
export class ConditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionFailedError';
  }
}

/**
 * A compare-and-set lifecycle transition found the record in a different
 * status than expected (or missing). The record was concurrently mutated —
 * the service maps this to a 409 `ConflictError` (§7). When the transition
 * asked for it (`returnCurrentOnFailure`), `current` is the record as it
 * was when the condition failed, `undefined` when it no longer existed.
 */
export class StaleTransitionError extends ConditionFailedError {
  constructor(
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
    this.name = 'StaleTransitionError';
  }
}

/**
 * An existence-guarded write (`attribute_exists(PK)`, ADR-011) found no
 * record — the write lost a race with a concurrent delete. The service maps
 * this to a 404 `ResourceNotFoundError`, not an unmodelled 500 (§7).
 */
export class RecordGoneError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'RecordGoneError';
  }
}

/**
 * A placement claim lost the race for a cell slot: the transaction was
 * cancelled and the cancellation reasons identify the cell status/capacity
 * condition as the (only) failed check. Safe to retry against the next
 * candidate cell (§6 step 2).
 */
export class PlacementRaceLostError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementRaceLostError';
  }
}

/**
 * Thrown by the new-cell placement transaction when the account's cell-slot
 * condition (`cellCount < maxCells`, the FIRST transact item) is the only
 * failed check (ADR-024): the account is full (or was deregistered
 * meanwhile), and the caller may try the next eligible account.
 */
export class AccountFullError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'AccountFullError';
  }
}

/**
 * A placement transaction was cancelled because the idempotency item's
 * `attribute_not_exists(PK)` condition failed: the caller's `clientToken`
 * was already used by an earlier CreateDeployment (ADR-017). The service
 * replays the original outcome instead of creating a duplicate.
 */
export class DuplicateTokenError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateTokenError';
  }
}

/**
 * A placement transaction was cancelled because the deployment `Put`'s
 * `attribute_not_exists(PK)` condition failed: the tenant already has a
 * deployment of this application (ADR-037). The service maps it to the 409.
 */
export class DeploymentExistsError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentExistsError';
  }
}

/**
 * A placement transaction was cancelled because the tenant's
 * `deploymentCount` claim found no tenant record: the tenant was deleted
 * between the step-0 read and the transaction. The service maps it to the
 * 404.
 */
export class TenantGoneError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'TenantGoneError';
  }
}

/**
 * A new-cell placement transaction was cancelled because the application's
 * `cellCount` claim found no application record: the application was
 * deleted between the step-0 read and the transaction. The service maps it
 * to the 404.
 */
export class ApplicationGoneError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationGoneError';
  }
}

/**
 * A placement transaction was cancelled because the tenant's
 * `deploymentCount` claim found the tenant not live (R-13, R-47):
 * `CREATING`, `CREATE_FAILED`, `DELETING` or `DELETE_FAILED`, read from the
 * item the failed condition returned (`ALL_OLD`, R-14). The service maps it
 * to a 409.
 */
export class TenantNotLiveError extends ConditionFailedError {
  constructor(readonly status: LifecycleStatus) {
    super(`The tenant is ${status}, not live`);
    this.name = 'TenantNotLiveError';
  }
}

/**
 * A new-cell placement transaction was cancelled because the application's
 * `cellCount` claim found the application not live (R-13, R-47), read from
 * `ALL_OLD`. The service maps it to a 409.
 */
export class ApplicationNotLiveError extends ConditionFailedError {
  constructor(readonly status: LifecycleStatus) {
    super(`The application is ${status}, not live`);
    this.name = 'ApplicationNotLiveError';
  }
}

/**
 * A new-cell placement transaction was cancelled because the account's
 * cell-slot claim, the only failed check, found the account not live (R-13,
 * R-47) or gone (`status` undefined), read from `ALL_OLD`; a live account
 * that failed the claim is {@link AccountFullError}. Untargeted placement
 * moves to the next account; a targeted one answers a 409 `ConflictError`,
 * never `InsufficientCapacityError` (§7.1).
 */
export class AccountNotLiveError extends ConditionFailedError {
  constructor(readonly status: LifecycleStatus | undefined) {
    super(status === undefined ? 'The account no longer exists' : `The account is ${status}, not live`);
    this.name = 'AccountNotLiveError';
  }
}

/**
 * A placement transaction failed for any reason other than a classified
 * cancellation or a cancellation by races alone ({@link TransactionRaceError}).
 * The outcome is ambiguous — the request must fail; the same deployment must
 * NEVER be retargeted at another cell (§7 step 2).
 */
export class AmbiguousTransactionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousTransactionError';
  }
}

/** Encodes a DynamoDB `LastEvaluatedKey` as an opaque pagination token. */
export function encodePageToken(lastEvaluatedKey: Record<string, unknown> | undefined): string | undefined {
  if (lastEvaluatedKey === undefined) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque pagination token back to a DynamoDB `ExclusiveStartKey`.
 * A token the caller supplied that does not decode to a JSON object throws
 * the MODELLED `ValidationException` (on every list operation's errors
 * list), so the SSDK renders a 400 — a garbage token is a client error,
 * never a 500.
 */
export function decodePageToken(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalidPageTokenError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidPageTokenError();
  }
  return parsed as Record<string, unknown>;
}

/** The modelled 400 for an undecodable or structurally invalid pagination token. */
function invalidPageTokenError(): ValidationException {
  return new ValidationException({
    message: 'Invalid nextToken: supply a token returned by a previous page, or omit it',
  });
}

/**
 * Maps DynamoDB's own `ValidationException` — the only caller-influenced
 * trigger on these static queries is a parseable-but-invalid
 * `ExclusiveStartKey` — to the modelled 400 instead of an unmodelled 500.
 */
function throwIfInvalidStartKey(error: unknown): void {
  if (error instanceof Error && error.name === 'ValidationException') {
    throw invalidPageTokenError();
  }
}

/** Creates the default document client shared by the repository classes. */
export function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Per-transaction-item cancellation codes, when the error carries them. */
export function cancellationCodes(error: unknown): string[] | undefined {
  if (error instanceof Error && error.name === 'TransactionCanceledException') {
    const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    return reasons?.map((reason) => reason?.Code ?? 'None');
  }
  return undefined;
}

/**
 * The cancellation codes of a member that lost a race and failed no check:
 * another transaction held the item, or the table refused the write for
 * capacity. A cancellation applies nothing, so these say nothing about the
 * outcome but "not yet" (ADR-0050).
 */
const RACE_CODES: ReadonlySet<string> = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

/**
 * Whether a cancelled `TransactWriteItems` was cancelled only by races: at
 * least one member carries a race code and every other member `None`. Such
 * a transaction applied nothing and failed no condition, so it is safe to
 * send again; it is never an ambiguous outcome (ADR-0050).
 */
export function isRaceCancellation(codes: string[] | undefined): boolean {
  return (
    codes !== undefined &&
    codes.some((code) => RACE_CODES.has(code)) &&
    codes.every((code) => code === 'None' || RACE_CODES.has(code))
  );
}

/**
 * A `TransactWriteItems` was cancelled only by races on every one of its
 * {@link RACE_RETRY_ATTEMPTS} attempts. Nothing was written, so the caller
 * may retry the whole request: the service maps it to a 409 with the retry
 * hint, never a 500 (ADR-0050).
 */
export class TransactionRaceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransactionRaceError';
  }
}

/**
 * Attempts of one transaction against a race-only cancellation (ADR-0050).
 * With full jitter doubling from {@link RACE_RETRY_BASE_MS} the waits add up
 * to at most 50 + 100 + 200 ms, far inside the API's 29 s window.
 */
export const RACE_RETRY_ATTEMPTS = 4;
const RACE_RETRY_BASE_MS = 50;

/** DynamoDB's `ClientRequestToken` limit, and the longest suffix {@link attemptToken} adds. */
const MAX_CLIENT_REQUEST_TOKEN = 36;
const RACE_TOKEN_SUFFIX_MAX = `-r${RACE_RETRY_ATTEMPTS - 1}`.length;

/**
 * The `ClientRequestToken` of attempt `attempt`: the caller's token first,
 * then a suffixed one. A race-only cancellation is a definite answer that
 * applied nothing, so a new token on the next attempt cannot apply the
 * transaction twice, and it never meets a recorded outcome of the cancelled
 * attempt (ADR-0050). The suffix keeps a 26-character ULID within the
 * 36-character limit. A token too long for the suffix is refused before the
 * first attempt, so it can never fail on a later one after a definite
 * cancellation. That refusal is a programming-error path: every caller
 * passes a 26-character ULID. The caller's error handling reads it as
 * ambiguous and answers 500, although nothing was sent.
 */
export function attemptToken(token: string, attempt: number): string {
  if (token.length > MAX_CLIENT_REQUEST_TOKEN - RACE_TOKEN_SUFFIX_MAX) {
    throw new Error(
      `ClientRequestToken of ${token.length} characters leaves no room for the race-retry suffix (at most ${
        MAX_CLIENT_REQUEST_TOKEN - RACE_TOKEN_SUFFIX_MAX
      })`,
    );
  }
  return attempt === 0 ? token : `${token}-r${attempt}`;
}

/**
 * Sends a `TransactWriteItems` built for each attempt, and sends it again
 * after a short full-jitter wait while it is cancelled only by races
 * ({@link isRaceCancellation}). Gives up with {@link TransactionRaceError}
 * after {@link RACE_RETRY_ATTEMPTS} attempts. Any other error is rethrown
 * as it is, for the caller to classify.
 */
export async function sendTransactionWithRaceRetry(
  client: DynamoDBDocumentClient,
  what: string,
  command: (attempt: number) => TransactWriteCommand,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.send(command(attempt));
      return;
    } catch (error) {
      const codes = cancellationCodes(error);
      if (!isRaceCancellation(codes)) {
        throw error;
      }
      const exhausted = attempt + 1 >= RACE_RETRY_ATTEMPTS;
      // One line per race, so how often placements meet (the ADR-0050 revisit
      // trigger) shows in the logs before any request answers the 409.
      console.warn(
        `${what}: cancelled only by races on attempt ${attempt + 1} of ${RACE_RETRY_ATTEMPTS} ` +
          `(reasons ${codes?.join(',')}); ${exhausted ? 'attempts spent' : 'sending again'}`,
      );
      if (exhausted) {
        throw new TransactionRaceError(
          `${what} was cancelled by concurrent writes on ${RACE_RETRY_ATTEMPTS} attempts; nothing was written`,
          error,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * RACE_RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

/**
 * The optional CreateDeployment idempotency transact item (ADR-017): a `Put`
 * conditional on `attribute_not_exists(PK)`, always appended LAST so its
 * cancellation code has a fixed position for classification.
 */
function idempotencyPut(tableName: string, item: DynamoDBItem | undefined) {
  return item === undefined
    ? []
    : [
      {
        Put: {
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
}

/**
 * Throws {@link DuplicateTokenError} when a placement transaction was
 * cancelled and the idempotency item's condition (the LAST transact item,
 * only present when the caller supplied a `clientToken`) is among the failed
 * checks (ADR-017).
 */
function throwIfDuplicateToken(codes: string[] | undefined, item: DynamoDBItem | undefined): void {
  if (
    item !== undefined &&
    codes !== undefined &&
    codes[codes.length - 1] === 'ConditionalCheckFailed'
  ) {
    throw new DuplicateTokenError('clientToken was already used by an earlier CreateDeployment');
  }
}

/**
 * Classifies a cancelled placement transaction by the POSITION of its failed
 * conditions (spec §7.1). Precedence: a failed deployment insert (the tenant
 * already has this application) wins over a missing tenant, which wins over
 * a missing application, which wins over the capacity claim at index 0 —
 * the capacity claim is a lost race (or a full account) ONLY when it is the
 * sole failed check. Anything else is ambiguous.
 */
function classifyPlacementCancellation(
  error: unknown,
  codes: string[],
  indexes: {
    readonly deployment: number;
    readonly tenant: number;
    readonly application?: number;
  },
  capacityFailure: () => ConditionFailedError,
): ConditionFailedError | undefined {
  const failed = (index: number | undefined) =>
    index !== undefined && codes[index] === 'ConditionalCheckFailed';
  if (failed(indexes.deployment)) {
    return new DeploymentExistsError('The tenant already has a deployment of this application');
  }
  if (failed(indexes.tenant)) {
    // ALL_OLD (R-14): no item is a deleted tenant; an item failed the live check.
    const tenant = cancellationItem(error, indexes.tenant);
    return tenant === undefined
      ? new TenantGoneError('The tenant no longer exists')
      : new TenantNotLiveError(cancelledStatus(tenant));
  }
  if (indexes.application !== undefined && failed(indexes.application)) {
    const application = cancellationItem(error, indexes.application);
    return application === undefined
      ? new ApplicationGoneError('The application no longer exists')
      : new ApplicationNotLiveError(cancelledStatus(application));
  }
  if (
    codes[0] === 'ConditionalCheckFailed' &&
    codes.slice(1).every((code) => code !== 'ConditionalCheckFailed')
  ) {
    return capacityFailure();
  }
  return undefined;
}

/**
 * The item a cancelled transaction returned for the member at `index`
 * (`ReturnValuesOnConditionCheckFailure: ALL_OLD`), unmarshalled; the
 * document client leaves it in the low-level attribute-value form.
 * `undefined` when the member's item did not exist.
 */
function cancellationItem(error: unknown, index: number): Record<string, unknown> | undefined {
  const reasons = (error as { CancellationReasons?: { Item?: Parameters<typeof unmarshall>[0] }[] })
    .CancellationReasons;
  const item = reasons?.[index]?.Item;
  return item === undefined ? undefined : unmarshall(item);
}

/** The stored status of a cancelled member's `ALL_OLD` item; an absent attribute reads as `ACTIVE` (R-47). */
function cancelledStatus(item: Record<string, unknown>): LifecycleStatus {
  return readRecordStatus(item.status as LifecycleStatus | undefined);
}

/**
 * The live-status condition of a placement claim (R-13, R-47): `ACTIVE`,
 * `UPDATING` or `UPDATE_FAILED`, an absent status read as `ACTIVE`. Placed
 * on the tenant, account and application members, so nothing counts toward
 * a record that left a live status after the step-0 read.
 */
const LIVE_CONDITION = `(attribute_not_exists(#status) OR #status IN (${LIVE_STATUSES.map((_, i) => `:live${i}`).join(', ')}))`;
const LIVE_VALUES: Record<string, LifecycleStatus> = Object.fromEntries(
  LIVE_STATUSES.map((status, i) => [`:live${i}`, status]),
);

/** The tenant `deploymentCount` claim, shared by both placement transactions (P-6), conditioned on a live tenant (R-13). */
function tenantClaimUpdate(tableName: string, tenantKey: ItemKey, updatedAt: string) {
  return {
    Update: {
      TableName: tableName,
      Key: tenantKey,
      UpdateExpression: 'SET #deploymentCount = #deploymentCount + :one, #updatedAt = :updatedAt',
      ConditionExpression: `attribute_exists(PK) AND ${LIVE_CONDITION}`,
      ExpressionAttributeNames: {
        '#deploymentCount': 'deploymentCount',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':updatedAt': updatedAt,
        ...LIVE_VALUES,
      },
      // R-14: tells a deleted tenant (no item, 404) from one not live (409).
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
    },
  };
}

/**
 * Generic single-table CRUD repository. Uses a {@link DataModel} for all
 * conversions between domain schemas and DynamoDB items. Carries no caller
 * context — identifiers arrive through the data model at call time.
 */
export class DynamoDBRepository<TSchema, TItem extends DynamoDBItem> {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly dataModel: DataModel<TSchema, TItem>,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? defaultDocumentClient();
  }

  /**
   * Reads one item; `undefined` when it does not exist. `consistentRead`
   * asks for a strongly consistent read (the hook paths use it, R-39).
   */
  async get(key: ItemKey, options?: { readonly consistentRead?: boolean }): Promise<TSchema | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ...(options?.consistentRead === true ? { ConsistentRead: true } : {}),
      }),
    );
    return result.Item === undefined ? undefined : this.dataModel.fromItem(result.Item as TItem);
  }

  /**
   * Writes one item, optionally guarded by a condition. Conditional failures
   * (duplicate create, invalid state transition) surface as
   * {@link ConditionFailedError} for the service layer to map to a 409.
   */
  async put(schema: TSchema, condition?: WriteCondition): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.dataModel.toItem(schema),
          ConditionExpression: condition?.conditionExpression,
          ExpressionAttributeNames: condition?.expressionAttributeNames,
          ExpressionAttributeValues: condition?.expressionAttributeValues as
            | Record<string, never>
            | undefined,
        }),
      );
    } catch (error) {
      this.throwIfConditionFailed(error, () => new ConditionFailedError('Conditional write failed'));
      throw error;
    }
  }

  /**
   * Atomically updates owned fields and returns the complete post-update
   * item. With `returnCurrentOnFailure` a failed condition throws a
   * {@link StaleTransitionError} carrying the item as it was (`ALL_OLD`,
   * `undefined` when there was none), so the service classifies the failure
   * from the state that failed it (R-14); otherwise a plain
   * {@link ConditionFailedError}.
   */
  async update(
    key: ItemKey,
    update: ItemUpdate,
    options?: { readonly returnCurrentOnFailure?: boolean },
  ): Promise<TSchema> {
    const returnCurrent = options?.returnCurrentOnFailure === true;
    return this.sendUpdate(
      key,
      update,
      (current) =>
        returnCurrent
          ? new StaleTransitionError('Conditional update failed', current)
          : new ConditionFailedError('Conditional update failed'),
      returnCurrent,
    );
  }

  /**
   * Field-ownership metadata/failure write (ADR-011): updates only the
   * caller-owned fields, guarded by `attribute_exists(PK)` so the write can
   * never recreate a concurrently deleted record as a ghost. Condition
   * failure means the record is gone — thrown as {@link RecordGoneError}
   * for the service to map to a 404 (§7).
   */
  async updateExisting(key: ItemKey, update: ItemUpdate): Promise<TSchema> {
    const guarded: ItemUpdate = {
      ...update,
      conditionExpression:
        update.conditionExpression === undefined
          ? 'attribute_exists(PK)'
          : `attribute_exists(PK) AND (${update.conditionExpression})`,
    };
    return this.sendUpdate(
      key,
      guarded,
      () => new RecordGoneError('Record no longer exists — lost to a concurrent delete'),
    );
  }

  /**
   * Compare-and-set lifecycle transition (§5/§7): one conditional
   * `UpdateItem` whose condition checks the exact expected status (or the
   * accepted status set) — plus any extra condition, e.g. the DeleteCell
   * `tenantCount = 0` emptiness guard. Condition failure is thrown as
   * {@link StaleTransitionError} for the service to map to a 409.
   */
  async transitionStatus(key: ItemKey, transition: StatusTransition): Promise<TSchema> {
    const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = {
      ':to': transition.to,
      ':updatedAt': transition.updatedAt,
    };

    const setParts = ['#status = :to', '#updatedAt = :updatedAt'];
    for (const [field, value] of Object.entries(transition.setFields ?? {})) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      setParts.push(`#${field} = :${field}`);
    }

    let updateExpression = `SET ${setParts.join(', ')}`;
    if (transition.removeFields !== undefined && transition.removeFields.length > 0) {
      for (const field of transition.removeFields) {
        names[`#${field}`] = field;
      }
      updateExpression += ` REMOVE ${transition.removeFields.map((f) => `#${f}`).join(', ')}`;
    }

    const fromPlaceholders = transition.fromAnyOf.map((status, index) => {
      values[`:from${index}`] = status;
      return `:from${index}`;
    });
    let conditionExpression = `#status IN (${fromPlaceholders.join(', ')})`;
    if (transition.absentStatusIsActive === true && transition.fromAnyOf.includes(LifecycleStatus.ACTIVE)) {
      conditionExpression = `(attribute_not_exists(#status) OR ${conditionExpression})`;
    }
    if (transition.extraCondition !== undefined) {
      conditionExpression += ` AND (${transition.extraCondition.conditionExpression})`;
      Object.assign(names, transition.extraCondition.expressionAttributeNames);
      Object.assign(values, transition.extraCondition.expressionAttributeValues);
    }

    return this.sendUpdate(
      key,
      {
        updateExpression,
        conditionExpression,
        expressionAttributeNames: names,
        expressionAttributeValues: values,
      },
      (current) =>
        new StaleTransitionError(
          `Status transition to ${transition.to} failed — record missing or not in ${transition.fromAnyOf.join('/')}`,
          current,
        ),
      transition.returnCurrentOnFailure === true,
    );
  }

  /** Deletes one item, optionally guarded by a condition. */
  async delete(key: ItemKey, condition?: WriteCondition): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: key,
          ConditionExpression: condition?.conditionExpression,
          ExpressionAttributeNames: condition?.expressionAttributeNames,
          ExpressionAttributeValues: condition?.expressionAttributeValues as
            | Record<string, never>
            | undefined,
        }),
      );
    } catch (error) {
      this.throwIfConditionFailed(error, () => new ConditionFailedError('Conditional delete failed'));
      throw error;
    }
  }

  /**
   * Reads one page of a GSI partition (spec §4.7). Every list operation and
   * both placement candidate scans are partition-pinned index queries; ULID
   * sort keys give creation order. The GSIs are eventually consistent and
   * never authoritative — every claim is a conditional write on the base
   * table (P-5).
   */
  async queryIndex(query: GsiQuery, maxResults?: number, nextToken?: string): Promise<Page<TSchema>> {
    const names: Record<string, string> = { '#pk': query.partitionKey.name };
    const values: Record<string, unknown> = { ':pk': query.partitionKey.value };
    let keyCondition = '#pk = :pk';
    if (query.sortKeyPrefix !== undefined) {
      names['#sk'] = query.partitionKey.name.replace(/PK$/, 'SK');
      values[':skPrefix'] = query.sortKeyPrefix;
      keyCondition += ' AND begins_with(#sk, :skPrefix)';
    }
    return this.queryPage(
      {
        IndexName: query.indexName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
      maxResults,
      nextToken,
    );
  }

  /**
   * Reads one page of a base-table partition by sort-key prefix (spec §4.7):
   * a tenant's deployments live under the tenant's own partition, so
   * `ListDeployments?tenantId=` needs no index. Strongly consistent, like
   * every base-table read.
   */
  async queryPartition(
    query: PartitionQuery,
    maxResults?: number,
    nextToken?: string,
  ): Promise<Page<TSchema>> {
    return this.queryPage(
      {
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': query.partitionKey, ':skPrefix': query.sortKeyPrefix },
        ...(query.consistentRead === true ? { ConsistentRead: true } : {}),
      },
      maxResults,
      nextToken,
    );
  }

  private async queryPage(
    query: {
      readonly IndexName?: string;
      readonly ConsistentRead?: boolean;
      readonly KeyConditionExpression: string;
      readonly ExpressionAttributeNames: Record<string, string>;
      readonly ExpressionAttributeValues: Record<string, unknown>;
    },
    maxResults?: number,
    nextToken?: string,
  ): Promise<Page<TSchema>> {
    let result;
    try {
      result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          ...query,
          Limit: maxResults,
          ExclusiveStartKey: decodePageToken(nextToken) as Record<string, never> | undefined,
        }),
      );
    } catch (error) {
      throwIfInvalidStartKey(error);
      throw error;
    }
    return {
      items: (result.Items ?? []).map((item) => this.dataModel.fromItem(item as TItem)),
      nextToken: encodePageToken(result.LastEvaluatedKey),
    };
  }

  private async sendUpdate(
    key: ItemKey,
    update: ItemUpdate,
    onConditionFailed: (current?: TSchema) => ConditionFailedError,
    returnCurrentOnFailure = false,
  ): Promise<TSchema> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: update.updateExpression,
          ConditionExpression: update.conditionExpression,
          ExpressionAttributeNames: update.expressionAttributeNames,
          ExpressionAttributeValues: update.expressionAttributeValues as Record<string, never>,
          ReturnValues: 'ALL_NEW',
          ...(returnCurrentOnFailure ? { ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const } : {}),
        }),
      );
      if (result.Attributes === undefined) {
        throw new Error('DynamoDB update returned no attributes');
      }
      return this.dataModel.fromItem(result.Attributes as TItem);
    } catch (error) {
      // The document client does not unmarshall the item a failed condition
      // returns; it arrives in the low-level attribute-value form.
      const failedItem = (error as { Item?: Parameters<typeof unmarshall>[0] } | undefined)?.Item;
      this.throwIfConditionFailed(error, () =>
        onConditionFailed(
          failedItem === undefined ? undefined : this.dataModel.fromItem(unmarshall(failedItem) as TItem),
        ),
      );
      throw error;
    }
  }

  private throwIfConditionFailed(error: unknown, create: () => ConditionFailedError): void {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw create();
    }
  }
}

/**
 * The placement/compensation `TransactWriteItems` shapes (spec §7, ADR-013,
 * ADR-024, ADR-032, ADR-037). This class owns the service-side transaction
 * shapes; the workflow-side terminal writes (deployment delete + slot and
 * count release, cell delete + slot and count release) run inside Step
 * Functions against the same shape contract and are implemented in the
 * workflow definition, not here.
 *
 * @typeParam TCellSchema / TCellItem — the cell record and its item shape
 * @typeParam TDeploymentSchema / TDeploymentItem — the deployment record and its item shape
 */
export class PlacementTransactions<
  TCellSchema,
  TCellItem extends DynamoDBItem,
  TDeploymentSchema,
  TDeploymentItem extends DynamoDBItem,
> {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly cellDataModel: DataModel<TCellSchema, TCellItem>,
    private readonly deploymentDataModel: DataModel<TDeploymentSchema, TDeploymentItem>,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? defaultDocumentClient();
  }

  /**
   * §7 step 2 — claim a slot in an existing `ACTIVE` cell of the application
   * and persist the deployment, atomically:
   *
   * - `Update` cell: `SET tenantCount = tenantCount + 1`, condition
   *   `status = ACTIVE AND tenantCount < maxTenants` — the FIRST item
   * - `Update` tenant: `SET deploymentCount = deploymentCount + 1`,
   *   condition `attribute_exists(PK)` (a deleted tenant is the 404)
   * - `Put` deployment (status `CREATING`, `cellId` set), condition
   *   `attribute_not_exists(PK)` — one deployment per tenant per
   *   application; a second is the 409
   *
   * The stable `clientRequestToken` gives short-window replay protection for
   * identical automatic retries. When the caller supplied a `clientToken`,
   * the idempotency item joins the transaction LAST, conditional on
   * `attribute_not_exists(PK)` (ADR-017) — a failed idempotency condition
   * throws {@link DuplicateTokenError} and wins over every other
   * classification. Throws {@link PlacementRaceLostError} ONLY when the
   * cell's status/capacity check is the sole failed condition (safe to try
   * the next candidate); {@link DeploymentExistsError} and
   * {@link TenantGoneError} by position. A cancellation by races alone is
   * sent again on the same candidate and, once the attempts are spent, is a
   * {@link TransactionRaceError} (ADR-0050). Every other failure is an
   * {@link AmbiguousTransactionError} — never retarget the same deployment
   * after an ambiguous outcome.
   */
  async placeDeploymentInCell(params: {
    /** Base-table key of the candidate cell. */
    readonly cellKey: ItemKey;
    /** Base-table key of the tenant whose count is claimed. */
    readonly tenantKey: ItemKey;
    /** The fully-formed deployment record (status CREATING, cellId = candidate). */
    readonly deployment: TDeploymentSchema;
    /** ISO-8601 timestamp stamped onto the cell's and tenant's `updatedAt`. */
    readonly updatedAt: string;
    /** Stable idempotency token — same value on identical retries. */
    readonly clientRequestToken: string;
    /** CreateDeployment idempotency item (ADR-017); absent when no clientToken. */
    readonly idempotencyItem?: DynamoDBItem;
  }): Promise<void> {
    try {
      await sendTransactionWithRaceRetry(this.client, 'Placement transaction', (attempt) =>
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: params.cellKey,
                UpdateExpression:
                  'SET #tenantCount = #tenantCount + :one, #updatedAt = :updatedAt',
                ConditionExpression: '#status = :active AND #tenantCount < #maxTenants',
                ExpressionAttributeNames: {
                  '#tenantCount': 'tenantCount',
                  '#maxTenants': 'maxTenants',
                  '#status': 'status',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':active': LifecycleStatus.ACTIVE,
                  ':updatedAt': params.updatedAt,
                },
              },
            },
            tenantClaimUpdate(this.tableName, params.tenantKey, params.updatedAt),
            {
              Put: {
                TableName: this.tableName,
                Item: this.deploymentDataModel.toItem(params.deployment),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...idempotencyPut(this.tableName, params.idempotencyItem),
          ],
          ClientRequestToken: attemptToken(params.clientRequestToken, attempt),
        }),
      );
    } catch (error) {
      if (error instanceof TransactionRaceError) {
        throw error;
      }
      const codes = cancellationCodes(error);
      throwIfDuplicateToken(codes, params.idempotencyItem);
      const classified =
        codes === undefined
          ? undefined
          : classifyPlacementCancellation(
            error,
            codes,
            { tenant: 1, deployment: 2 },
            () => new PlacementRaceLostError('Lost the placement race for the candidate cell'),
          );
      if (classified !== undefined) {
        throw classified;
      }
      throw new AmbiguousTransactionError('Placement transaction failed ambiguously', error);
    }
  }

  /**
   * §7 step 3 — no candidate claimed: claim a cell slot on the hosting
   * account, count the cell on the application, create the new cell record
   * (status `CREATING`, `tenantCount = 1` pre-claimed, `accountId` and
   * `applicationId` set, definition stamped), count the deployment on the
   * tenant and create the deployment, atomically (ADR-013, ADR-024,
   * ADR-032, ADR-037):
   *
   * - `Update` account: `SET cellCount = cellCount + 1`, condition
   *   `attribute_exists(PK) AND cellCount < maxCells` — the FIRST item
   * - `Update` application: `SET cellCount = cellCount + 1`, condition
   *   `attribute_exists(PK)` (no limit; a deleted application is the 404)
   * - `Put` cell, condition `attribute_not_exists(PK)`
   * - `Update` tenant: `SET deploymentCount = deploymentCount + 1`,
   *   condition `attribute_exists(PK)`
   * - `Put` deployment, condition `attribute_not_exists(PK)`
   *
   * Fresh ULIDs make a cell `Put` collision negligible, but no write in this
   * design is unconditional. The idempotency item joins LAST when supplied
   * (ADR-017). A failed account condition alone throws
   * {@link AccountFullError} (try the next eligible account);
   * {@link DeploymentExistsError}, {@link TenantGoneError} and
   * {@link ApplicationGoneError} by position; a cancellation by races alone
   * is sent again and then is a {@link TransactionRaceError} (ADR-0050);
   * anything else is ambiguous: fail the request, never retarget.
   */
  async createCellWithDeployment(params: {
    /** Base-table key of the account the cell is created in. */
    readonly accountKey: ItemKey;
    /** Base-table key of the application the cell is counted on. */
    readonly applicationKey: ItemKey;
    /** The new cell record — status CREATING, tenantCount 1, stamped definition. */
    readonly cell: TCellSchema;
    /** Base-table key of the tenant whose count is claimed. */
    readonly tenantKey: ItemKey;
    /** The deployment record — status CREATING, cellId = the new cell. */
    readonly deployment: TDeploymentSchema;
    /** ISO-8601 timestamp stamped onto the account's, application's and tenant's `updatedAt`. */
    readonly updatedAt: string;
    /** Stable idempotency token — same value on identical retries. */
    readonly clientRequestToken: string;
    /** CreateDeployment idempotency item (ADR-017); absent when no clientToken. */
    readonly idempotencyItem?: DynamoDBItem;
  }): Promise<void> {
    const countCells = (key: ItemKey, condition: string) => ({
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: 'SET #cellCount = #cellCount + :one, #updatedAt = :updatedAt',
        ConditionExpression: `${condition} AND ${LIVE_CONDITION}`,
        ExpressionAttributeNames: {
          '#cellCount': 'cellCount',
          ...(condition.includes('#maxCells') ? { '#maxCells': 'maxCells' } : {}),
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':updatedAt': params.updatedAt,
          ...LIVE_VALUES,
        },
        // R-14: tells a gone, a not-live and a full record apart.
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
      },
    });
    try {
      await sendTransactionWithRaceRetry(this.client, 'New-cell placement transaction', (attempt) =>
        new TransactWriteCommand({
          TransactItems: [
            countCells(params.accountKey, 'attribute_exists(PK) AND #cellCount < #maxCells'),
            countCells(params.applicationKey, 'attribute_exists(PK)'),
            {
              Put: {
                TableName: this.tableName,
                Item: this.cellDataModel.toItem(params.cell),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            tenantClaimUpdate(this.tableName, params.tenantKey, params.updatedAt),
            {
              Put: {
                TableName: this.tableName,
                Item: this.deploymentDataModel.toItem(params.deployment),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...idempotencyPut(this.tableName, params.idempotencyItem),
          ],
          ClientRequestToken: attemptToken(params.clientRequestToken, attempt),
        }),
      );
    } catch (error) {
      if (error instanceof TransactionRaceError) {
        throw error;
      }
      const codes = cancellationCodes(error);
      throwIfDuplicateToken(codes, params.idempotencyItem);
      const classified =
        codes === undefined
          ? undefined
          : classifyPlacementCancellation(
            error,
            codes,
            { application: 1, tenant: 3, deployment: 4 },
            () => {
              // ALL_OLD (R-14): a live account failed on capacity; one gone
              // or not live failed on its status (§7.1).
              const account = cancellationItem(error, 0);
              if (account === undefined) {
                return new AccountNotLiveError(undefined);
              }
              const status = cancelledStatus(account);
              return LIVE_STATUSES.includes(status)
                ? new AccountFullError('The account has no free cell slot')
                : new AccountNotLiveError(status);
            },
          );
      if (classified !== undefined) {
        throw classified;
      }
      throw new AmbiguousTransactionError('New-cell placement transaction failed', error);
    }
  }

  /**
   * §7.4 compensation for a new-cell placement whose `StartExecution` was
   * rejected: one `TransactWriteItems` moves BOTH the deployment and the
   * cell from `CREATING` to `CREATE_FAILED`, so compensation cannot leave
   * only one record recoverable. Each update is conditional on the exact
   * in-flight status (`status = CREATING`), which is also the existence
   * check. Counters are never touched: the account's cell slot, the
   * application's count and the tenant's count stay held by the
   * `CREATE_FAILED` records until the remediation path releases them.
   * (Compensation for placement into an EXISTING cell is a single deployment
   * transition — use `DynamoDBRepository.transitionStatus`.)
   */
  async failCreatingCellAndDeployment(params: {
    readonly cellKey: ItemKey;
    readonly deploymentKey: ItemKey;
    /** Failure detail written to both records' `statusReason`. */
    readonly statusReason: string;
    /** ISO-8601 timestamp written to both records' `updatedAt`. */
    readonly updatedAt: string;
  }): Promise<void> {
    const compensate = (key: ItemKey) => ({
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression:
          'SET #status = :failed, #statusReason = :reason, #updatedAt = :updatedAt',
        ConditionExpression: '#status = :creating',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#statusReason': 'statusReason',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':failed': LifecycleStatus.CREATE_FAILED,
          ':creating': LifecycleStatus.CREATING,
          ':reason': params.statusReason,
          ':updatedAt': params.updatedAt,
        },
      },
    });
    try {
      // A race-only cancellation is sent again (ADR-0050): the start was
      // refused, so a lost race here would strand both records in CREATING
      // with no execution to move them.
      await sendTransactionWithRaceRetry(this.client, 'Paired compensation transaction', () =>
        new TransactWriteCommand({
          TransactItems: [compensate(params.cellKey), compensate(params.deploymentKey)],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionRaceError) {
        throw error;
      }
      const codes = cancellationCodes(error);
      if (codes !== undefined && codes.some((code) => code === 'ConditionalCheckFailed')) {
        throw new StaleTransitionError(
          'Paired CREATE_FAILED compensation found a record no longer in CREATING',
        );
      }
      throw new AmbiguousTransactionError('Paired compensation transaction failed', error);
    }
  }
}
