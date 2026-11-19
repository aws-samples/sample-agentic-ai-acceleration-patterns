// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The KeyValueStore data API signs with SigV4A. The multi-region signer
// finds the pure-JS signer only once this module has been loaded, so it is
// imported for its side effect before the client is used (no CRT build).
import '@aws-sdk/signature-v4a';
import {
  type CloudFrontKeyValueStoreClient,
  ConflictException,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { refuse } from './errors';
import { emitRouteTableBytes } from './log';
import { MAX_STORE_BYTES } from '../shared/route-table';

/**
 * The route table writes (spec §3.4 step 5, §4.1). Every write is one
 * `UpdateKeys` with the store's ETag (`IfMatch`), so writes serialise
 * (ADR-0003). A write is planned from what one attempt reads: on an ETag
 * conflict the plan runs again on a fresh read, so every check that rests
 * on the route table (the write-once origin, the cell route, the `host#`
 * owner, the size) is repeated before the next attempt.
 */

/** Reads one key in the current attempt; `undefined` when it is absent. */
export type ReadKey = (key: string) => Promise<string | undefined>;

export interface Plan<T> {
  /** Key to value. A put whose value equals what the attempt read is dropped. */
  readonly puts?: Readonly<Record<string, string>>;
  /** A delete of a key the attempt read as absent is dropped. */
  readonly deletes?: readonly string[];
  readonly result: T;
}

export interface RouteStore {
  /**
   * Runs `plan` against a fresh read and writes what it returns, at most
   * `MAX_ATTEMPTS` times on ETag conflicts, then 503. A plan may throw a
   * refusal, which ends the update with nothing written.
   */
  update<T>(plan: (read: ReadKey) => Promise<Plan<T>>): Promise<T>;
}

export const MAX_ATTEMPTS = 5;
export const BACKOFF_MIN_MS = 50;
export const BACKOFF_MAX_MS = 500;

export interface KvsRouteStoreOptions {
  readonly client: CloudFrontKeyValueStoreClient;
  readonly arn: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The store refuses the `IfMatch` of a stale ETag with a conflict (409; 412 is read the same way). */
function isEtagConflict(error: unknown): boolean {
  if (error instanceof ConflictException) return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  return status === 409 || status === 412;
}

export class KvsRouteStore implements RouteStore {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: KvsRouteStoreOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async update<T>(plan: (read: ReadKey) => Promise<Plan<T>>): Promise<T> {
    const { client, arn } = this.options;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const described = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: arn }));
      const read = new Map<string, string | undefined>();
      const readKey: ReadKey = async (key) => {
        if (read.has(key)) return read.get(key);
        let value: string | undefined;
        try {
          value = (await client.send(new GetKeyCommand({ KvsARN: arn, Key: key }))).Value;
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException)) throw error;
          value = undefined;
        }
        read.set(key, value);
        return value;
      };

      const planned = await plan(readKey);
      const puts = Object.entries(planned.puts ?? {}).filter(([k, v]) => !(read.has(k) && read.get(k) === v));
      const deletes = (planned.deletes ?? []).filter((k) => !(read.has(k) && read.get(k) === undefined));
      if (puts.length === 0 && deletes.length === 0) return planned.result;

      // The size after the write, from the size before it and what this attempt read (§4.1, ADR-0012).
      let delta = 0;
      for (const [k, v] of puts) {
        const old = read.get(k);
        delta += old === undefined ? bytes(k) + bytes(v) : bytes(v) - bytes(old);
      }
      for (const k of deletes) {
        const old = read.get(k);
        if (old !== undefined) delta -= bytes(k) + bytes(old);
      }
      if (delta > 0 && (described.TotalSizeInBytes ?? 0) + delta > MAX_STORE_BYTES) throw refuse.storage();

      try {
        const written = await client.send(new UpdateKeysCommand({
          KvsARN: arn,
          IfMatch: described.ETag,
          Puts: puts.length > 0 ? puts.map(([Key, Value]) => ({ Key, Value })) : undefined,
          Deletes: deletes.length > 0 ? deletes.map((Key) => ({ Key })) : undefined,
        }));
        if (written.TotalSizeInBytes !== undefined) emitRouteTableBytes(written.TotalSizeInBytes);
        return planned.result;
      } catch (error) {
        if (error instanceof ServiceQuotaExceededException) throw refuse.storage();
        if (!isEtagConflict(error)) throw error;
        if (attempt < MAX_ATTEMPTS) await this.sleep(BACKOFF_MIN_MS + this.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS));
      }
    }
    throw refuse.unavailable('the route table is busy; retry');
  }
}
