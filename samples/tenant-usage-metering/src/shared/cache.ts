// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A per-container read cache with a fixed lifetime (spec §5.1: registry
 * reads are cached for 60 seconds). Misses are cached too, so a flood from
 * an unregistered role costs one read a minute per role.
 */

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > at) {
      return hit.value;
    }
    const value = await load();
    if (this.entries.size >= this.maxEntries) {
      this.entries.clear();
    }
    this.entries.set(key, { value, expiresAt: at + this.ttlMs });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
