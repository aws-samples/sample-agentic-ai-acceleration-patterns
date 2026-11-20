// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the stand-in agent ingress records of each request (spec §10 step
 * 23, ADR-0024): the path with its stage, the method, the route hint and a
 * fingerprint of `Authorization`, so the test can tell that the viewer's
 * bearer arrived without the log holding it (scripts/CONVENTIONS.md).
 */

import { createHash } from 'node:crypto';

/** The parts of an API Gateway REST proxy event the stand-in reads. */
export interface IngressEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly headers?: Record<string, string | undefined> | null;
  readonly requestContext?: { readonly path?: string; readonly stage?: string; readonly requestId?: string };
}

export interface IngressRecord {
  readonly message: 'agent-ingress-request';
  readonly requestId: string;
  readonly method: string;
  /** `<stage>/<backend>/invocations`, as API Gateway saw it. */
  readonly stagePath: string;
  readonly tenantRoute: string | null;
  /** The first 16 hex characters of SHA-256 over the whole `Authorization` value; null when absent. */
  readonly authorizationFingerprint: string | null;
}

/** The stand-in's fingerprint of a header value: short, one-way, enough to match a value the test holds. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function header(event: IngressEvent, name: string): string | undefined {
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === name && v !== undefined) return v;
  }
  return undefined;
}

export function recordOf(event: IngressEvent): IngressRecord {
  const authorization = header(event, 'authorization');
  const route = header(event, 'x-tenant-route');
  return {
    message: 'agent-ingress-request',
    requestId: event.requestContext?.requestId ?? '',
    method: event.httpMethod ?? '',
    stagePath: event.requestContext?.path ?? event.path ?? '',
    // A route id is a lower-case tenant id, never user data (spec §4.1).
    tenantRoute: route !== undefined && /^[a-z0-9-]{1,63}$/.test(route) ? route : route === undefined ? null : 'invalid',
    authorizationFingerprint: authorization === undefined ? null : fingerprint(authorization),
  };
}

/** The ten server-sent events the stand-in writes, 500 ms apart (spike S-5). */
export const STREAM_EVENTS = 10;
export const STREAM_GAP_MS = 500;

/** Writes the stream: each event is one `data:` line with its index and the time it was written. */
export async function writeStream(
  write: (chunk: string) => void,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  for (let i = 0; i < STREAM_EVENTS; i++) {
    if (i > 0) await sleep(STREAM_GAP_MS);
    write(`data: ${JSON.stringify({ i, at: now() })}\n\n`);
  }
}
