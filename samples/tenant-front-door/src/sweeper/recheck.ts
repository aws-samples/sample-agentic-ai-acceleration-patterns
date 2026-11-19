// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The daily re-check of every passed domain challenge (spec §3.4 step 5,
 * ADR-0018, ADR-0020, ADR-0022). A run is one UTC day and its run item is
 * its identity: a retry of the lister, the starter's run and a run by hand
 * on one day are one run, and the day rule makes a repeat change nothing.
 *
 * The lister lists the `tenant#` entries with a passed challenge (`dk`
 * without `dx`), emits the previous day's missing-pages count, deletes the
 * entry items of tenants and domains that are no longer listed, sets
 * today's `pagesStarted` and starts one asynchronous page per 500 tenant
 * ids, each pinned to the lister's UTC date. A page whose date is not
 * today's when it starts is a no-op. Otherwise it re-reads each id's entry
 * with `GetKey`, resolves the challenge record of each passed one, records
 * one outcome per tenant, domain and day with one conditional write, and
 * adds its page number to the run item.
 *
 * The sweeper never drops a domain itself: its alarms tell the operator.
 */

import {
  type CloudFrontKeyValueStoreClient,
  GetKeyCommand,
  ListKeysCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { emitCount, errorName, logLine } from './log';
import {
  SWEEPER_ATTR as A,
  SWEEPER_JOB,
  SWEEPER_LOG,
  SWEEPER_METRICS,
  SWEEPER_PAGE_SIZE,
  SWEEPER_RUN_TTL_SECONDS,
  SWEEPER_TABLE as T,
  type SweeperPageEvent,
} from '../shared/contracts';
import type { ChallengeOutcome } from '../shared/dns-challenge';
import { decodeTenantEntry, type TenantEntry, tenantKey, toStoredId } from '../shared/route-table';

/** Entries a page reads, and checks, at a time. */
export const PAGE_CONCURRENCY = 10;

/** Each of a page's DynamoDB and `GetKey` calls is made once, with this limit (a chosen value: the page logs how long its reads took). */
export const CALL_LIMIT_MS = 2_000;

/** A streak that reaches this logs its line and counts to its alarm's metric. */
export const ALARM_STREAK = 3;

/** `BatchWriteItem` takes at most 25 requests. */
const BATCH_WRITE_MAX = 25;

/** Rounds of `UnprocessedItems` the lister resends before it fails. */
const BATCH_WRITE_ROUNDS = 5;

/** `ListKeys` returns at most 50 keys a call. */
const LIST_KEYS_MAX = 50;

const TENANT_PREFIX = 'tenant#';
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Outcome = 'pass' | 'miss' | 'error';

export interface RecheckDeps {
  /** The lister's `ListKeys`. */
  readonly kvs: Pick<CloudFrontKeyValueStoreClient, 'send'>;
  /** A page's `GetKey` reads: a client that makes each call once. */
  readonly kvsOnce: Pick<CloudFrontKeyValueStoreClient, 'send'>;
  /** A client that makes each call once; every call here also carries the 2 s limit. */
  readonly ddb: Pick<DynamoDBDocumentClient, 'send'>;
  readonly lambda: Pick<LambdaClient, 'send'>;
  readonly routeTableArn: string;
  /** The `DistributionId` dimension of the re-check's counts. */
  readonly distributionId: string;
  readonly tableName: string;
  /** This function, which the lister invokes once per page. */
  readonly functionName: string;
  readonly now: () => number;
  /** The challenge lookup (`checkChallenge`). */
  readonly challenge: (domain: string, token: string) => Promise<ChallengeOutcome>;
}

/** `YYYY-MM-DD` of `ms` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
}

/** An entry item's `sk`. */
export function entrySk(tenantId: string, domain: string): string {
  return `${tenantId}#${domain}`;
}

function limit(): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(CALL_LIMIT_MS) };
}

function expiresAt(now: number): number {
  return Math.floor(now / 1000) + SWEEPER_RUN_TTL_SECONDS;
}

/** A passed challenge: `d` and `dk` without `dx` (§4.1). */
function isPassed(entry: TenantEntry): entry is TenantEntry & { d: string; dk: string } {
  return entry.d !== undefined && entry.dk !== undefined && entry.dx === undefined;
}

/** Runs `fn` over `items`, at most `concurrency` at once; the first failure fails the whole and starts nothing more. */
export async function mapLimit<I, O>(items: readonly I[], concurrency: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Lister
// ---------------------------------------------------------------------------

export interface ListerResult {
  readonly runDay: string;
  readonly entries: number;
  readonly pages: number;
  readonly missingPages: number;
  readonly deletedItems: number;
}

export async function runLister(deps: RecheckDeps): Promise<ListerResult> {
  const now = deps.now();
  const runDay = utcDay(now);

  // (1) The entries with a passed challenge.
  const entries = await listPassedEntries(deps);

  // (2) The previous day's missing pages.
  const missingPages = await countMissingPages(deps, dayBefore(runDay));
  emitCount(SWEEPER_METRICS.missingPages, missingPages, deps.distributionId, now);

  // (3) The items of tenants and domains no longer listed.
  const current = new Set(entries.map((e) => entrySk(e.tenantId, e.domain)));
  const deletedItems = await deleteStaleEntryItems(deps, current);

  // (4) Today's pages, zero included.
  const pages: string[][] = [];
  for (let i = 0; i < entries.length; i += SWEEPER_PAGE_SIZE) {
    pages.push(entries.slice(i, i + SWEEPER_PAGE_SIZE).map((e) => e.tenantId));
  }
  await deps.ddb.send(new UpdateCommand({
    TableName: deps.tableName,
    Key: { [T.partitionKey]: T.runPk, [T.sortKey]: runDay },
    UpdateExpression: 'SET #started = :started, #expires = :expires',
    ExpressionAttributeNames: { '#started': A.pagesStarted, '#expires': A.expiresAt },
    ExpressionAttributeValues: { ':started': pages.length, ':expires': expiresAt(now) },
  }), limit());

  // (5) One asynchronous run per page.
  for (let i = 0; i < pages.length; i++) {
    const event: SweeperPageEvent = { job: SWEEPER_JOB.page, runDay, page: i + 1, tenantIds: pages[i] };
    await deps.lambda.send(new InvokeCommand({
      FunctionName: deps.functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(event)),
    }));
  }

  const result = { runDay, entries: entries.length, pages: pages.length, missingPages, deletedItems };
  logLine('INFO', 'lister', { ...result });
  return result;
}

interface PassedEntry {
  readonly tenantId: string;
  readonly domain: string;
}

async function listPassedEntries(deps: RecheckDeps): Promise<PassedEntry[]> {
  const out: PassedEntry[] = [];
  let nextToken: string | undefined;
  do {
    const page = await deps.kvs.send(new ListKeysCommand({ KvsARN: deps.routeTableArn, MaxResults: LIST_KEYS_MAX, NextToken: nextToken }));
    for (const item of page.Items ?? []) {
      if (item.Key === undefined || !item.Key.startsWith(TENANT_PREFIX) || item.Value === undefined) continue;
      let entry: TenantEntry;
      try {
        entry = decodeTenantEntry(item.Value);
      } catch {
        logLine('WARN', 'tenant entry unreadable', { key: item.Key });
        continue;
      }
      if (isPassed(entry)) out.push({ tenantId: item.Key.slice(TENANT_PREFIX.length), domain: entry.d });
    }
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  return out;
}

/**
 * The page numbers from 1 to `pagesStarted` on the previous day's run item
 * that `pagesFinished` lacks. A previous day with no run item counts as
 * one missing page only when an earlier run item exists; otherwise 0.
 */
async function countMissingPages(deps: RecheckDeps, previousDay: string): Promise<number> {
  const got = await deps.ddb.send(new GetCommand({
    TableName: deps.tableName,
    Key: { [T.partitionKey]: T.runPk, [T.sortKey]: previousDay },
    ConsistentRead: true,
  }), limit());
  if (got.Item !== undefined) {
    const started = count(got.Item[A.pagesStarted]);
    const finished = got.Item[A.pagesFinished] instanceof Set ? (got.Item[A.pagesFinished] as Set<unknown>) : new Set<unknown>();
    let missing = 0;
    for (let p = 1; p <= started; p++) if (!finished.has(p)) missing++;
    return missing;
  }
  const earlier = await deps.ddb.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: '#pk = :run AND #sk < :day',
    ExpressionAttributeNames: { '#pk': T.partitionKey, '#sk': T.sortKey },
    ExpressionAttributeValues: { ':run': T.runPk, ':day': previousDay },
    ConsistentRead: true,
    Limit: 1,
  }), limit());
  return (earlier.Items?.length ?? 0) > 0 ? 1 : 0;
}

async function deleteStaleEntryItems(deps: RecheckDeps, current: ReadonlySet<string>): Promise<number> {
  const stale: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.ddb.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: '#pk = :entry',
      ExpressionAttributeNames: { '#pk': T.partitionKey, '#sk': T.sortKey },
      ExpressionAttributeValues: { ':entry': T.entryPk },
      ProjectionExpression: '#sk',
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }), limit());
    for (const item of page.Items ?? []) {
      const sk = item[T.sortKey];
      if (typeof sk === 'string' && !current.has(sk)) stale.push(sk);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  for (let i = 0; i < stale.length; i += BATCH_WRITE_MAX) {
    let requests: unknown[] = stale.slice(i, i + BATCH_WRITE_MAX).map((sk) => ({
      DeleteRequest: { Key: { [T.partitionKey]: T.entryPk, [T.sortKey]: sk } },
    }));
    for (let round = 1; requests.length > 0; round++) {
      if (round > BATCH_WRITE_ROUNDS) throw new Error('entry items left unprocessed');
      const written = await deps.ddb.send(new BatchWriteCommand({
        RequestItems: { [deps.tableName]: requests as never },
      }), limit());
      requests = written.UnprocessedItems?.[deps.tableName] ?? [];
    }
  }
  return stale.length;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface PageResult {
  /** True when the page's date was not today: nothing was written. */
  readonly stale: boolean;
  readonly checked: number;
  /** Writes that changed an item (a repeat changes none). */
  readonly recorded: number;
}

/** Throws when the input is not a page the lister could have sent. */
export function parsePageEvent(event: unknown): SweeperPageEvent {
  const e = event as Partial<SweeperPageEvent> | undefined;
  if (
    e === undefined || e === null || e.job !== SWEEPER_JOB.page
    || typeof e.runDay !== 'string' || !UTC_DAY.test(e.runDay)
    || typeof e.page !== 'number' || !Number.isSafeInteger(e.page) || e.page < 1
    || !Array.isArray(e.tenantIds) || e.tenantIds.length > SWEEPER_PAGE_SIZE
  ) {
    throw new Error('not a sweeper page event');
  }
  for (const id of e.tenantIds) {
    if (typeof id !== 'string' || toStoredIdOrUndefined(id) !== id) throw new Error('not a sweeper page event');
  }
  return { job: e.job, runDay: e.runDay, page: e.page, tenantIds: e.tenantIds };
}

function toStoredIdOrUndefined(id: string): string | undefined {
  try {
    return toStoredId(id);
  } catch {
    return undefined;
  }
}

export async function runPage(event: SweeperPageEvent, deps: RecheckDeps): Promise<PageResult> {
  const today = event.runDay;
  if (today !== utcDay(deps.now())) {
    logLine('WARN', SWEEPER_LOG.stalePage, { runDay: event.runDay, page: event.page });
    return { stale: true, checked: 0, recorded: 0 };
  }

  const readStart = deps.now();
  const read = await mapLimit(event.tenantIds, PAGE_CONCURRENCY, (tenantId) => readEntry(deps, tenantId));
  logLine('INFO', SWEEPER_LOG.pageReads, { runDay: today, page: event.page, reads: event.tenantIds.length, readMs: deps.now() - readStart });

  // An entry whose domain is gone or whose challenge is open is skipped.
  const toCheck = read.filter((r): r is { tenantId: string; entry: TenantEntry & { d: string; dk: string } } =>
    r !== undefined && isPassed(r.entry));

  const recorded = await mapLimit(toCheck, PAGE_CONCURRENCY, async ({ tenantId, entry }) => {
    const outcome = toOutcome(await deps.challenge(entry.d, entry.dk));
    return recordOutcome(deps, today, tenantId, entry.d, outcome);
  });

  await deps.ddb.send(new UpdateCommand({
    TableName: deps.tableName,
    Key: { [T.partitionKey]: T.runPk, [T.sortKey]: today },
    UpdateExpression: 'ADD #finished :page SET #expires = if_not_exists(#expires, :expires)',
    ExpressionAttributeNames: { '#finished': A.pagesFinished, '#expires': A.expiresAt },
    ExpressionAttributeValues: { ':page': new Set([event.page]), ':expires': expiresAt(deps.now()) },
  }), limit());

  const result = { stale: false, checked: toCheck.length, recorded: recorded.filter(Boolean).length };
  logLine('INFO', 'page finished', { runDay: today, page: event.page, ...result });
  return result;
}

/** The entry, or undefined when the key is gone or unreadable. Any other read error fails the page. */
async function readEntry(deps: RecheckDeps, tenantId: string): Promise<{ tenantId: string; entry: TenantEntry } | undefined> {
  let value: string | undefined;
  try {
    value = (await deps.kvsOnce.send(new GetKeyCommand({ KvsARN: deps.routeTableArn, Key: tenantKey(tenantId) }), limit())).Value;
  } catch (error) {
    // The lister has just read the store, so this error means the key is gone (ADR-0022).
    if (!(error instanceof ResourceNotFoundException)) throw error;
    value = undefined;
  }
  if (value === undefined) {
    logLine('INFO', SWEEPER_LOG.entryGone, { tenantId });
    return undefined;
  }
  try {
    return { tenantId, entry: decodeTenantEntry(value) };
  } catch {
    logLine('WARN', 'tenant entry unreadable', { tenantId });
    return undefined;
  }
}

export function toOutcome(challenge: ChallengeOutcome): Outcome {
  if (challenge === 'pass') return 'pass';
  return challenge === 'unresolved' ? 'error' : 'miss';
}

/** The outcomes a write of `outcome` may replace on the same day: error is weaker than pass, pass weaker than miss. */
const WEAKER: Readonly<Record<Outcome, readonly Outcome[]>> = {
  error: [],
  pass: ['error'],
  miss: ['error', 'pass'],
};

function count(x: unknown): number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0;
}

/**
 * Records one outcome for a tenant, domain and day (the day rule). Returns
 * true when the write changed the item; a failed condition is a no-op.
 */
export async function recordOutcome(deps: RecheckDeps, today: string, tenantId: string, domain: string, outcome: Outcome): Promise<boolean> {
  const key = { [T.partitionKey]: T.entryPk, [T.sortKey]: entrySk(tenantId, domain) };
  const got = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }), limit());
  const item = got.Item;

  // The counts before today.
  let missBefore = 0;
  let errorBefore = 0;
  if (item !== undefined) {
    const sameDay = item[A.lastCheckedDay] === today;
    missBefore = count(item[sameDay ? A.missBefore : A.missStreak]);
    errorBefore = count(item[sameDay ? A.errorBefore : A.errorStreak]);
  }

  let missStreak = missBefore;
  let errorStreak = errorBefore;
  if (outcome === 'pass') {
    missStreak = 0;
    errorStreak = 0;
  } else if (outcome === 'miss') {
    missStreak = missBefore + 1;
    errorStreak = 0;
  } else {
    errorStreak = errorBefore + 1;
  }

  const weaker = WEAKER[outcome];
  const values: Record<string, unknown> = {
    ':today': today,
    ':outcome': outcome,
    ':missStreak': missStreak,
    ':errorStreak': errorStreak,
    ':missBefore': missBefore,
    ':errorBefore': errorBefore,
  };
  weaker.forEach((w, i) => { values[`:weaker${i}`] = w; });
  const sameDayClause = weaker.length > 0
    ? ` OR (#day = :today AND #outcome IN (${weaker.map((_, i) => `:weaker${i}`).join(', ')}))`
    : '';

  try {
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: key,
      UpdateExpression: 'SET #day = :today, #outcome = :outcome, #missStreak = :missStreak, #errorStreak = :errorStreak, '
        + '#missBefore = :missBefore, #errorBefore = :errorBefore',
      ConditionExpression: `attribute_not_exists(#pk) OR #day < :today${sameDayClause}`,
      ExpressionAttributeNames: {
        '#pk': T.partitionKey,
        '#day': A.lastCheckedDay,
        '#outcome': A.lastOutcome,
        '#missStreak': A.missStreak,
        '#errorStreak': A.errorStreak,
        '#missBefore': A.missBefore,
        '#errorBefore': A.errorBefore,
      },
      ExpressionAttributeValues: values,
    }), limit());
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException || errorName(error) === 'ConditionalCheckFailedException') return false;
    throw error;
  }

  if (outcome === 'miss' && missStreak >= ALARM_STREAK) {
    logLine('WARN', SWEEPER_LOG.threeMiss, { tenantId, domain, missStreak });
    emitCount(SWEEPER_METRICS.threeMiss, 1, deps.distributionId, deps.now());
  }
  if (errorStreak >= ALARM_STREAK) {
    logLine('WARN', SWEEPER_LOG.unverifiable, { tenantId, domain, errorStreak });
    emitCount(SWEEPER_METRICS.unverifiable, 1, deps.distributionId, deps.now());
  }
  return true;
}
