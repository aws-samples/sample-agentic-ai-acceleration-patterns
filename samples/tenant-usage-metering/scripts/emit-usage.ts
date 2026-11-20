// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The emitter snippet (spec §6.1, §6.3): what a cell's workload runs to send
 * usage. It runs under the cell's emitter role `<fleet>-ue-<cellId>`.
 *
 * - Each event gets a ULID `eventId` once, when it is recorded, and is
 *   stored as the exact bytes that are sent; a resend sends those bytes.
 * - Batches hold at most 100 events and 1,048,576 bytes of UTF-8.
 * - `RETRY` results are sent again; a 429, a 5xx or a timeout sends the
 *   whole batch again, unchanged, with backoff. A 400, 403 or 413 is not
 *   resent: the batch is reported and dropped.
 * - Events still unsent when `flush()` runs out of attempts stay pending,
 *   with the same bytes, for the next `flush()`; nothing retryable is dropped.
 *
 * The buffer is in memory, so events recorded but not yet sent are lost
 * if the process dies; a workload that must not lose them persists the
 * pending list (a file, a queue) with the same bytes.
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { ulid } from 'ulid';

const MAX_EVENTS = 100;
const MAX_BYTES = 1_048_576;

export interface UsageInput {
  readonly tenantId: string;
  readonly meterId: string;
  readonly value: string;
  readonly time?: Date;
  readonly dimensions?: Record<string, string>;
}

export interface EmitterOptions {
  /** `METERING_API_URL`, the cell parameter (spec §3.4). */
  readonly apiUrl: string;
  readonly region: string;
  readonly credentials?: AwsCredentialIdentityProvider;
  readonly maxAttempts?: number;
  /** Events held at most; `record()` throws past it, so an outage cannot grow memory without bound. @default 100000 */
  readonly maxPending?: number;
}

export class UsageEmitter {
  /** Each pending event as the JSON it is sent as, written once. */
  private pending: string[] = [];
  /** Events taken by the running `flush()`. */
  private sending = 0;
  /** Flushes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly url: URL;
  private readonly signer: SignatureV4;

  constructor(private readonly options: EmitterOptions) {
    this.url = new URL(`${options.apiUrl.replace(/\/$/, '')}/usage-events`);
    this.signer = new SignatureV4({
      service: 'execute-api',
      region: options.region,
      credentials: options.credentials ?? fromNodeProviderChain(),
      sha256: Sha256,
    });
  }

  /** Records one event; returns its `eventId`. */
  record(input: UsageInput): string {
    if (this.pending.length + this.sending >= (this.options.maxPending ?? 100_000)) {
      throw new Error('usage buffer is full: flush() has not been able to send for too long');
    }
    const eventId = ulid();
    this.pending.push(
      JSON.stringify({
        eventId,
        tenantId: input.tenantId,
        meterId: input.meterId,
        value: input.value,
        time: (input.time ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
      }),
    );
    return eventId;
  }

  /** Splits the pending events into batches under both limits. */
  private batches(events: ReadonlyArray<string>): string[][] {
    const out: string[][] = [];
    let current: string[] = [];
    let bytes = '{"events":[]}'.length;
    for (const event of events) {
      const size = Buffer.byteLength(event) + 1;
      if (current.length > 0 && (current.length >= MAX_EVENTS || bytes + size > MAX_BYTES)) {
        out.push(current);
        current = [];
        bytes = '{"events":[]}'.length;
      }
      current.push(event);
      bytes += size;
    }
    if (current.length > 0) {
      out.push(current);
    }
    return out;
  }

  private async post(body: string): Promise<{ status: number; body: string }> {
    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: this.url.hostname,
      path: this.url.pathname,
      headers: { host: this.url.hostname, 'content-type': 'application/json' },
      body,
    });
    const signed = await this.signer.sign(request);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.text() };
  }

  /**
   * Sends the events pending when it starts; what is still retryable after
   * `maxAttempts` goes back in front of anything recorded meanwhile, for the
   * next call. Calls run one at a time.
   */
  flush(): Promise<{ accepted: number; refused: Array<{ eventId?: string; reason?: string }>; dropped: number; pending: number }> {
    const run = this.queue.then(() => this.flushOnce());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async flushOnce(): Promise<{ accepted: number; refused: Array<{ eventId?: string; reason?: string }>; dropped: number; pending: number }> {
    const maxAttempts = this.options.maxAttempts ?? 6;
    let accepted = 0;
    let dropped = 0;
    const refused: Array<{ eventId?: string; reason?: string }> = [];
    let sending = this.pending;
    this.pending = [];
    this.sending = sending.length;
    try {
      for (let attempt = 0; attempt < maxAttempts && sending.length > 0; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)));
        }
        const retry: string[] = [];
        for (const batch of this.batches(sending)) {
          const body = `{"events":[${batch.join(',')}]}`;
          let response: { status: number; body: string };
          try {
            response = await this.post(body);
          } catch {
            retry.push(...batch); // a timeout or a network error: the same bytes again
            continue;
          }
          if (response.status === 429 || response.status >= 500) {
            retry.push(...batch);
            continue;
          }
          if (response.status !== 200) {
            dropped += batch.length; // 400, 403, 413: resending cannot help
            continue;
          }
          const results = (JSON.parse(response.body) as { results: Array<{ eventId?: string; result: string; reason?: string }> }).results;
          results.forEach((result, i) => {
            if (result.result === 'ACCEPTED') {
              accepted++;
            } else if (result.result === 'RETRY') {
              retry.push(batch[i]);
            } else {
              refused.push({ eventId: result.eventId, reason: result.reason });
            }
          });
        }
        sending = retry;
        this.sending = sending.length;
      }
    } finally {
      // Whatever is still retryable waits for the next flush, unchanged, ahead of newer events.
      this.pending = [...sending, ...this.pending];
      this.sending = 0;
    }
    return { accepted, refused, dropped, pending: this.pending.length };
  }
}
