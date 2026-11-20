// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as https from 'node:https';

/**
 * One HTTPS request with timings, over a shared keep-alive agent. Node's
 * `fetch` would hide the time to first byte, and its header rules differ
 * (the stress probes send `Sec-Fetch-Site` and a header over 8 KiB).
 * Bodies are read up to `BODY_LIMIT` bytes; a token or a password is never
 * logged here.
 */

const agent = new https.Agent({ keepAlive: true, maxSockets: 256 });
const BODY_LIMIT = 4096;

export interface HttpResult {
  /** 0 for a network error or a timeout. */
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Seconds from the call to the first byte, and to the last. */
  readonly ttfb: number;
  readonly total: number;
  /** The error's code or name when status is 0. */
  readonly error?: string;
}

export interface HttpOptions {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** Bytes of the body to keep; the platform API's token answer is longer than the edge's answers. */
  readonly bodyLimit?: number;
}

export function request(o: HttpOptions): Promise<HttpResult> {
  const start = process.hrtime.bigint();
  const since = (): number => Number(process.hrtime.bigint() - start) / 1e9;
  return new Promise((resolve) => {
    let ttfb = 0;
    let settled = false;
    const done = (r: Omit<HttpResult, 'ttfb' | 'total'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...r, ttfb: ttfb || since(), total: since() });
    };
    const limit = o.bodyLimit ?? BODY_LIMIT;
    const url = new URL(o.url);
    const headers: Record<string, string> = { ...o.headers };
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const req = https.request(
      {
        agent,
        method: o.method,
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: o.timeoutMs ?? 30_000,
      },
      (res) => {
        ttfb = since();
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < limit) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
          done({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).subarray(0, limit).toString('utf8') });
        });
        res.on('error', (e: NodeJS.ErrnoException) => done({ status: 0, headers: {}, body: '', error: e.code ?? e.name }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ status: 0, headers: {}, body: '', error: 'timeout' });
    });
    req.on('error', (e: NodeJS.ErrnoException) => done({ status: 0, headers: {}, body: '', error: e.code ?? e.name }));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
