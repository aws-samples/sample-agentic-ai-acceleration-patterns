// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The slice of `fetch` and `Storage` the SPA uses. The modules take these
 * as parameters, so they run unchanged in the browser and in Node tests.
 */

export interface RequestInitLike {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly body?: string | URLSearchParams;
  readonly credentials: 'omit' | 'same-origin';
  /** Aborts the call when the session that made it ends (§7.2). */
  readonly signal?: AbortSignal;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** `fetchFn` with every call bound to `signal`, so ending a session aborts the calls it started (§7.2). */
export function withSignal(fetchFn: FetchLike, signal: AbortSignal): FetchLike {
  return (url, init) => fetchFn(url, { ...init, signal });
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Sleep = (ms: number) => Promise<void>;
