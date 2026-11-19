// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetKeyCommand, ResourceNotFoundException } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { BatchWriteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  challengeOutcomes,
  ddb,
  entryItem,
  kvs,
  lambda,
  logLines,
  metricValues,
  NOW,
  recheckDeps,
  resetAll,
  routeTable,
  runItem,
  seedEntry,
  seedRun,
  startedPages,
  stdoutText,
  TENANT_A,
  TENANT_B,
  TENANT_C,
  tenantValue,
  TODAY,
  TOKEN_A,
  TOKEN_B,
  YESTERDAY,
} from './support';
import { SWEEPER_METRICS, type SweeperPageEvent } from '../../src/shared/contracts';
import { parsePageEvent, runLister, runPage, toOutcome, utcDay } from '../../src/sweeper/recheck';

const DOMAIN_A = 'shop-a.example.com';
const DOMAIN_B = 'shop-b.example.com';

function page(tenantIds: string[], fields: Partial<SweeperPageEvent> = {}): SweeperPageEvent {
  return { job: 'page', runDay: TODAY, page: 1, tenantIds, ...fields };
}

function linesWith(message: string): Record<string, any>[] {
  return logLines().filter((l) => l.message === message);
}

beforeEach(() => {
  resetAll();
  challengeOutcomes.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('lister (spec §3.4 step 5, ADR-0020, ADR-0022)', () => {
  it('lists only passed challenges, sets pagesStarted and starts one page with the lister\'s date', async () => {
    routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
    routeTable.set(`tenant#${TENANT_B}`, tenantValue({ d: DOMAIN_B, dk: TOKEN_B, dx: 1795700000 }));
    routeTable.set(`tenant#${TENANT_C}`, tenantValue());
    routeTable.set(`host#${DOMAIN_A}`, JSON.stringify({ v: 1, t: TENANT_A, ac: '111111111111' }));
    routeTable.set('app', '{"v":1}');

    const result = await runLister(recheckDeps());

    expect(result).toEqual({ runDay: TODAY, entries: 1, pages: 1, missingPages: 0, deletedItems: 0 });
    expect(startedPages()).toEqual([{ job: 'page', runDay: TODAY, page: 1, tenantIds: [TENANT_A] }]);
    expect(runItem(TODAY)).toMatchObject({ pagesStarted: 1 });
    expect(runItem(TODAY)!.expiresAt).toBe(Math.floor(NOW / 1000) + 14 * 24 * 60 * 60);
  });

  it('splits the entries into pages of 500 across ListKeys pages', async () => {
    for (let i = 0; i < 501; i++) {
      const id = `01hzx8k9p0qrst7vwxyz${String(i).padStart(6, '0')}`;
      routeTable.set(`tenant#${id}`, tenantValue({ d: `d${i}.example.com`, dk: TOKEN_A }));
    }
    await runLister(recheckDeps());
    const pages = startedPages();
    expect(pages.map((p) => [p.page, p.tenantIds.length])).toEqual([[1, 500], [2, 1]]);
    expect(runItem(TODAY)!.pagesStarted).toBe(2);
  });

  it('starts no page and records zero pages when no entry has a passed challenge', async () => {
    routeTable.set(`tenant#${TENANT_C}`, tenantValue());
    await runLister(recheckDeps());
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(runItem(TODAY)!.pagesStarted).toBe(0);
  });

  it('emits a missing-pages count of 0 on a first run, with no run item at all', async () => {
    await runLister(recheckDeps());
    expect(metricValues(SWEEPER_METRICS.missingPages)).toEqual([0]);
  });

  it('counts the previous day\'s started pages that did not finish', async () => {
    seedRun(YESTERDAY, { pagesStarted: 3, pagesFinished: new Set([1, 3]) });
    await runLister(recheckDeps());
    expect(metricValues(SWEEPER_METRICS.missingPages)).toEqual([1]);
  });

  it('counts a finished zero-page run as 0', async () => {
    seedRun(YESTERDAY, { pagesStarted: 0 });
    await runLister(recheckDeps());
    expect(metricValues(SWEEPER_METRICS.missingPages)).toEqual([0]);
  });

  it('counts a previous day with no run item as one missing page when an earlier run item exists', async () => {
    seedRun('2026-11-17', { pagesStarted: 1, pagesFinished: new Set([1]) });
    await runLister(recheckDeps());
    expect(metricValues(SWEEPER_METRICS.missingPages)).toEqual([1]);
  });

  it('deletes the entry items whose tenant and domain are no longer listed', async () => {
    routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'pass' });
    seedEntry(TENANT_A, 'old.example.com', { lastCheckedDay: YESTERDAY, lastOutcome: 'miss' });
    seedEntry(TENANT_B, DOMAIN_B, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss' });

    const result = await runLister(recheckDeps());

    expect(result.deletedItems).toBe(2);
    expect(entryItem(TENANT_A, DOMAIN_A)).toBeDefined();
    expect(entryItem(TENANT_A, 'old.example.com')).toBeUndefined();
    expect(entryItem(TENANT_B, DOMAIN_B)).toBeUndefined();
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it('is one run when repeated on the same day: the same pages and the same run item', async () => {
    routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
    await runLister(recheckDeps());
    seedRun(TODAY, { ...runItem(TODAY), pagesFinished: new Set([1]) });
    await runLister(recheckDeps());
    expect(startedPages().map((p) => p.runDay)).toEqual([TODAY, TODAY]);
    expect(runItem(TODAY)).toMatchObject({ pagesStarted: 1, pagesFinished: new Set([1]) });
  });

  it('fails when a table read fails, before any page starts', async () => {
    routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
    ddb.on(GetCommand).rejects(new Error('throttled'));
    await expect(runLister(recheckDeps())).rejects.toThrow('throttled');
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });
});

describe('page (spec §3.4 step 5, ADR-0022)', () => {
  beforeEach(() => {
    routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
  });

  it('is a no-op with a stale-page line when its date is not today', async () => {
    const result = await runPage(page([TENANT_A], { runDay: YESTERDAY, page: 2 }), recheckDeps());
    expect(result.stale).toBe(true);
    expect(linesWith('stale-page')).toEqual([{ level: 'WARN', message: 'stale-page', runDay: YESTERDAY, page: 2 }]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(kvs.commandCalls(GetKeyCommand)).toHaveLength(0);
  });

  it('files a page that ends after midnight under its own day', async () => {
    let now = Date.UTC(2026, 10, 20, 23, 59, 59);
    const deps = recheckDeps({ now: () => now, challenge: async () => { now += 2_000; return 'pass'; } });
    await runPage(page([TENANT_A]), deps);
    expect(entryItem(TENANT_A, DOMAIN_A)!.lastCheckedDay).toBe(TODAY);
    expect(runItem(TODAY)!.pagesFinished).toEqual(new Set([1]));
    expect(runItem('2026-11-21')).toBeUndefined();
  });

  it('records a first pass and adds its page number to the run item', async () => {
    const result = await runPage(page([TENANT_A]), recheckDeps());
    expect(result).toEqual({ stale: false, checked: 1, recorded: 1 });
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({
      lastCheckedDay: TODAY, lastOutcome: 'pass', missStreak: 0, errorStreak: 0, missBefore: 0, errorBefore: 0,
    });
    expect(runItem(TODAY)!.pagesFinished).toEqual(new Set([1]));
  });

  it('reaches three misses after two missed days, logs the three-miss line without the token and counts once', async () => {
    challengeOutcomes.set(DOMAIN_A, 'missing');
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss', missStreak: 2, errorStreak: 0, missBefore: 1, errorBefore: 0 });

    await runPage(page([TENANT_A]), recheckDeps());

    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastCheckedDay: TODAY, lastOutcome: 'miss', missStreak: 3, missBefore: 2, errorStreak: 0 });
    expect(linesWith('three-miss')).toEqual([{ level: 'WARN', message: 'three-miss', tenantId: TENANT_A, domain: DOMAIN_A, missStreak: 3 }]);
    expect(metricValues(SWEEPER_METRICS.threeMiss)).toEqual([1]);
    expect(stdoutText()).not.toContain(TOKEN_A);
  });

  it('resets both streaks on a pass after two missed days, and logs no three-miss line', async () => {
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss', missStreak: 2, errorStreak: 0, missBefore: 1, errorBefore: 0 });
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'pass', missStreak: 0, errorStreak: 0, missBefore: 2, errorBefore: 0 });
    expect(linesWith('three-miss')).toHaveLength(0);
  });

  it('changes nothing and counts nothing when the page repeats on the same day', async () => {
    challengeOutcomes.set(DOMAIN_A, 'mismatch');
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss', missStreak: 2, errorStreak: 0, missBefore: 1, errorBefore: 0 });
    await runPage(page([TENANT_A]), recheckDeps());
    const after = entryItem(TENANT_A, DOMAIN_A);

    const repeat = await runPage(page([TENANT_A]), recheckDeps());

    expect(repeat.recorded).toBe(0);
    expect(entryItem(TENANT_A, DOMAIN_A)).toEqual(after);
    expect(metricValues(SWEEPER_METRICS.threeMiss)).toEqual([1]);
    expect(runItem(TODAY)!.pagesFinished).toEqual(new Set([1]));
  });

  it('lets a miss replace a pass on the same day, counting from the day\'s before counts', async () => {
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss', missStreak: 2, errorStreak: 0, missBefore: 1, errorBefore: 0 });
    await runPage(page([TENANT_A]), recheckDeps());
    challengeOutcomes.set(DOMAIN_A, 'missing');

    const second = await runPage(page([TENANT_A]), recheckDeps());

    expect(second.recorded).toBe(1);
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'miss', missStreak: 3, missBefore: 2, errorStreak: 0 });
    expect(metricValues(SWEEPER_METRICS.threeMiss)).toEqual([1]);
  });

  it('lets a pass replace an error on the same day, and an error never replaces a pass', async () => {
    challengeOutcomes.set(DOMAIN_A, 'unresolved');
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'error', errorStreak: 1 });

    challengeOutcomes.set(DOMAIN_A, 'pass');
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'pass', errorStreak: 0, errorBefore: 0 });

    challengeOutcomes.set(DOMAIN_A, 'unresolved');
    const third = await runPage(page([TENANT_A]), recheckDeps());
    expect(third.recorded).toBe(0);
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'pass' });
  });

  it('leaves the miss streak as it was on an error day and emits no three-miss count', async () => {
    challengeOutcomes.set(DOMAIN_A, 'unresolved');
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'miss', missStreak: 3, errorStreak: 0, missBefore: 2, errorBefore: 0 });
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ lastOutcome: 'error', missStreak: 3, errorStreak: 1, missBefore: 3, errorBefore: 0 });
    expect(metricValues(SWEEPER_METRICS.threeMiss)).toEqual([]);
    expect(linesWith('three-miss')).toHaveLength(0);
  });

  it('logs an unverifiable line and counts it on the third error day in a row', async () => {
    challengeOutcomes.set(DOMAIN_A, 'unresolved');
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: YESTERDAY, lastOutcome: 'error', missStreak: 1, errorStreak: 2, missBefore: 1, errorBefore: 1 });
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ errorStreak: 3, missStreak: 1 });
    expect(linesWith('unverifiable')).toEqual([{ level: 'WARN', message: 'unverifiable', tenantId: TENANT_A, domain: DOMAIN_A, errorStreak: 3 }]);
    expect(metricValues(SWEEPER_METRICS.unverifiable)).toEqual([1]);
    expect(metricValues(SWEEPER_METRICS.threeMiss)).toEqual([]);
  });

  it('counts checks: a day with no check neither resets nor extends a streak', async () => {
    challengeOutcomes.set(DOMAIN_A, 'missing');
    seedEntry(TENANT_A, DOMAIN_A, { lastCheckedDay: '2026-11-15', lastOutcome: 'miss', missStreak: 2, errorStreak: 0, missBefore: 1, errorBefore: 0 });
    await runPage(page([TENANT_A]), recheckDeps());
    expect(entryItem(TENANT_A, DOMAIN_A)).toMatchObject({ missStreak: 3 });
  });

  it('skips an id whose entry is gone with one line, and finishes the rest', async () => {
    const result = await runPage(page([TENANT_B, TENANT_A]), recheckDeps());
    expect(result.checked).toBe(1);
    expect(linesWith('tenant entry gone')).toEqual([{ level: 'INFO', message: 'tenant entry gone', tenantId: TENANT_B }]);
    expect(entryItem(TENANT_B, DOMAIN_B)).toBeUndefined();
    expect(runItem(TODAY)!.pagesFinished).toEqual(new Set([1]));
  });

  it('skips an entry whose domain is gone or whose challenge is open on re-read', async () => {
    routeTable.set(`tenant#${TENANT_B}`, tenantValue({ d: DOMAIN_B, dk: TOKEN_B, dx: 1795700000 }));
    routeTable.set(`tenant#${TENANT_C}`, tenantValue());
    const result = await runPage(page([TENANT_A, TENANT_B, TENANT_C]), recheckDeps());
    expect(result.checked).toBe(1);
    expect(entryItem(TENANT_B, DOMAIN_B)).toBeUndefined();
  });

  it('fails without finishing when a read fails with another error', async () => {
    kvs.on(GetKeyCommand).rejects(new Error('timeout'));
    await expect(runPage(page([TENANT_A]), recheckDeps())).rejects.toThrow('timeout');
    expect(runItem(TODAY)).toBeUndefined();
  });

  it('fails without finishing when a table write fails', async () => {
    ddb.on(UpdateCommand).rejects(new Error('throttled'));
    await expect(runPage(page([TENANT_A]), recheckDeps())).rejects.toThrow('throttled');
    expect(runItem(TODAY)).toBeUndefined();
  });

  it('logs the time its reads took', async () => {
    let now = NOW;
    kvs.on(GetKeyCommand).callsFake(() => {
      now += 30;
      return { Key: `tenant#${TENANT_A}`, Value: routeTable.get(`tenant#${TENANT_A}`) };
    });
    await runPage(page([TENANT_A]), recheckDeps({ now: () => now }));
    expect(linesWith('page reads')).toEqual([{ level: 'INFO', message: 'page reads', runDay: TODAY, page: 1, reads: 1, readMs: 30 }]);
  });

  it('reads at most ten entries at a time', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `01hzx8k9p0qrst7vwxyz${String(i).padStart(6, '0')}`);
    for (const id of ids) routeTable.set(`tenant#${id}`, tenantValue({ d: `${id}.example.com`, dk: TOKEN_A }));
    let inFlight = 0;
    let most = 0;
    kvs.on(GetKeyCommand).callsFake(async (input: { Key: string }) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { Key: input.Key, Value: routeTable.get(input.Key) };
    });
    await runPage(page(ids), recheckDeps());
    expect(most).toBe(10);
  });

  it('treats a ResourceNotFoundException from GetKey as a missing key', async () => {
    kvs.on(GetKeyCommand).rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));
    const result = await runPage(page([TENANT_A]), recheckDeps());
    expect(result.checked).toBe(0);
    expect(runItem(TODAY)!.pagesFinished).toEqual(new Set([1]));
  });

  it('writes the day rule as one conditional update', async () => {
    challengeOutcomes.set(DOMAIN_A, 'missing');
    await runPage(page([TENANT_A]), recheckDeps());
    const update = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input).find((i) => i.Key!.pk === 'ENTRY')!;
    expect(update.ConditionExpression).toBe('attribute_not_exists(#pk) OR #day < :today OR (#day = :today AND #outcome IN (:weaker0, :weaker1))');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':weaker0': 'error', ':weaker1': 'pass' });
    expect(ddb.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('page input', () => {
  it('accepts what the lister sends', () => {
    expect(parsePageEvent(page([TENANT_A]))).toEqual(page([TENANT_A]));
  });

  it.each([
    ['no date', { job: 'page', page: 1, tenantIds: [] }],
    ['a malformed date', { job: 'page', runDay: '20-11-2026', page: 1, tenantIds: [] }],
    ['page 0', { job: 'page', runDay: TODAY, page: 0, tenantIds: [] }],
    ['an upper-case id', { job: 'page', runDay: TODAY, page: 1, tenantIds: [TENANT_A.toUpperCase()] }],
    ['a key in place of an id', { job: 'page', runDay: TODAY, page: 1, tenantIds: [`tenant#${TENANT_A}`] }],
    ['more than 500 ids', { job: 'page', runDay: TODAY, page: 1, tenantIds: Array(501).fill(TENANT_A) }],
  ])('refuses %s', (_name, event) => {
    expect(() => parsePageEvent(event)).toThrow('not a sweeper page event');
  });
});

describe('outcomes', () => {
  it('maps the challenge values to pass, miss and error', () => {
    expect(['pass', 'missing', 'mismatch', 'unresolved'].map((c) => toOutcome(c as never))).toEqual(['pass', 'miss', 'miss', 'error']);
  });

  it('takes the UTC date', () => {
    expect(utcDay(Date.UTC(2026, 10, 20, 23, 59, 59))).toBe('2026-11-20');
  });
});
