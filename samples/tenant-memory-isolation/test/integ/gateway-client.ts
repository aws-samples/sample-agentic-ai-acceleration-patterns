// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A minimal client for native Memory requests through the Gateway: the
 * caller's access token as a bearer, the Memory REST path under the target
 * name. It does no authorisation of its own; the Gateway and Policy decide.
 * Redirects are never followed with the token, and response bodies are
 * returned to the caller only, never logged (scripts/CONVENTIONS.md).
 */

export interface GatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

export class MemoryGateway {
  private readonly origin: string;

  constructor(
    gatewayUrl: string,
    private readonly targetName: string,
    private readonly memoryId: string,
  ) {
    const url = new URL(gatewayUrl);
    if (url.protocol !== 'https:') {
      throw new Error('The Gateway URL must be https');
    }
    this.origin = url.origin;
  }

  /** POST or GET one Memory path; `path` starts after `/memories/{memoryId}`. */
  async call(token: string, method: 'GET' | 'POST', path: string, body?: object, memoryId: string = this.memoryId): Promise<GatewayResponse> {
    const response = await fetch(`${this.origin}/${this.targetName}/memories/${encodeURIComponent(memoryId)}${path}`, {
      method,
      redirect: 'manual',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }

  createEvent(token: string, actorId: string, sessionId: string, text: string, extra: object = {}): Promise<GatewayResponse> {
    return this.call(token, 'POST', '/events', {
      actorId,
      sessionId,
      eventTimestamp: Math.floor(Date.now() / 1000),
      payload: [{ conversational: { role: 'USER', content: { text } } }],
      ...extra,
    });
  }

  retrieve(token: string, scope: { namespace?: string; namespacePath?: string }, query = 'warehouse codename', memoryId?: string): Promise<GatewayResponse> {
    return this.call(token, 'POST', '/retrieve', { ...scope, searchCriteria: { searchQuery: query, topK: 10 } }, memoryId);
  }

  listRecords(token: string, scope: { namespace?: string; namespacePath?: string }): Promise<GatewayResponse> {
    return this.call(token, 'POST', '/memoryRecords', { ...scope });
  }

  listEvents(token: string, actorId: string, sessionId: string): Promise<GatewayResponse> {
    return this.call(token, 'POST', `/actor/${encodeURIComponent(actorId)}/sessions/${encodeURIComponent(sessionId)}`, {});
  }

  listActors(token: string): Promise<GatewayResponse> {
    return this.call(token, 'POST', '/actors', {});
  }

  getRecord(token: string, recordId: string): Promise<GatewayResponse> {
    return this.call(token, 'GET', `/memoryRecord/${encodeURIComponent(recordId)}`);
  }
}

/** The decoded payload of a JWT, for checking the claim set (signature is the Gateway's job). */
export function claimsOf(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
