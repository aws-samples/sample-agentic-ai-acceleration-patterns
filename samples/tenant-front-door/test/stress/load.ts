// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { sleep } from './http';

/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first error after the rest settle. */
export async function pool<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

/**
 * Open-loop pacing: starts `fn(i)` at `rps` per second for `seconds`, whether
 * or not the earlier calls have returned (a slow edge must not slow the
 * load). At most `maxInflight` calls run at once; past that the pacer waits
 * for one to finish, and counts the call as `late`. Resolves when every call
 * has settled.
 */
export async function paced(
  rps: number,
  seconds: number,
  fn: (i: number) => Promise<void>,
  maxInflight = 512,
): Promise<{ readonly started: number; readonly late: number }> {
  const total = Math.round(rps * seconds);
  const start = Date.now();
  const inflight = new Set<Promise<void>>();
  let late = 0;
  for (let i = 0; i < total; i += 1) {
    const wait = start + (i * 1000) / rps - Date.now();
    if (wait > 0) await sleep(wait);
    else if (wait < -1000) late += 1;
    if (inflight.size >= maxInflight) await Promise.race(inflight);
    const p: Promise<void> = fn(i).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  return { started: total, late };
}

/** A shuffled copy. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Spaces calls at least `1000 / perSecond` ms apart, across every caller sharing it. */
export class Rate {
  private next = 0;

  constructor(private readonly perSecond: number) {}

  async take(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + 1000 / this.perSecond;
    if (at > now) await sleep(at - now);
  }
}
