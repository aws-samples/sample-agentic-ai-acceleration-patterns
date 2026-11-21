// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { KvsRouteStore, MAX_ATTEMPTS } from '../../src/registrar/route-store';

/**
 * The data plane of a real KeyValueStore answers a stale `IfMatch` with a
 * `ValidationException` whose message says the pre-condition failed (HTTP
 * 400), not with a `ConflictException`. The store must read that as an ETag
 * conflict and try again.
 */
describe('KvsRouteStore on a stale ETag', () => {
  const stale = (): Error => Object.assign(new Error('Pre-Condition failed during update of Key-Value-Store'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });

  function store(failures: Error[]): { store: KvsRouteStore; updates: number } {
    const state = { updates: 0 };
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeKeyValueStoreCommand') return { ETag: 'e', TotalSizeInBytes: 10 };
        state.updates += 1;
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        return { ETag: 'f', TotalSizeInBytes: 20 };
      },
    };
    const s = new KvsRouteStore({ client: client as never, arn: 'arn:aws:cloudfront::123456789012:key-value-store/x', sleep: async () => undefined, random: () => 0 });
    return { store: s, get updates(): number { return state.updates; } };
  }

  it('retries a pre-condition ValidationException and then writes', async () => {
    const t = store([stale(), stale()]);
    await expect(t.store.update(async () => ({ puts: { k: 'v' }, result: 'done' }))).resolves.toBe('done');
    expect(t.updates).toBe(3);
  });

  it('answers 503 once the attempts run out', async () => {
    const t = store(Array.from({ length: MAX_ATTEMPTS + 1 }, stale));
    await expect(t.store.update(async () => ({ puts: { k: 'v' }, result: 'done' }))).rejects.toThrow('the route table is busy; retry');
    expect(t.updates).toBe(MAX_ATTEMPTS);
  });

  it('does not read another ValidationException as a conflict', async () => {
    const other = Object.assign(new Error('Key too long'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });
    const t = store([other]);
    await expect(t.store.update(async () => ({ puts: { k: 'v' }, result: 'done' }))).rejects.toThrow('Key too long');
    expect(t.updates).toBe(1);
  });
});
