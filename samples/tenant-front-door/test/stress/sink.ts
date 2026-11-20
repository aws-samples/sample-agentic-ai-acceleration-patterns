// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { classify, EXPECT, meets, type RequestKind } from './classify';
import type { HttpResult } from './http';
import type { Recorder } from './recorder';
import type { RequestLine } from './state';

/** One request a scenario sends to the edge, and what to check in the answer. */
export interface Probe {
  readonly kind: RequestKind;
  /** The tenant the refusal is attributed to (P-7): the tenant the request names, or `-` when it names none. */
  readonly tenant: string;
  /** The tenant the edge log must show for this request (`-` for none); undefined where the router logs nothing. */
  readonly edgeTenant?: string;
  /** A served answer must name this tenant, and the route hint the router set must be its lower-case form. */
  readonly expect?: string;
}

/** The tenant a whoami answer names, and the route hint the router put on it. */
export function answerOf(body: string): { tenantId?: string; routeHint?: string } {
  try {
    const doc = JSON.parse(body) as Record<string, unknown>;
    return {
      tenantId: typeof doc.tenantId === 'string' ? doc.tenantId : undefined,
      routeHint: typeof doc.routeHint === 'string' ? doc.routeHint : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Turns every answer into counts, isolation assertions (P-1), attributed
 * refusals (P-7) and a request line. A request is an assertion when it is
 * served (the answer names the right tenant) and, for a probe that must be
 * refused, when it is answered at all (served is the mismatch). A refusal of
 * a legitimate request makes no assertion; it is counted under `refusals`.
 */
export class Sink {
  readonly lines: RequestLine[] = [];
  private readonly violations = new Map<string, number>();

  constructor(readonly rec: Recorder) {}

  take(p: Probe, r: HttpResult): void {
    const c = classify(p.kind, { status: r.status, headers: r.headers, body: r.body });
    this.rec.hop('client', r.total);
    this.rec.hop('client-ttfb', r.ttfb);
    this.rec.hop(`client-${p.kind}`, r.total);
    const mustRefuse = !EXPECT[p.kind].served;
    if (c.served) {
      this.rec.request(200);
      if (mustRefuse) {
        this.rec.assertion(false, `${p.kind} naming ${p.tenant} was served`);
      } else if (p.expect !== undefined) {
        const a = answerOf(r.body);
        const held = a.tenantId?.toUpperCase() === p.expect.toUpperCase() && a.routeHint === p.expect.toLowerCase();
        this.rec.assertion(held, `${p.kind} for ${p.expect} was answered for ${a.tenantId ?? '?'} with hint ${a.routeHint ?? '?'}`);
      }
    } else if (c.known && c.reason !== undefined) {
      this.rec.request(r.status, { tenant: p.tenant, reason: c.reason });
      if (mustRefuse && meets(p.kind, c)) this.rec.assertion(true);
    } else {
      this.rec.unattributedRefusal(r.status);
      this.violate(`${p.kind}: an answer no hop owns (status ${r.status}${r.error === undefined ? '' : `, ${r.error}`})`);
    }
    if (!meets(p.kind, c)) this.violate(`${p.kind}: answered ${r.status}${c.reason === undefined ? '' : `:${c.reason}`}`);
    this.lines.push({
      id: r.headers['x-amz-cf-id'] ?? '',
      kind: p.kind,
      tenant: p.tenant,
      status: r.status,
      reason: c.reason,
      seconds: r.total,
      edgeTenant: p.edgeTenant ?? '',
    });
  }

  violate(text: string): void {
    this.violations.set(text, (this.violations.get(text) ?? 0) + 1);
  }

  /** Writes every distinct violation, with its count, as a scenario problem. */
  flush(): void {
    for (const [text, n] of this.violations) this.rec.problem(`${text} (${n} times)`);
  }
}
