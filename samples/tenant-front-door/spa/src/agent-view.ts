// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The agent chat renderer, loaded with `import()` on first use, so the
 * build emits it as a chunk the import map pins (ADR-0023). Agent output is
 * untrusted text: it reaches the DOM as text nodes only (§7.2).
 */

import { withSignal } from './http';
import type { FetchLike } from './http';
import { AgentError, invokeAgent, StreamEvent } from './stream';

function show(out: HTMLElement, e: StreamEvent): void {
  out.append(e.event === 'message' ? e.data : `[${e.event}] ${e.data}`, '\n');
}

/** Streams one reply into `out`. Once `signal` aborts (the session ended, §7.2) the call stops and nothing more is written. */
export async function runAgent(
  fetchFn: FetchLike,
  signal: AbortSignal,
  accessToken: string,
  backend: string,
  prompt: string,
  out: HTMLElement,
): Promise<void> {
  if (signal.aborted) return;
  out.textContent = '';
  try {
    await invokeAgent(withSignal(fetchFn, signal), accessToken, backend, prompt, (e) => {
      if (!signal.aborted) show(out, e);
    });
  } catch (e) {
    if (!signal.aborted) out.append(e instanceof AgentError ? `The agent answered ${e.status}.` : 'The agent call failed.', '\n');
  }
}
