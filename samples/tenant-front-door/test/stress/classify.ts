// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Names every answer the front door can give a stress request (P-7): served,
 * or refused with a reason that says which hop refused and why. The router,
 * the demo cell and CloudFront each answer in a form of their own:
 *
 * - the router (a CloudFront Function) answers `{"status":<code>}`, spec §5.3;
 * - the demo cell answers `{"message":"forbidden" | "unauthorized" | ...}`;
 * - a Lambda function URL with IAM auth that gets an unsigned call answers
 *   `{"Message":"Forbidden"}` (capital M);
 * - CloudFront answers 494 for a request header it will not take, and HTML
 *   or its own 5xx otherwise.
 *
 * A status with no match is unknown (`known: false`): the scenario counts it
 * as an unattributed refusal, which fails the run.
 */

/** What a scenario sent, as far as the answer's meaning depends on it. */
export type RequestKind =
  | 'whoami'
  | 'route-watch'
  | 'large-token'
  | 'no-token'
  | 'bad-token'
  | 'unrouted'
  | 'suspended'
  | 'cross-site'
  | 'token-too-long'
  | 'agents-closed'
  | 'forged-payload'
  | 'client-route-header'
  | 'client-token-header'
  | 'tenants-list'
  | 'direct-origin'
  | 'ingress-forged-payload'
  | 'ingress-own-token';

/** The two direct calls to the runtime-isolation ingress (platform PS-7), whose answers come from API Gateway and its authoriser, not the router. */
export const INGRESS_KINDS: readonly RequestKind[] = ['ingress-forged-payload', 'ingress-own-token'];

export interface Observed {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The first bytes of the body. */
  readonly body: string;
}

export interface Classified {
  readonly served: boolean;
  /** Set for a refusal. */
  readonly reason?: string;
  /** False when the answer matches no form above. */
  readonly known: boolean;
}

function json(body: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(body);
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const CELL_REASONS: Readonly<Record<string, string>> = {
  'forbidden': 'cell-forbidden',
  'unauthorized': 'cell-unauthorized',
  'too many requests': 'cell-rate-limited',
  'unavailable': 'cell-unavailable',
  'not found': 'cell-not-found',
};

export function classify(kind: RequestKind, o: Observed): Classified {
  if (INGRESS_KINDS.includes(kind)) return classifyIngress(o);
  if (o.status === 200) return { served: true, known: true };
  if (o.status === 0) return { served: false, known: false };
  if (o.status === 494) return { served: false, reason: 'cloudfront-header-too-large', known: true };
  const doc = json(o.body);
  if (doc !== undefined && typeof doc.Message === 'string' && kind === 'direct-origin') {
    return { served: false, reason: 'origin-iam-denied', known: true };
  }
  if (doc !== undefined && typeof doc.message === 'string') {
    const reason = CELL_REASONS[doc.message];
    if (reason !== undefined) return { served: false, reason, known: true };
    return { served: false, known: false };
  }
  if (doc !== undefined && doc.status === o.status) return { served: false, reason: edgeReason(kind, o), known: true };
  return { served: false, known: false };
}

/**
 * A direct call to the ingress: any 2xx is served, 401 and 403 are its authoriser's refusals, 429 its rate limit, other 4xx a
 * refusal it makes for a request it does not accept, and anything else (a 5xx, no answer) no hop owns.
 */
function classifyIngress(o: Observed): Classified {
  if (o.status >= 200 && o.status < 300) return { served: true, known: true };
  const reason = ingressReason(o.status);
  return reason === undefined ? { served: false, known: false } : { served: false, reason, known: true };
}

function ingressReason(status: number): string | undefined {
  if (status === 401) return 'ingress-unauthorized';
  if (status === 403) return 'ingress-forbidden';
  if (status === 429) return 'ingress-rate-limited';
  return status >= 400 && status < 500 ? 'ingress-refused' : undefined;
}

function edgeReason(kind: RequestKind, o: Observed): string {
  switch (o.status) {
    case 401:
      if (kind === 'no-token') return 'edge-no-token';
      if (kind === 'bad-token') return 'edge-undecodable-token';
      if (kind === 'token-too-long') return 'edge-token-too-long';
      if (kind === 'tenants-list') return 'edge-tenants-list';
      return 'edge-unauthorized';
    case 403:
      return kind === 'cross-site' ? 'edge-cross-site' : 'edge-no-route';
    case 404:
      return kind === 'agents-closed' ? 'edge-agents-closed' : 'edge-not-found';
    case 503:
      return o.headers['retry-after'] === undefined ? 'edge-no-cell' : 'edge-suspended';
    default:
      return 'edge-refused';
  }
}

/**
 * What each kind may get back. `served` means a 200 is the right answer;
 * `reasons` lists the refusals that are right. A kind not served and not
 * refused with one of its reasons is a violation of the scenario.
 */
export interface Expectation {
  readonly served: boolean;
  readonly reasons: readonly string[];
}

export const EXPECT: Readonly<Record<RequestKind, Expectation>> = {
  // A legitimate request. The cell's per-tenant limit may refuse it at a high rate; that is a result, not a fault.
  'whoami': { served: true, reasons: ['cell-rate-limited'] },
  // A route just written: until it reaches the edge the router refuses the tenant as unknown.
  'route-watch': { served: true, reasons: ['edge-no-route', 'cell-rate-limited'] },
  // A token the cell cannot verify, whose payload the router decodes: the cell refuses it.
  'large-token': { served: false, reasons: ['cell-forbidden', 'cell-rate-limited'] },
  'no-token': { served: false, reasons: ['edge-no-token'] },
  'bad-token': { served: false, reasons: ['edge-undecodable-token'] },
  'unrouted': { served: false, reasons: ['edge-no-route'] },
  'suspended': { served: false, reasons: ['edge-suspended'] },
  'cross-site': { served: false, reasons: ['edge-cross-site'] },
  'token-too-long': { served: false, reasons: ['edge-token-too-long', 'cloudfront-header-too-large'] },
  'agents-closed': { served: false, reasons: ['edge-agents-closed'] },
  'forged-payload': { served: false, reasons: ['cell-forbidden'] },
  // The router drops the client's header and sets its own: the answer is the token's tenant.
  'client-route-header': { served: true, reasons: ['cell-rate-limited'] },
  'client-token-header': { served: true, reasons: ['cell-rate-limited'] },
  'tenants-list': { served: false, reasons: ['edge-tenants-list'] },
  'direct-origin': { served: false, reasons: ['origin-iam-denied'] },
  // The ingress is public by design (front-door spec §1.2) and checks the token itself: a token whose payload names another tenant is never served.
  'ingress-forged-payload': { served: false, reasons: ['ingress-unauthorized', 'ingress-forbidden'] },
  // A tenant's own token is served; the ingress's per-tenant limit may refuse it, which is a result, not a fault.
  'ingress-own-token': { served: true, reasons: ['ingress-rate-limited'] },
};

/** True when `c` is an answer the kind allows. */
export function meets(kind: RequestKind, c: Classified): boolean {
  const e = EXPECT[kind];
  if (c.served) return e.served;
  return c.reason !== undefined && e.reasons.includes(c.reason);
}
