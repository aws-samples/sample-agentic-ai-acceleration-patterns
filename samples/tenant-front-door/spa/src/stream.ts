// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The streamed agent call (spec §7.2): `fetch` and a `ReadableStream`, not
 * `EventSource`, so the bearer token goes in a header. The agent ingress
 * answers `text/event-stream` and ends with `event: usage`
 * (agentic-runtime-isolation README).
 */

import type { FetchLike } from './http';

export interface StreamEvent {
  /** `message` when the event names none. */
  readonly event: string;
  readonly data: string;
}

/** The router forwards only `/agents/<backend>/invocations` with this backend shape (§3.3 step 3). */
export const BACKEND_NAME = /^[a-z0-9-]{1,32}$/;

/** shortcut: a cap on one unfinished event, so a stream with no blank line cannot grow memory without bound; raise it for large events. */
export const MAX_EVENT_CHARS = 1 << 20;

export class AgentError extends Error {
  constructor(readonly status: number) {
    super(`agent answered ${status}`);
  }
}

/**
 * Parses a `text/event-stream` body (the WHATWG event stream format):
 * `data` lines joined with `\n`, `event` names the type, `:` lines are
 * comments, a blank line dispatches, and an event the stream ends inside
 * is dropped. UTF-8 split across chunks and CRLF split across chunks are
 * handled.
 */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event = '';
  let data: string[] = [];

  const line = (l: string): void => {
    if (l === '') {
      if (data.length > 0) onEvent({ event: event === '' ? 'message' : event, data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  const drain = (done: boolean): void => {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      if (m === null) break;
      // A CR at the end of a chunk may be the first half of a CRLF.
      if (m[0] === '\r' && m.index === buf.length - 1 && !done) break;
      line(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
    if (buf.length + data.reduce((n, d) => n + d.length, 0) > MAX_EVENT_CHARS) throw new Error('event stream: event too large');
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      drain(false);
    }
    buf += decoder.decode();
    drain(true);
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
}

/** `POST /agents/<backend>/invocations` with `{"prompt": ...}`, same-origin; events go to `onEvent` as they arrive. */
export async function invokeAgent(
  fetchFn: FetchLike,
  accessToken: string,
  backend: string,
  prompt: string,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  if (!BACKEND_NAME.test(backend)) throw new Error('invokeAgent: backend name');
  const res = await fetchFn(`/agents/${backend}/invocations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ prompt }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new AgentError(res.status);
  if (res.body === null) throw new Error('invokeAgent: no body');
  await readEventStream(res.body, onEvent);
}
