// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Fakes for the SPA's browser effects, and the golden `/config.json` cases. */

import * as fs from 'fs';
import * as path from 'path';
import type { FetchLike, KeyValueStorage, RequestInitLike, ResponseLike } from '../../spa/src/http';
import type { ConfigJson } from '../../src/shared/contracts';

export interface ConfigCase {
  readonly name: string;
  readonly addressing: 'single' | 'host';
  readonly host: string;
  readonly body: ConfigJson;
}

export const configCases: ConfigCase[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/config-json.json'), 'utf8'),
).cases;

export function configCase(name: string): ConfigCase {
  const c = configCases.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no config case ${name}`);
  return c;
}

export function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** An unsigned JWT-shaped token: the SPA only decodes its own tokens. */
export function jwt(claims: Record<string, unknown>): string {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.c2ln`;
}

export function json(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, body: null, json: async () => body };
}

export function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === 'string' ? enc.encode(x) : x);
      c.close();
    },
  });
}

export interface Call {
  readonly url: string;
  readonly init: RequestInitLike;
}

/** A `fetch` that answers from `handler` and records every call. */
export function fakeFetch(handler: (url: string, init: RequestInitLike) => ResponseLike | Promise<ResponseLike>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInitLike) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

export function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function formOf(init: RequestInitLike): Record<string, string> {
  if (!(init.body instanceof URLSearchParams)) throw new Error('body is not a form');
  return Object.fromEntries(init.body);
}
