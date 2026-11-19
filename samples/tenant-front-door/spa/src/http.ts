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
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Sleep = (ms: number) => Promise<void>;
