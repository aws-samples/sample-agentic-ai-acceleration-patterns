// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The agent chat renderer, loaded with `import()` on first use, so the
 * build emits it as a chunk the import map pins (ADR-0023). Agent output is
 * untrusted text: it reaches the DOM as text nodes only (§7.2).
 */

import type { FetchLike } from './http';
import { AgentError, invokeAgent, StreamEvent } from './stream';

function show(out: HTMLElement, e: StreamEvent): void {
  out.append(e.event === 'message' ? e.data : `[${e.event}] ${e.data}`, '\n');
}

export async function runAgent(fetchFn: FetchLike, accessToken: string, backend: string, prompt: string, out: HTMLElement): Promise<void> {
  out.textContent = '';
  try {
    await invokeAgent(fetchFn, accessToken, backend, prompt, (e) => show(out, e));
  } catch (e) {
    out.append(e instanceof AgentError ? `The agent answered ${e.status}.` : 'The agent call failed.', '\n');
  }
}
